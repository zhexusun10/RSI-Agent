#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	assertDockerDaemon,
	assertHostPrerequisites,
	buildImage,
	cleanupTempDir,
	createDockerVolumes,
	dockerRunArgs,
	hostPrerequisiteSnapshot,
	makePromptFixture,
	makeTempDir,
	redact,
	removeContainer,
	removeDockerVolumes,
	restartPhaseFile,
	rsiRoot,
	targetTestFile,
	verifyImageBubblewrap,
	runCommand,
	formatCommand,
} from "./linux-target-docker.mjs";
import { runProductionEntrypointSmoke } from "./linux-entrypoint-smoke.mjs";

function usage() {
	console.error(`Usage: node scripts/linux-validation.mjs [options]

Runs the real Linux/bwrap target acceptance suite and/or the real production
container-entrypoint smoke. The default Docker mode builds the image, starts a
bounded container with the deployment seccomp profile and no
privileged/docker.sock/host-root access, then executes the selected suites.

Options:
  --mode docker|host       Execution mode (default: docker)
  --suite target|entrypoint|all
                           Suites to run (default: target). "entrypoint" uses
                           the image's real ENTRYPOINT and production main.ts.
  --image NAME             Docker image tag (default: rsi-agent:linux-validation)
  --no-build               Use an existing image instead of building
  --timeout-ms N           Container test timeout (default: 1800000)
  --build-timeout-ms N     Docker build timeout (default: 1800000)
  --report FILE            Write a redacted JSON execution report
  --keep                   Keep the temporary volumes/artifacts for diagnosis
  --help                   Show this help

This script never invokes a real model/provider. The target suite uses the
repository test-mode faux provider; the production entrypoint smoke uses the
real Pi SDK with an operator-configured local mock HTTP/SSE provider and no real
key. A missing Linux/Docker/userns/bwrap prerequisite is a failure, not a skip.`);
}

function parseArgs(argv) {
	const options = {
		mode: process.env.RSI_TARGET_MODE ?? "docker",
		suite: process.env.RSI_TARGET_SUITE ?? "target",
		image: process.env.RSI_VALIDATION_IMAGE ?? "rsi-agent:linux-validation",
		build: true,
		timeoutMs: 1_800_000,
		buildTimeoutMs: 1_800_000,
		report: undefined,
		keep: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--mode") options.mode = argv[++index] ?? "";
		else if (arg === "--suite") options.suite = argv[++index] ?? "";
		else if (arg === "--image") options.image = argv[++index] ?? "";
		else if (arg === "--no-build") options.build = false;
		else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
		else if (arg === "--build-timeout-ms") options.buildTimeoutMs = Number(argv[++index]);
		else if (arg === "--report") options.report = resolve(argv[++index] ?? "");
		else if (arg === "--keep") options.keep = true;
		else if (arg === "--help" || arg === "-h") {
			usage();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!["docker", "host"].includes(options.mode)) {
		throw new Error(`--mode must be docker or host, got ${options.mode}`);
	}
	if (!["target", "entrypoint", "all"].includes(options.suite)) {
		throw new Error(`--suite must be target, entrypoint, or all, got ${options.suite}`);
	}
	if (options.mode === "host" && options.suite !== "target") {
		throw new Error("--suite entrypoint/all requires --mode docker; the production entrypoint smoke is a container test.");
	}
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 60_000) {
		throw new Error("--timeout-ms must be an integer >= 60000");
	}
	if (!Number.isSafeInteger(options.buildTimeoutMs) || options.buildTimeoutMs < 60_000) {
		throw new Error("--build-timeout-ms must be an integer >= 60000");
	}
	return options;
}

async function runHostMode(options, report) {
	const snapshot = await hostPrerequisiteSnapshot();
	assertHostPrerequisites(snapshot);
	report.host = snapshot;
	const artifacts = await makeTempDir();
	const prompt = await makePromptFixture();
	const dataRoot = await makeTempDir("rsi-target-data-");
	const stateRoot = await makeTempDir("rsi-target-state-");
	try {
		const result = await runCommand(
			process.execPath,
			["--test", "--test-concurrency=1", resolve(rsiRoot, "test/deployment/linux-target-acceptance.test.ts")],
			{
				cwd: rsiRoot,
				timeoutMs: options.timeoutMs,
				label: "host-target-test",
				env: {
					...process.env,
					RSI_TARGET_STRICT: "1",
					RSI_TARGET_DATA_ROOT: dataRoot,
					RSI_TARGET_STATE_ROOT: stateRoot,
					RSI_TARGET_PROMPT_FILE: prompt.file,
					RSI_TARGET_EXPECT_EMPTY: "1",
					RSI_TARGET_WORKER_UID: process.env.RSI_TARGET_WORKER_UID ?? "10002",
					RSI_TARGET_WORKER_GID: process.env.RSI_TARGET_WORKER_GID ?? "10002",
				},
			},
		);
		report.command = formatCommand(process.execPath, [
			"--test",
			"--test-concurrency=1",
			"test/deployment/linux-target-acceptance.test.ts",
		]);
		report.result = { status: result.status, signal: result.signal, timedOut: result.timedOut };
		report.artifacts = artifacts;
		return result.status ?? 1;
	} finally {
		if (!options.keep) {
			await cleanupTempDir(prompt.dir);
			await cleanupTempDir(dataRoot);
			await cleanupTempDir(stateRoot);
			await cleanupTempDir(artifacts);
		} else {
			console.error(`[target] kept host artifacts=${artifacts} data=${dataRoot} state=${stateRoot} prompt=${prompt.dir}`);
		}
	}
}

