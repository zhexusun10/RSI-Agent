#!/usr/bin/env node
import { chmod, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	cleanupTempDir,
	createDockerVolumes,
	formatCommand,
	makePromptFixture,
	makeTempDir,
	removeContainer,
	removeDockerVolumes,
	rsiRoot,
	runCommand,
	seccompPath,
	testMountPath,
} from "./linux-target-docker.mjs";

export const productionEntrypointFixtureDir = "/run/rsi-entrypoint-fixture";
export const productionEntrypointCaptureDir = "/run/rsi-entrypoint-capture";
export const productionEntrypointEvidenceDir = "/run/rsi-entrypoint-evidence";
export const productionEntrypointPromptTarget = "/run/config/system-prompt.txt";
export const productionEntrypointDriverFile = "/opt/rsi/test/deployment/production-entrypoint-smoke.ts";
export const productionEntrypointMockFile = "/opt/rsi/test/deployment/production-entrypoint-mock-provider.mjs";
export const productionEntrypointModelsFile = join(
	rsiRoot,
	"test",
	"deployment",
	"fixtures",
	"production-entrypoint",
	"models.json",
);
export const productionEntrypointAuthFile = join(
	rsiRoot,
	"test",
	"deployment",
	"fixtures",
	"production-entrypoint",
	"auth.json",
);

const MOCK_ALIAS = "rsi-mock-provider";
const MOCK_PORT = 18_080;
const DEFAULT_DRIVER_TIMEOUT_MS = 600_000;
const WORKER_UID = process.env.RSI_TARGET_WORKER_UID ?? "10002";
const WORKER_GID = process.env.RSI_TARGET_WORKER_GID ?? "10002";
const UNIFIED_PREFLIGHT_SUCCESS = "[rsi-preflight] full sandbox preflight passed";

function probeCommand() {
	return [
		"set +e",
		'echo "UID:$(id -u)"',
		'echo "GID:$(id -g)"',
		'echo "GROUPS:$(id -G | tr \' \' \',\')"',
		'printf "CAP:%s\\n" "$(grep \'^CapEff:\' /proc/self/status | tr -d \'[:space:]\')"',
		"attempt_write() {",
		'  label="$1"',
		'  file="$2"',
		'  if printf HACK >> "$file" 2>/dev/null; then echo "WRITE_OK:$label"; else echo "WRITE_FAIL:$label"; fi',
		"}",
		"attempt_read() {",
		'  label="$1"',
		'  file="$2"',
		'  if test -r "$file"; then echo "READ_OK:$label"; else echo "READ_FAIL:$label"; fi',
		"}",
		'attempt_write settings /data/pi-agent/settings.json',
		'attempt_write models /data/pi-agent/models.json',
		'attempt_write auth /data/pi-agent/auth.json',
		'attempt_write prompt /run/config/system-prompt.txt',
		'attempt_write memory-direct /data/markdowns/Memory.md',
		'attempt_read settings /data/pi-agent/settings.json',
		'attempt_read models /data/pi-agent/models.json',
		'attempt_read auth /data/pi-agent/auth.json',
		'attempt_read plugins /data/pi-agent/npm/node_modules/pi-continuity/package.json',
		'attempt_read plugins /data/pi-agent/npm/node_modules/pi-better-web-search/package.json',
		'attempt_read memory /data/markdowns/Memory.md',
		"if printf 'PRODUCTION-ENTRYPOINT-WORKSPACE\\n' > /data/workspace/production-entrypoint-probe.txt 2>/dev/null; then echo WRITE_OK:workspace; else echo WRITE_FAIL:workspace; fi",
		"if test -r /data/markdowns/architecture.md && test -r /data/markdowns/operations.md && test -r /data/markdowns/security.md; then echo READ_OK:seed; else echo READ_FAIL:seed; fi",
		'echo "NSPID:$(grep \'^NSpid:\' /proc/self/status | tr -d \'[:space:]\')"',
		"echo PROBE_COMPLETE",
	].join("\n");
}

