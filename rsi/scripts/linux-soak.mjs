#!/usr/bin/env node
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	assertDockerDaemon,
	assertHostPrerequisites,
	buildImage,
	cleanupTempDir,
	createDockerVolumes,
	dockerRunArgs,
	formatCommand,
	hostPrerequisiteSnapshot,
	makePromptFixture,
	makeTempDir,
	removeContainer,
	removeDockerVolumes,
	runCommand,
	soakRunnerFile,
	verifyImageBubblewrap,
} from "./linux-target-docker.mjs";

function usage() {
	console.error(`Usage: node scripts/linux-soak.mjs [options]

Explicit optional Linux/Docker soak. This is never started by the push CI.
The default duration is 24 hours and must be run on the real target machine.

Options:
  --hours N                Soak duration in hours (default: 24)
  --sample-ms N            Sample interval (default: 30000)
  --image NAME             Docker image tag (default: rsi-agent:soak)
  --no-build               Use an existing image instead of building
  --report FILE            Copy the in-container JSON report to this path
  --keep                   Keep the temporary volumes/artifacts for diagnosis
  --help                   Show this help

The soak uses the repository faux provider, samples health/resources/logs/
process/recovery, and never calls a real external provider. It starts the target
harness with --entrypoint node and does NOT exercise container-entrypoint.sh.`);
}

function parseArgs(argv) {
	const options = {
		hours: Number(process.env.RSI_SOAK_HOURS ?? "24"),
		sampleMs: Number(process.env.RSI_SOAK_SAMPLE_MS ?? "30000"),
		image: process.env.RSI_SOAK_IMAGE ?? "rsi-agent:soak",
		build: true,
		report: undefined,
		keep: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--hours") options.hours = Number(argv[++index]);
		else if (arg === "--sample-ms") options.sampleMs = Number(argv[++index]);
		else if (arg === "--image") options.image = argv[++index] ?? "";
		else if (arg === "--no-build") options.build = false;
		else if (arg === "--report") options.report = argv[++index];
		else if (arg === "--keep") options.keep = true;
		else if (arg === "--help" || arg === "-h") {
			usage();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!Number.isFinite(options.hours) || options.hours <= 0) throw new Error("--hours must be a positive number");
	if (!Number.isSafeInteger(options.sampleMs) || options.sampleMs < 1_000) {
		throw new Error("--sample-ms must be an integer >= 1000");
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));
const durationMs = Math.round(options.hours * 3_600_000);
const timeoutMs = durationMs + 15 * 60_000;
const report = {
	version: 1,
	startedAt: new Date().toISOString(),
	kind: "linux-target-harness-soak",
	hours: options.hours,
	sampleMs: options.sampleMs,
	entrypoint: "docker --entrypoint node (target harness)",
	productionEntrypoint: false,
	note:
		"This soak starts linux-soak-runner.ts with docker --entrypoint node. It bypasses container-entrypoint.sh and must not be reported as a production container-entrypoint soak. A soak result applies only to the actual target run; it is not inferred from CI or static checks.",
};
let volumes;
let prompt;
let artifacts;
const containerName = `rsi-soak-${process.pid}-${Date.now().toString(36)}`;
try {
	const host = await hostPrerequisiteSnapshot();
	assertHostPrerequisites(host);
	report.host = host;
	report.dockerServer = await assertDockerDaemon();
	if (options.build) report.build = await buildImage(options.image, 1_800_000);
	report.imageBubblewrap = await verifyImageBubblewrap(options.image, 120_000);
	volumes = await createDockerVolumes("rsi-soak");
	prompt = await makePromptFixture();
	artifacts = await makeTempDir("rsi-soak-artifacts-");
	const args = dockerRunArgs({
		image: options.image,
		containerName,
		dataVolume: volumes.data,
		stateVolume: volumes.state,
		promptFile: prompt.file,
		artifactsDir: artifacts,
		env: {
			RSI_TARGET_STRICT: "1",
			RSI_TARGET_DATA_ROOT: "/data",
			RSI_TARGET_STATE_ROOT: "/state",
			RSI_TARGET_PROMPT_FILE: "/run/rsi-target/prompt.txt",
			RSI_TARGET_EXPECT_EMPTY: "1",
			RSI_TARGET_WORKER_UID: process.env.RSI_TARGET_WORKER_UID ?? "10002",
			RSI_TARGET_WORKER_GID: process.env.RSI_TARGET_WORKER_GID ?? "10002",
			RSI_TEST_BWRAP: "/usr/bin/bwrap",
			RSI_SOAK_HOURS: String(options.hours),
			RSI_SOAK_SAMPLE_MS: String(options.sampleMs),
			RSI_SOAK_REPORT: "/run/rsi-artifacts/linux-soak-report.json",
		},
		command: soakRunnerFile,
		args: ["--hours", String(options.hours), "--sample-ms", String(options.sampleMs)],
	});
	report.command = formatCommand("docker", args);
	report.volumes = { data: volumes.data, state: volumes.state };
	const result = await runCommand("docker", args, { timeoutMs, label: "docker-soak" });
	report.result = { status: result.status, signal: result.signal, timedOut: result.timedOut };
	const inContainerReport = join(artifacts, "linux-soak-report.json");
	try {
		const parsed = JSON.parse(await readFile(inContainerReport, "utf8"));
		report.soak = parsed;
		if (options.report) await copyFile(inContainerReport, options.report);
	} catch (error) {
		report.soakReportError = error instanceof Error ? error.message : String(error);
	}
	if (result.timedOut) {
		await removeContainer(containerName);
		throw new Error(`Soak exceeded ${timeoutMs} ms and was killed.`);
	}
	if (result.status !== 0) {
		throw new Error(`Soak container exited with ${String(result.status)}.`);
	}
	console.log(
		`[soak] completed ${options.hours}h target-harness run (production entrypoint NOT exercised)${options.report ? `; report=${options.report}` : ""}`,
	);
	process.exitCode = 0;
} catch (error) {
	report.error = error instanceof Error ? error.message : String(error);
	console.error(`[soak] FAILED: ${report.error}`);
	process.exitCode = 1;
} finally {
	report.finishedAt = new Date().toISOString();
	if (options.report) {
		await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
	}
	if (options.keep) {
		console.error(
			`[soak] kept volumes=${volumes ? `${volumes.data},${volumes.state}` : "none"} artifacts=${artifacts ?? "none"} prompt=${prompt?.dir ?? "none"}`,
		);
	} else {
		await removeContainer(containerName);
		if (volumes) await removeDockerVolumes([volumes.data, volumes.state]);
		if (prompt) await cleanupTempDir(prompt.dir);
		if (artifacts) await cleanupTempDir(artifacts);
	}
}