async function prepareDockerImage(options, report) {
	const snapshot = await hostPrerequisiteSnapshot();
	assertHostPrerequisites(snapshot);
	report.host = snapshot;
	report.dockerServer = await assertDockerDaemon();
	if (options.build) {
		report.build = await buildImage(options.image, options.buildTimeoutMs);
	}
	report.image = options.image;
	report.imageBubblewrap = await verifyImageBubblewrap(options.image, 120_000);
}

async function runTargetDockerSuite(options, report) {
	const volumes = await createDockerVolumes("rsi-validation");
	const prompt = await makePromptFixture();
	const artifacts = await makeTempDir();
	const containerName = `rsi-validation-${volumes.unique}`;
	const env = {
		RSI_TARGET_STRICT: "1",
		RSI_TARGET_DATA_ROOT: "/data",
		RSI_TARGET_STATE_ROOT: "/state",
		RSI_TARGET_PROMPT_FILE: "/run/rsi-target/prompt.txt",
		RSI_TARGET_EXPECT_EMPTY: "1",
		RSI_TARGET_WORKER_UID: process.env.RSI_TARGET_WORKER_UID ?? "10002",
		RSI_TARGET_WORKER_GID: process.env.RSI_TARGET_WORKER_GID ?? "10002",
		RSI_TEST_BWRAP: "/usr/bin/bwrap",
	};
	const restartContainers = [];
	const args = dockerRunArgs({
		image: options.image,
		containerName,
		dataVolume: volumes.data,
		stateVolume: volumes.state,
		promptFile: prompt.file,
		artifactsDir: artifacts,
		env,
		command: "--test",
		args: ["--test-concurrency=1", targetTestFile],
	});
	report.target = {
		command: formatCommand("docker", args),
		volumes: { data: volumes.data, state: volumes.state },
		restartPhases: {},
	};
	try {
		const result = await runCommand("docker", args, {
			timeoutMs: options.timeoutMs,
			label: "docker-target-test",
		});
		report.target.result = { status: result.status, signal: result.signal, timedOut: result.timedOut };
		report.target.artifacts = artifacts;
		if (result.timedOut) {
			await removeContainer(containerName);
			throw new Error(`Target validation exceeded ${options.timeoutMs} ms and was killed.`);
		}
		if (result.status !== 0) return result.status ?? 1;

		// A real container restart uses the same /data and /state volumes. The
		// first container prepares read statistics and a pending notice, exits,
		// then a second container verifies both survived.
		const restartId = `${Date.now().toString(36)}-${process.pid}`;
		for (const phase of ["prepare", "verify"]) {
			const phaseName = `${containerName}-restart-${phase}`;
			restartContainers.push(phaseName);
			const phaseEnv = { ...env, RSI_TARGET_RESTART_ID: restartId };
			const phaseArgs = dockerRunArgs({
				image: options.image,
				containerName: phaseName,
				dataVolume: volumes.data,
				stateVolume: volumes.state,
				promptFile: prompt.file,
				artifactsDir: artifacts,
				env: phaseEnv,
				command: restartPhaseFile,
				args: [phase],
			});
			report.target.restartPhases[phase] = formatCommand("docker", phaseArgs);
			const phaseResult = await runCommand("docker", phaseArgs, {
				timeoutMs: 180_000,
				label: `docker-restart-${phase}`,
			});
			report.target.restartPhases[`${phase}Result`] = {
				status: phaseResult.status,
				signal: phaseResult.signal,
				timedOut: phaseResult.timedOut,
			};
			if (phaseResult.status !== 0) return phaseResult.status ?? 1;
		}
		return 0;
	} finally {
		if (options.keep) {
			console.error(
				`[target] kept volumes=${volumes.data},${volumes.state} artifacts=${artifacts} prompt=${prompt.dir}`,
			);
		} else {
			await removeContainer(containerName);
			for (const phaseContainer of restartContainers) await removeContainer(phaseContainer);
			await removeDockerVolumes([volumes.data, volumes.state]);
			await cleanupTempDir(prompt.dir);
			await cleanupTempDir(artifacts);
		}
	}
}

async function runDockerMode(options, report) {
	await prepareDockerImage(options, report);
	if (options.suite === "target" || options.suite === "all") {
		const targetCode = await runTargetDockerSuite(options, report);
		if (targetCode !== 0) return targetCode;
	}
	if (options.suite === "entrypoint" || options.suite === "all") {
		report.productionEntrypoint = {};
		const result = await runProductionEntrypointSmoke({
			image: options.image,
			driverTimeoutMs: Math.min(options.timeoutMs, 600_000),
			keep: options.keep,
			report: report.productionEntrypoint,
		});
		if (!result.ok) {
			console.error(`[target] production entrypoint smoke failed: ${result.error ?? "unknown failure"}`);
			return result.exitCode ?? 1;
		}
	}
	return 0;
}

const options = parseArgs(process.argv.slice(2));
const report = {
	version: 2,
	startedAt: new Date().toISOString(),
	mode: options.mode,
	suite: options.suite,
	note:
		"Target acceptance and the production entrypoint smoke are bounded. A 24-hour soak is a separate explicit command and is never claimed from this run. The soak currently uses the target harness, not the production entrypoint.",
};
try {
	const code = options.mode === "host" ? await runHostMode(options, report) : await runDockerMode(options, report);
	report.finishedAt = new Date().toISOString();
	report.exitCode = code;
	if (options.report) await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`[target] result ${JSON.stringify({ mode: options.mode, suite: options.suite, exitCode: code })}`);
	process.exitCode = code;
} catch (error) {
	report.finishedAt = new Date().toISOString();
	report.error = redact(error instanceof Error ? error.message : String(error));
	report.errorStack = redact(error instanceof Error ? error.stack ?? error.message : String(error));
	console.error(`[target] FAILED: ${report.error}`);
	if (options.report) await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
	process.exitCode = 1;
}