function targetRunArgs({ image, containerName, network, dataVolume, stateVolume, promptFile, captureDir, evidenceDir }) {
	return [
		"run",
		"-d",
		"--name",
		containerName,
		"--label",
		"rsi.validation=true",
		"--init",
		"--pids-limit",
		"512",
		"--stop-timeout",
		"30",
		"--cap-drop",
		"ALL",
		"--cap-add",
		"SETUID",
		"--cap-add",
		"SETGID",
		"--cap-add",
		"CHOWN",
		"--security-opt",
		`seccomp=${seccompPath}`,
		"--network",
		network,
		"--tmpfs",
		"/tmp:rw,size=256m,mode=1777",
		"--health-interval",
		"5s",
		"--health-timeout",
		"10s",
		"--health-start-period",
		"30s",
		"--health-retries",
		"6",
		"--mount",
		`type=volume,source=${dataVolume},target=/data,volume-nocopy`,
		"--mount",
		`type=volume,source=${stateVolume},target=/state,volume-nocopy`,
		"--mount",
		`type=bind,source=${resolve(promptFile)},target=${productionEntrypointPromptTarget},readonly`,
		"--mount",
		`type=bind,source=${testMountPath},target=/opt/rsi/test,readonly`,
		"--mount",
		`type=bind,source=${resolve(captureDir)},target=${productionEntrypointCaptureDir},readonly`,
		"--mount",
		`type=bind,source=${resolve(evidenceDir)},target=${productionEntrypointEvidenceDir}`,
		"--env",
		"TZ=UTC",
		"--env",
		"RSI_TIME_ZONE=UTC",
		"--env",
		`RSI_WORKER_UID=${WORKER_UID}`,
		"--env",
		`RSI_WORKER_GID=${WORKER_GID}`,
		"--env",
		"RSI_SUPERVISOR_ENTRY=/opt/rsi/src/main.ts",
		image,
	];
}

function mockRunArgs({ image, containerName, network, fixtureDir, captureDir }) {
	return [
		"run",
		"-d",
		"--name",
		containerName,
		"--label",
		"rsi.validation=true",
		"--init",
		"--pids-limit",
		"128",
		"--stop-timeout",
		"10",
		"--cap-drop",
		"ALL",
		"--read-only",
		"--no-healthcheck",
		"--tmpfs",
		"/tmp:rw,size=16m,mode=1777",
		"--network",
		network,
		"--network-alias",
		MOCK_ALIAS,
		"--mount",
		`type=bind,source=${testMountPath},target=/opt/rsi/test,readonly`,
		"--mount",
		`type=bind,source=${resolve(fixtureDir)},target=${productionEntrypointFixtureDir},readonly`,
		"--mount",
		`type=bind,source=${resolve(captureDir)},target=${productionEntrypointCaptureDir}`,
		"--entrypoint",
		"node",
		image,
		productionEntrypointMockFile,
		"--port",
		String(MOCK_PORT),
		"--fixture-dir",
		productionEntrypointFixtureDir,
		"--capture-dir",
		productionEntrypointCaptureDir,
	];
}

function prepareRunArgs({ image, containerName, fixtureDir, dataVolume, stateVolume }) {
	return [
		"run",
		"--rm",
		"--name",
		containerName,
		"--label",
		"rsi.validation=true",
		"--init",
		"--network",
		"none",
		"--cap-drop",
		"ALL",
		"--cap-add",
		"CHOWN",
		"--read-only",
		"--no-healthcheck",
		"--tmpfs",
		"/tmp:rw,size=16m,mode=1777",
		"--mount",
		`type=volume,source=${dataVolume},target=/data,volume-nocopy`,
		"--mount",
		`type=volume,source=${stateVolume},target=/state,volume-nocopy`,
		"--mount",
		`type=bind,source=${testMountPath},target=/opt/rsi/test,readonly`,
		"--mount",
		`type=bind,source=${resolve(fixtureDir)},target=${productionEntrypointFixtureDir},readonly`,
		"--entrypoint",
		"node",
		image,
		productionEntrypointDriverFile,
		"prepare",
	];
}

async function readJsonFile(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function waitForLocalFile(path, label, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return JSON.parse(await readFile(path, "utf8"));
		} catch {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
		}
	}
	throw new Error(`Timed out waiting for ${label}: ${path}`);
}

async function waitForContainerHealthy(containerName, timeoutMs = 240_000) {
	const deadline = Date.now() + timeoutMs;
	let last = "unknown";
	while (Date.now() < deadline) {
		const result = await runCommand(
			"docker",
			["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", containerName],
			{ stream: false, timeoutMs: 30_000 },
		);
		last = `${result.stdout}\n${result.stderr}`.trim();
		if (result.status === 0 && last === "healthy") return last;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
	}
	throw new Error(`Container ${containerName} did not become Docker-healthy; last state: ${last}`);
}

async function collectLogs(containerName) {
	const logs = await runCommand("docker", ["logs", "--tail", "400", containerName], {
		stream: false,
		timeoutMs: 30_000,
	}).catch((error) => ({ stdout: "", stderr: String(error) }));
	return `${logs.stdout}\n${logs.stderr}`.trim();
}

function requireUnifiedPreflightLog(logs, phase) {
	const line = logs
		.split("\n")
		.find((candidate) => candidate.includes(UNIFIED_PREFLIGHT_SUCCESS));
	if (line === undefined) {
		throw new Error(
			`${phase} entrypoint logs do not include the unified preflight success line ` +
				`${JSON.stringify(UNIFIED_PREFLIGHT_SUCCESS)}.\n${logs}`,
		);
	}
	for (const required of [
		`host_uid=${WORKER_UID}`,
		`host_gid=${WORKER_GID}`,
		`namespace_uid=${WORKER_UID}`,
		`namespace_gid=${WORKER_GID}`,
		"CapEff=0",
		"supplementary_groups=cleared",
		"namespace=verified",
		"mount=verified",
		"protected_hardlinks=true",
		"protected_symlinks=true",
	]) {
		if (!line.includes(required)) {
			throw new Error(
				`${phase} entrypoint preflight line is missing ${JSON.stringify(required)}; ` +
					`the CLI/deployment/launcher preflight contract must stay identical.\n${line}`,
			);
		}
	}
	return line;
}

async function stopAndInspect({ containerName, phase, report }) {
	const stop = await runCommand("docker", ["stop", "--time", "30", containerName], {
		timeoutMs: 60_000,
		label: `stop-${phase}`,
	});
	const stateResult = await runCommand(
		"docker",
		["inspect", "--format", "{{json .State}}", containerName],
		{ stream: false, timeoutMs: 30_000 },
	);
	let state;
	try {
		state = JSON.parse(stateResult.stdout);
	} catch {
		throw new Error(`Could not inspect ${containerName} state after docker stop: ${stateResult.stdout}${stateResult.stderr}`);
	}
	const logs = await collectLogs(containerName);
	report.phases[phase] = {
		...(report.phases[phase] ?? {}),
		stopCommand: formatCommand("docker", ["stop", "--time", "30", containerName]),
		stopStatus: stop.status,
		state,
		logTail: logs,
	};
	if (stop.status !== 0) throw new Error(`docker stop ${containerName} exited ${String(stop.status)}`);
	if (state.Running !== false || state.Pid !== 0) {
		throw new Error(`Container ${containerName} is still running after docker stop (pid=${String(state.Pid)}).`);
	}
	if (state.ExitCode !== 0) {
		throw new Error(`Container ${containerName} exited with ${String(state.ExitCode)} instead of a clean SIGTERM shutdown.`);
	}
	if (state.OOMKilled === true) throw new Error(`Container ${containerName} was OOM-killed.`);
	if (/did not exit within|sending SIGKILL/i.test(logs)) {
		throw new Error(`Container ${containerName} required a forced process-tree SIGKILL instead of a clean shutdown.`);
	}
	return { state, logs };
}

async function execDriver({ containerName, phase, marker, extraEnv = {}, timeoutMs }) {
	const args = [
		"exec",
		"--env",
		`RSI_WORKER_GID=${WORKER_GID}`,
		"--env",
		`RSI_WORKER_UID=${WORKER_UID}`,
		"--env",
		`RSI_ENTRYPOINT_DATA_ROOT=/data`,
		"--env",
		`RSI_ENTRYPOINT_STATE_ROOT=/state`,
		"--env",
		`RSI_ENTRYPOINT_FIXTURE_DIR=${productionEntrypointFixtureDir}`,
		"--env",
		`RSI_ENTRYPOINT_CAPTURE_DIR=${productionEntrypointCaptureDir}`,
	];
	for (const [name, value] of Object.entries(extraEnv)) args.push("--env", `${name}=${value}`);
	args.push(
		containerName,
		"node",
		productionEntrypointDriverFile,
		phase,
		"--marker",
		marker,
		"--evidence-file",
		phase === "first"
			? `${productionEntrypointEvidenceDir}/first.json`
			: `${productionEntrypointEvidenceDir}/restart.json`,
	);
	const result = await runCommand("docker", args, {
		timeoutMs,
		label: `entrypoint-driver-${phase}`,
	});
	if (result.timedOut) throw new Error(`Entrypoint driver ${phase} timed out after ${timeoutMs} ms.`);
	if (result.status !== 0) {
		throw new Error(
			`Entrypoint driver ${phase} exited ${String(result.status)}.\n` +
				`${result.stdout}\n${result.stderr}`.trim(),
		);
	}
	return result;
}

export async function runProductionEntrypointSmoke(options) {
	const image = options.image;
	if (typeof image !== "string" || image.length === 0) throw new Error("Production entrypoint smoke requires an image.");
	const timeoutMs = options.driverTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS;
	const report = options.report ?? {};
	report.ok = false;
	report.exitCode = 1;
	report.phases = {};
	report.containers = {};
	report.commands = [];
	const unique = `${process.pid}-${Date.now().toString(36)}`;
	const network = `rsi-entrypoint-net-${unique}`;
	const marker = `PRODUCTION-ENTRYPOINT-${Date.now().toString(36)}-${process.pid}`;
	const names = {
		mock: `rsi-entrypoint-mock-${unique}`,
		prepare: `rsi-entrypoint-prepare-${unique}`,
		first: `rsi-entrypoint-first-${unique}`,
		restart: `rsi-entrypoint-restart-${unique}`,
	};
	report.containers = { ...names };
	let volumes;
	let fixtureDir;
	let captureDir;
	let evidenceDir;
	let prompt;
	let networkCreated = false;
	const startedContainers = [];
	try {
		fixtureDir = await makeTempDir("rsi-entrypoint-fixture-");
		captureDir = await makeTempDir("rsi-entrypoint-capture-");
		evidenceDir = await makeTempDir("rsi-entrypoint-evidence-");
		prompt = await makePromptFixture();
		await mkdir(fixtureDir, { recursive: true });
		// The helper/target containers run with cap-drop ALL, so they cannot rely
		// on CAP_DAC_OVERRIDE to cross a host temp directory that is mode 0700.
		await chmod(fixtureDir, 0o755);
		await chmod(captureDir, 0o777);
		await chmod(evidenceDir, 0o777);
		await chmod(prompt.dir, 0o755);
		const scenario = {
			version: 1,
			memoryMarker: marker,
			sleepDuration: "10m",
			probeCommand: probeCommand(),
		};
		await writeFile(join(fixtureDir, "scenario.json"), `${JSON.stringify(scenario, null, 2)}\n`, { mode: 0o644 });
		for (const [source, name] of [
			[productionEntrypointModelsFile, "models.json"],
			[productionEntrypointAuthFile, "auth.json"],
		]) {
			await writeFile(join(fixtureDir, name), await readFile(source, "utf8"), { mode: 0o644 });
		}
		volumes = await createDockerVolumes("rsi-entrypoint");
		report.volumes = { data: volumes.data, state: volumes.state };
		report.network = network;
		report.promptFixture = prompt.file;
		report.marker = marker;

		const createNetwork = await runCommand(
			"docker",
			["network", "create", "--label", "rsi.validation=true", "--label", `rsi.validation.run=${unique}`, network],
			{ timeoutMs: 30_000, label: "network-create" },
		);
		report.commands.push(
			formatCommand("docker", [
				"network",
				"create",
				"--label",
				"rsi.validation=true",
				"--label",
				`rsi.validation.run=${unique}`,
				network,
			]),
		);
		if (createNetwork.status !== 0) throw new Error(`Could not create dedicated network: ${createNetwork.stderr}`);
		networkCreated = true;

		const mockArgs = mockRunArgs({ image, containerName: names.mock, network, fixtureDir, captureDir });
		report.commands.push(formatCommand("docker", mockArgs));
		const mockStart = await runCommand("docker", mockArgs, { timeoutMs: 60_000, label: "mock-provider-start" });
		if (mockStart.status !== 0) throw new Error(`Mock provider container failed to start: ${mockStart.stderr}`);
		startedContainers.push(names.mock);
		const ready = await waitForLocalFile(join(captureDir, "mock-ready.json"), "mock provider readiness", 60_000);
		report.mockProvider = ready;

		const prepareArgs = prepareRunArgs({
			image,
			containerName: names.prepare,
			fixtureDir,
			dataVolume: volumes.data,
			stateVolume: volumes.state,
		});
		report.commands.push(formatCommand("docker", prepareArgs));
		const prepare = await runCommand("docker", prepareArgs, { timeoutMs: 120_000, label: "fixture-prepare" });
		if (prepare.status !== 0) {
			throw new Error(`Fixture preparation exited ${String(prepare.status)}.\n${prepare.stdout}\n${prepare.stderr}`);
		}

		const firstArgs = targetRunArgs({
			image,
			containerName: names.first,
			network,
			dataVolume: volumes.data,
			stateVolume: volumes.state,
			promptFile: prompt.file,
			captureDir,
			evidenceDir,
		});
		report.commands.push(formatCommand("docker", firstArgs));
		const firstStart = await runCommand("docker", firstArgs, { timeoutMs: 60_000, label: "entrypoint-first-start" });
		if (firstStart.status !== 0) throw new Error(`First production entrypoint container failed to start: ${firstStart.stderr}`);
		startedContainers.push(names.first);
		await execDriver({ containerName: names.first, phase: "first", marker, timeoutMs });
		const firstEvidence = await readJsonFile(join(evidenceDir, "first.json"));
		report.first = firstEvidence;
		report.phases.first = { ...report.phases.first, evidence: firstEvidence };
		const firstHealth = await waitForContainerHealthy(names.first);
		report.phases.first.dockerHealth = firstHealth;
		const firstLogs = await collectLogs(names.first);
		report.phases.first.entrypointLog = firstLogs;
		for (const required of [
			"[rsi-entrypoint]",
			"[rsi-seed-markdowns] seeded",
			"[rsi-entrypoint] starting Supervisor entry",
		]) {
			if (!firstLogs.includes(required)) {
				throw new Error(`First entrypoint logs do not include ${JSON.stringify(required)}.\n${firstLogs}`);
			}
		}
		report.phases.first.preflightLog = requireUnifiedPreflightLog(firstLogs, "first");
		await stopAndInspect({ containerName: names.first, phase: "first", report });
		await removeContainer(names.first);

		const restartArgs = targetRunArgs({
			image,
			containerName: names.restart,
			network,
			dataVolume: volumes.data,
			stateVolume: volumes.state,
			promptFile: prompt.file,
			captureDir,
			evidenceDir,
		});
		report.commands.push(formatCommand("docker", restartArgs));
		const restartStart = await runCommand("docker", restartArgs, { timeoutMs: 60_000, label: "entrypoint-restart-start" });
		if (restartStart.status !== 0) throw new Error(`Restarted production entrypoint container failed to start: ${restartStart.stderr}`);
		startedContainers.push(names.restart);
		await execDriver({
			containerName: names.restart,
			phase: "restart",
			marker,
			extraEnv: { RSI_ENTRYPOINT_FIRST_EVIDENCE: `${productionEntrypointEvidenceDir}/first.json` },
			timeoutMs,
		});
		const restartEvidence = await readJsonFile(join(evidenceDir, "restart.json"));
		report.restart = restartEvidence;
		report.phases.restart = { ...report.phases.restart, evidence: restartEvidence };
		const restartHealth = await waitForContainerHealthy(names.restart);
		report.phases.restart.dockerHealth = restartHealth;
		const restartLogs = await collectLogs(names.restart);
		report.phases.restart.entrypointLog = restartLogs;
		if (!restartLogs.includes("[rsi-entrypoint] starting Supervisor entry")) {
			throw new Error(`Restart entrypoint logs do not show the production Supervisor handoff.\n${restartLogs}`);
		}
		report.phases.restart.preflightLog = requireUnifiedPreflightLog(restartLogs, "restart");
		await stopAndInspect({ containerName: names.restart, phase: "restart", report });
		await removeContainer(names.restart);

		report.ok = true;
		report.exitCode = 0;
		return report;
	} catch (error) {
		report.error = error instanceof Error ? error.message : String(error);
		report.errorStack = error instanceof Error ? error.stack : undefined;
		for (const containerName of startedContainers) {
			const logs = await collectLogs(containerName).catch(() => "");
			if (logs.length > 0) {
				const phase = containerName === names.first ? "first" : containerName === names.restart ? "restart" : "mock";
				report.phases[phase] = { ...(report.phases[phase] ?? {}), failureLog: logs };
			}
		}
		return report;
	} finally {
		for (const containerName of [names.first, names.restart, names.prepare, names.mock]) {
			await removeContainer(containerName);
		}
		if (networkCreated) {
			await runCommand("docker", ["network", "rm", network], {
				timeoutMs: 30_000,
				stream: false,
			}).catch(() => undefined);
		}
		if (volumes) {
			if (options.keep) {
				console.error(`[entrypoint-smoke] kept volumes=${volumes.data},${volumes.state} evidence=${evidenceDir}`);
			} else {
				await removeDockerVolumes([volumes.data, volumes.state]);
				await cleanupTempDir(fixtureDir);
				await cleanupTempDir(captureDir);
				await cleanupTempDir(evidenceDir);
				await cleanupTempDir(prompt?.dir);
			}
		} else if (!options.keep) {
			await cleanupTempDir(fixtureDir);
			await cleanupTempDir(captureDir);
			await cleanupTempDir(evidenceDir);
			await cleanupTempDir(prompt?.dir);
		}
	}
}

async function main() {
	const args = process.argv.slice(2);
	let image = process.env.RSI_VALIDATION_IMAGE ?? "rsi-agent:linux-validation";
	let keep = false;
	let reportPath;
	let driverTimeoutMs = DEFAULT_DRIVER_TIMEOUT_MS;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--image") image = args[++index] ?? "";
		else if (arg === "--keep") keep = true;
		else if (arg === "--report") reportPath = args[++index];
		else if (arg === "--driver-timeout-ms") driverTimeoutMs = Number(args[++index]);
		else if (arg === "--help" || arg === "-h") {
			console.log("Usage: linux-entrypoint-smoke.mjs [--image NAME] [--driver-timeout-ms N] [--report FILE] [--keep]");
			return;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	const report = {};
	const result = await runProductionEntrypointSmoke({ image, driverTimeoutMs, keep, report });
	if (reportPath) {
		await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	}
	console.log(`[entrypoint-smoke] ${result.ok ? "PASS" : "FAIL"} exit=${result.exitCode}`);
	if (!result.ok) {
		console.error(`[entrypoint-smoke] ${result.error ?? "unknown failure"}`);
		if (result.errorStack) console.error(result.errorStack);
		process.exitCode = result.exitCode ?? 1;
	}
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main().catch((error) => {
		console.error(`[entrypoint-smoke] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
