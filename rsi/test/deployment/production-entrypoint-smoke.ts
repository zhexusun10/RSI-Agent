#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	chown,
	lstat,
	mkdir,
	readFile,
	readdir,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { auditIndex, countWords, listManagedMarkdownNames } from "../../src/shared/index.ts";

const PHASE = process.argv[2];
if (PHASE !== "prepare" && PHASE !== "first" && PHASE !== "restart") {
	throw new Error("Usage: production-entrypoint-smoke.ts prepare|first|restart [options]");
}

function parseOption(name: string, fallback?: string): string {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (value !== undefined && value.length > 0) return value;
	if (fallback !== undefined) return fallback;
	throw new Error(`Missing required option ${name}`);
}

const DATA_ROOT = resolve(process.env.RSI_ENTRYPOINT_DATA_ROOT ?? "/data");
const STATE_ROOT = resolve(process.env.RSI_ENTRYPOINT_STATE_ROOT ?? "/state");
const FIXTURE_DIR = resolve(process.env.RSI_ENTRYPOINT_FIXTURE_DIR ?? "/run/rsi-entrypoint-fixture");
const CAPTURE_DIR = resolve(process.env.RSI_ENTRYPOINT_CAPTURE_DIR ?? "/run/rsi-entrypoint-capture");
const WORKER_GID = Number.parseInt(process.env.RSI_WORKER_GID ?? "10002", 10);
const WORKER_UID = Number.parseInt(process.env.RSI_WORKER_UID ?? "10002", 10);
const MARKER = PHASE === "prepare" ? undefined : parseOption("--marker");
const EVIDENCE_FILE = parseOption(
	"--evidence-file",
	"/run/rsi-entrypoint-evidence/entrypoint-smoke.json",
);
const FIRST_EVIDENCE = resolve(
	process.env.RSI_ENTRYPOINT_FIRST_EVIDENCE ?? "/run/rsi-entrypoint-evidence/first.json",
);

if (!Number.isSafeInteger(WORKER_GID) || WORKER_GID <= 0) {
	throw new Error(`Invalid Worker GID: ${String(WORKER_GID)}`);
}
if (!Number.isSafeInteger(WORKER_UID) || WORKER_UID <= 0) {
	throw new Error(`Invalid Worker UID: ${String(WORKER_UID)}`);
}
if (MARKER !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(MARKER)) {
	throw new Error("The entrypoint smoke marker must be a bounded opaque token.");
}

const PATHS = {
	piAgentDir: join(DATA_ROOT, "pi-agent"),
	markdownsDir: join(DATA_ROOT, "markdowns"),
	memoryFile: join(DATA_ROOT, "markdowns", "Memory.md"),
	indexFile: join(DATA_ROOT, "markdowns", "index.md"),
	workspaceDir: join(DATA_ROOT, "workspace"),
	taskFile: join(DATA_ROOT, "workspace", "production-entrypoint-task.txt"),
	settingsFile: join(DATA_ROOT, "pi-agent", "settings.json"),
	modelsFile: join(DATA_ROOT, "pi-agent", "models.json"),
	authFile: join(DATA_ROOT, "pi-agent", "auth.json"),
	healthFile: join(STATE_ROOT, "runtime", "health.json"),
	pluginStateFile: join(STATE_ROOT, "plugins", "state.json"),
	readStatsFile: join(STATE_ROOT, "read-stats", "reads.json"),
	sleepFile: join(STATE_ROOT, "sleep.json"),
	watchdogFile: join(STATE_ROOT, "watchdog.json"),
	configFile: join(STATE_ROOT, "runtime", "rsi.config.json"),
	operatorBaselineFile: join(STATE_ROOT, "runtime", "operator-pi-config.json"),
	promptFile: "/run/config/system-prompt.txt",
} as const;

function fail(message: string): never {
	throw new Error(`[production-entrypoint-smoke:${PHASE}] ${message}`);
}

async function readJson(path: string): Promise<any> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function waitFor<T>(
	predicate: () => Promise<T | undefined | false> | T | undefined | false,
	label: string,
	timeoutMs = 240_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await predicate();
			if (value !== undefined && value !== false) return value as T;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	}
	const suffix = lastError instanceof Error ? `; last error: ${lastError.message}` : "";
	fail(`Timed out waiting for ${label}${suffix}`);
}

async function captureEntries(): Promise<any[]> {
	try {
		return (await readFile(join(CAPTURE_DIR, "requests.jsonl"), "utf8"))
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function messageText(entry: any): string {
	return Array.isArray(entry?.messages)
		? entry.messages.map((message: any) => String(message?.text ?? "")).join("\n")
		: "";
}

async function readHealth(): Promise<any> {
	return await readJson(PATHS.healthFile);
}

async function waitForRuntimeReady(): Promise<any> {
	return await waitFor(async () => {
		const health = await readHealth();
		const workerReady =
			health?.worker?.state === "healthy" || health?.worker?.state === "sleeping";
		if (
			health?.supervisor?.state === "running" &&
			workerReady &&
			typeof health?.worker?.pid === "number" &&
			health?.plugin?.generation !== null &&
			health?.plugin?.lkgGeneration !== null
		) {
			return health;
		}
		return undefined;
	}, "real production Worker health and baseline/LKG", 300_000);
}

async function statRegular(path: string): Promise<{ uid: number; gid: number; mode: number; isFile: boolean; nlink: number }> {
	const info = await lstat(path);
	return {
		uid: info.uid,
		gid: info.gid,
		mode: info.mode & 0o777,
		isFile: info.isFile(),
		nlink: info.nlink,
	};
}

async function readMarkdownsEvidence(): Promise<{
	names: string[];
	indexConsistent: boolean;
	indexWarnings: string[];
	memoryWords: number;
}> {
	const listing = await listManagedMarkdownNames(PATHS.markdownsDir);
	const names = [...listing.names].sort();
	const index = await readFile(PATHS.indexFile, "utf8");
	const audit = auditIndex(index, names);
	const memory = await readFile(PATHS.memoryFile, "utf8");
	return {
		names,
		indexConsistent: audit.consistent,
		indexWarnings: [...audit.warnings],
		memoryWords: countWords(memory),
	};
}

async function verifyRenderedConfig(): Promise<any> {
	const config = await waitFor(async () => {
		const current = await readJson(PATHS.configFile);
		return current?.version === 1 ? current : undefined;
	}, "deployment-render-config output");
	const expectedSandbox = {
		workerUid: WORKER_UID,
		workerGid: WORKER_GID,
		bwrapPath: "/usr/bin/bwrap",
	};
	for (const [key, value] of Object.entries(expectedSandbox)) {
		if (config?.sandbox?.[key] !== value) {
			fail(`rendered config sandbox.${key} must be ${String(value)}, got ${String(config?.sandbox?.[key])}`);
		}
	}
	for (const [key, value] of Object.entries({
		workspaceDir: join(DATA_ROOT, "workspace"),
		stateDir: STATE_ROOT,
		markdownsDir: PATHS.markdownsDir,
		systemPromptFile: PATHS.promptFile,
	})) {
		if (config?.paths?.[key] !== value) {
			fail(`rendered config paths.${key} must be ${value}, got ${String(config?.paths?.[key])}`);
		}
	}
	if (config.timeZone !== "UTC") fail(`rendered config timeZone must be UTC, got ${String(config.timeZone)}`);
	if (config.sandbox?.network !== "unrestricted") fail("rendered config must keep the network unrestricted");
	return config;
}

async function verifyOperatorConfig(): Promise<Record<string, { uid: number; gid: number; mode: number; isFile: boolean; nlink: number }>> {
	const files = [PATHS.settingsFile, PATHS.modelsFile, PATHS.authFile];
	const evidence: Record<string, { uid: number; gid: number; mode: number; isFile: boolean; nlink: number }> = {};
	for (const file of files) {
		const state = await statRegular(file);
		if (!state.isFile || state.nlink !== 1) fail(`operator config is not a single-link regular file: ${file}`);
		if (state.uid !== 0) fail(`operator config must be root-owned: ${file} uid=${state.uid}`);
		if (state.gid !== WORKER_GID) fail(`operator config must use Worker GID ${WORKER_GID}: ${file} gid=${state.gid}`);
		if (state.mode !== 0o640) fail(`operator config must be mode 0640: ${file} mode=${state.mode.toString(8)}`);
		evidence[file] = state;
	}
	const settings = JSON.parse(await readFile(PATHS.settingsFile, "utf8"));
	const models = JSON.parse(await readFile(PATHS.modelsFile, "utf8"));
	if (settings.defaultProvider !== "rsi-entrypoint-mock" || settings.defaultModel !== "rsi-entrypoint-mock-model") {
		fail("operator settings do not select the local mock provider/model");
	}
	if (models?.providers?.["rsi-entrypoint-mock"]?.baseUrl !== "http://rsi-mock-provider:18080/v1") {
		fail("operator models.json does not point at the dedicated local mock network");
	}
	if (!(await readJson(PATHS.operatorBaselineFile))?.files?.length) {
		fail("the runtime did not persist the operator Pi config digest baseline");
	}
	return evidence;
}

async function verifyPluginDiscovery(): Promise<{ status: number | null; summary: string }> {
	const result = spawnSync(
		process.execPath,
		[
			"/opt/rsi/scripts/install-plugins.mjs",
			"--verify-only",
			"--agent-dir",
			PATHS.piAgentDir,
			"--source-root",
			"/opt/rsi",
		],
		{ encoding: "utf8", timeout: 180_000, env: { ...process.env } },
	);
	const summary = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (result.error) fail(`plugin discovery verifier failed to start: ${result.error.message}`);
	if (result.status !== 0) fail(`plugin discovery verifier exited ${String(result.status)}: ${summary}`);
	if (!/loaded 2 extensions/u.test(summary)) fail(`plugin discovery did not load exactly two pinned plugins: ${summary}`);
	return { status: result.status, summary };
}

async function verifyReadStats(minimum: number): Promise<{ indexReads: number; raw: any }> {
	const raw = await waitFor(async () => {
		const current = await readJson(PATHS.readStatsFile);
		const timestamps = current?.records?.["index.md"];
		return Array.isArray(timestamps) && timestamps.length >= minimum ? current : undefined;
	}, "persisted index.md read statistics");
	const indexReads = Array.isArray(raw?.records?.["index.md"]) ? raw.records["index.md"].length : 0;
	return { indexReads, raw };
}

async function waitForCaptureEvidence(): Promise<{ entries: any[]; probeText: string; memoryInSystem: boolean; webSearchVisible: boolean }> {
	const result = await waitFor(async () => {
		const entries = await captureEntries();
		const probe = entries.find((entry) => messageText(entry).includes("PROBE_COMPLETE"));
		const memoryInSystem = entries.some(
			(entry) => typeof entry?.system === "string" && entry.system.includes(MARKER ?? ""),
		);
		if (probe === undefined || !memoryInSystem) return undefined;
		const probeText = messageText(probe);
		const webSearchVisible = entries.some(
			(entry) => Array.isArray(entry?.toolNames) && entry.toolNames.includes("web_search"),
		);
		return { entries, probeText, memoryInSystem, webSearchVisible };
	}, "real Worker tool probe and Memory-visible next provider request");
	for (const required of [
		"WRITE_FAIL:settings",
		"WRITE_FAIL:models",
		"WRITE_FAIL:auth",
		"WRITE_FAIL:prompt",
		"WRITE_FAIL:memory-direct",
		"WRITE_OK:workspace",
		"READ_OK:settings",
		"READ_OK:plugins",
		"CAP:CapEff:0",
	]) {
		assert.match(result.probeText, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `tool probe must include ${required}`);
	}
	for (const [label, value] of [
		["UID", WORKER_UID],
		["GID", WORKER_GID],
	] as const) {
		assert.match(
			result.probeText,
			new RegExp(`^${label}:${value}$`, "m"),
			`tool probe must report the exact Worker ${label}`,
		);
	}
	const groups = (result.probeText.match(/^GROUPS:(.*)$/m)?.[1] ?? "")
		.split(",")
		.filter((group) => group.length > 0);
	assert.ok(groups.length > 0, "the Worker tool probe must report its supplementary groups");
	assert.ok(
		groups.every((group) => group === String(WORKER_GID)),
		`the Worker tool probe must report only the Worker GID, got ${groups.join(",")}`,
	);
	return result;
}

async function verifySleep(deadlineMs?: number): Promise<any> {
	const state = await waitFor(async () => {
		const current = await readJson(PATHS.sleepFile);
		const sleep = current?.sleep;
		if (sleep?.status !== "active") return undefined;
		if (deadlineMs !== undefined && sleep.deadlineMs !== deadlineMs) return undefined;
		if (!(sleep.deadlineMs > Date.now())) return undefined;
		return current;
	}, deadlineMs === undefined ? "explicit sleep deadline persisted by the real entrypoint runtime" : "the same explicit sleep deadline after container restart");
	const health = await waitFor(async () => {
		const current = await readHealth();
		return current?.worker?.state === "sleeping" && current?.sleep?.active === true ? current : undefined;
	}, "container healthcheck-visible sleeping state");
	if (health.sleep.deadlineMs !== state.sleep.deadlineMs) {
		fail(`health sleep deadline ${health.sleep.deadlineMs} does not match persisted ${state.sleep.deadlineMs}`);
	}
	return { state, health };
}

async function readPluginState(): Promise<any> {
	const state = await readJson(PATHS.pluginStateFile);
	if (!state?.active || !state?.lkg) fail("plugin baseline/LKG state is missing");
	if (state.active.digest !== state.lkg.digest || state.active.generation !== state.lkg.generation) {
		fail("active plugin digest/generation does not match the persisted LKG");
	}
	return state;
}

async function prepare(): Promise<void> {
	const fixtureModels = join(FIXTURE_DIR, "models.json");
	const fixtureAuth = join(FIXTURE_DIR, "auth.json");
	const baselineSettings = JSON.parse(await readFile("/opt/rsi/pi-agent-base/settings.json", "utf8"));
	if (!Array.isArray(baselineSettings.packages) || baselineSettings.packages.length === 0) {
		fail("immutable Pi baseline settings do not declare the pinned packages");
	}
	const settings = {
		...baselineSettings,
		defaultProvider: "rsi-entrypoint-mock",
		defaultModel: "rsi-entrypoint-mock-model",
		defaultThinkingLevel: "off",
	};
	await mkdir(PATHS.piAgentDir, { recursive: true, mode: 0o755 });
	await writeFile(PATHS.settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o640 });
	await writeFile(PATHS.modelsFile, await readFile(fixtureModels, "utf8"), { mode: 0o640 });
	await writeFile(PATHS.authFile, await readFile(fixtureAuth, "utf8"), { mode: 0o640 });
	for (const file of [PATHS.settingsFile, PATHS.modelsFile, PATHS.authFile]) {
		await chown(file, 0, WORKER_GID);
		await chmod(file, 0o640);
	}
	const listing = await readdir(DATA_ROOT);
	console.log(
		`[production-entrypoint-smoke:prepare] operator models/settings/auth prepared in ${PATHS.piAgentDir}; data entries=${listing.join(",")}`,
	);
}

async function first(): Promise<void> {
	const health = await waitForRuntimeReady();
	const initialPid = health.worker.pid;
	const markdowns = await readMarkdownsEvidence();
	assert.deepEqual(markdowns.names, ["Memory.md", "architecture.md", "index.md", "okx-demo-workflow.md", "operations.md", "security.md"]);
	assert.equal(markdowns.indexConsistent, true, markdowns.indexWarnings.join("; "));
	if (markdowns.memoryWords !== 0 && !(await readFile(PATHS.memoryFile, "utf8")).includes(MARKER ?? "")) {
		fail("fresh Memory.md must be empty before the Agent's first brokered write");
	}
	const prompt = await readFile(PATHS.promptFile, "utf8");
	if (!prompt.includes("TARGET-VALIDATION-HUMAN-PROMPT-FIXTURE")) {
		fail("the read-only fixture prompt was not the prompt seen by the runtime");
	}
	let promptWritable = true;
	try {
		await writeFile(PATHS.promptFile, `${prompt}HACK`, { flag: "a" });
	} catch {
		promptWritable = false;
	}
	assert.equal(promptWritable, false, "the fixture prompt must be read-only even to the container root");
	const renderedConfig = await verifyRenderedConfig();
	const operatorConfig = await verifyOperatorConfig();
	const markdownStats = await Promise.all(
		markdowns.names.map(async (name) => {
			const file = join(PATHS.markdownsDir, name);
			return { name, ...(await statRegular(file)) };
		}),
	);
	for (const entry of markdownStats) {
		assert.equal(entry.uid, 0, `${entry.name} must be Supervisor-owned`);
		assert.equal(entry.mode, 0o644, `${entry.name} must be mode 0644`);
	}

	const memory = await waitFor(async () => {
		const content = await readFile(PATHS.memoryFile, "utf8");
		return content.includes(MARKER ?? "") ? content : undefined;
	}, "Agent Memory write through the real Worker broker");
	const task = await waitFor(async () => {
		const content = await readFile(PATHS.taskFile, "utf8");
		return content.includes(MARKER ?? "") ? content : undefined;
	}, "Agent workspace tool write");
	const capture = await waitForCaptureEvidence();
	const afterToolHealth = await readHealth();
	assert.equal(afterToolHealth.worker.pid, initialPid, "Memory/tool turns must stay on the same real Worker");
	const readStats = await verifyReadStats(1);
	const pluginState = await readPluginState();
	const pluginDiscovery = await verifyPluginDiscovery();
	const sleep = await verifySleep();
	const watchdog = await waitFor(async () => {
		const current = await readJson(PATHS.watchdogFile);
		return current?.workerPid === initialPid ? current : undefined;
	}, "Watchdog record of the real host bwrap Worker PID");
	if (!(await readJson(PATHS.configFile))) fail("deployment-render-config did not create the runtime configuration");

	const evidence = {
		version: 1,
		phase: "first",
		marker: MARKER,
		workerPid: initialPid,
		workerPidAfterToolTurns: afterToolHealth.worker.pid,
		generation: pluginState.active.generation,
		digest: pluginState.active.digest,
		lkgGeneration: pluginState.lkg.generation,
		lkgDigest: pluginState.lkg.digest,
		health,
		markdowns,
		markdownStats,
		renderedConfig,
		operatorConfig,
		memory: { bytes: Buffer.byteLength(memory), containsMarker: memory.includes(MARKER ?? "") },
		task: { bytes: Buffer.byteLength(task), containsMarker: task.includes(MARKER ?? "") },
		readStats: { indexReads: readStats.indexReads },
		pluginDiscovery,
		capture: {
			requests: capture.entries.length,
			memoryInSystem: capture.memoryInSystem,
			webSearchVisible: capture.webSearchVisible,
		},
		sleep: { sleepId: sleep.state.sleep.sleepId, deadlineMs: sleep.state.sleep.deadlineMs, status: sleep.state.sleep.status },
		watchdogWorkerPid: watchdog.workerPid,
	};
	await mkdir(dirname(EVIDENCE_FILE), { recursive: true, mode: 0o755 });
	await writeFile(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
	await writeFile(join(dirname(EVIDENCE_FILE), "first.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
	console.log(`[production-entrypoint-smoke:first] PASS ${JSON.stringify({
		workerPid: evidence.workerPid,
		generation: evidence.generation,
		digest: evidence.digest,
		sleepDeadlineMs: evidence.sleep.deadlineMs,
		indexReads: evidence.readStats.indexReads,
	})}`);
}

async function restart(): Promise<void> {
	const first = await readJson(FIRST_EVIDENCE);
	if (first?.phase !== "first" || typeof first?.marker !== "string") {
		fail(`missing first-phase evidence at ${FIRST_EVIDENCE}`);
	}
	if (first.marker !== MARKER) fail("restart marker does not match the first phase");
	const sleep = await verifySleep(first.sleep.deadlineMs);
	const health = sleep.health;
	const workerPidChanged = health.worker.pid !== first.workerPid;
	const markdowns = await readMarkdownsEvidence();
	assert.deepEqual(markdowns.names, ["Memory.md", "architecture.md", "index.md", "okx-demo-workflow.md", "operations.md", "security.md"]);
	assert.equal(markdowns.indexConsistent, true, markdowns.indexWarnings.join("; "));
	const memory = await readFile(PATHS.memoryFile, "utf8");
	const task = await readFile(PATHS.taskFile, "utf8");
	if (!memory.includes(MARKER ?? "")) fail("Memory did not survive the volume reuse restart");
	if (!task.includes(MARKER ?? "")) fail("workspace task did not survive the volume reuse restart");
	const renderedConfig = await verifyRenderedConfig();
	const operatorConfig = await verifyOperatorConfig();
	const readStats = await verifyReadStats(first.readStats.indexReads);
	const pluginState = await readPluginState();
	if (pluginState.active.generation !== first.generation) fail("plugin generation was not preserved");
	if (pluginState.active.digest !== first.digest) fail("plugin digest was not preserved");
	if (pluginState.lkg.generation !== first.lkgGeneration) fail("LKG generation was not preserved");
	if (pluginState.lkg.digest !== first.lkgDigest) fail("LKG digest was not preserved");
	const pluginDiscovery = await verifyPluginDiscovery();
	const beforeCancel = (await captureEntries()).length;
	const cancel = spawnSync(
		process.execPath,
		[
			"/opt/rsi/scripts/container-control.mjs",
			"cancelSleep",
			"--reason",
			"production entrypoint smoke verifies operator wake after restart",
		],
		{
			encoding: "utf8",
			timeout: 30_000,
			env: {
				...process.env,
				RSI_CONTROL_SOCKET: "/state/control/operator.sock",
			},
		},
	);
	if (cancel.error) fail(`operator cancelSleep failed to start: ${cancel.error.message}`);
	if (cancel.status !== 0) fail(`operator cancelSleep exited ${String(cancel.status)}: ${cancel.stderr || cancel.stdout}`);
	const cancelled = await waitFor(async () => {
		const current = await readJson(PATHS.sleepFile);
		return current?.sleep?.status === "cancelled" ? current : undefined;
	}, "operator cancelSleep persisted state");
	const resumedRequests = await waitFor(async () => {
		const entries = await captureEntries();
		return entries.length > beforeCancel ? entries : undefined;
	}, "operator-controlled wake to reach the real Worker provider request");

	const evidence = {
		version: 1,
		phase: "restart",
		marker: MARKER,
		workerPid: health.worker.pid,
		previousWorkerPid: first.workerPid,
		workerPidChanged,
		generation: pluginState.active.generation,
		digest: pluginState.active.digest,
		lkgGeneration: pluginState.lkg.generation,
		lkgDigest: pluginState.lkg.digest,
		health,
		markdowns,
		renderedConfig,
		operatorConfig,
		memory: { bytes: Buffer.byteLength(memory), containsMarker: memory.includes(MARKER ?? "") },
		task: { bytes: Buffer.byteLength(task), containsMarker: task.includes(MARKER ?? "") },
		readStats: { indexReads: readStats.indexReads },
		pluginDiscovery,
		sleep: {
			sleepId: cancelled.sleep.sleepId,
			deadlineMs: cancelled.sleep.deadlineMs,
			status: cancelled.sleep.status,
		},
		operatorCancel: {
			status: cancel.status,
			requestsBefore: beforeCancel,
			requestsAfterWake: resumedRequests.length,
		},
	};
	await mkdir(dirname(EVIDENCE_FILE), { recursive: true, mode: 0o755 });
	await writeFile(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
	console.log(`[production-entrypoint-smoke:restart] PASS ${JSON.stringify({
		workerPid: evidence.workerPid,
		generation: evidence.generation,
		digest: evidence.digest,
		sleepDeadlineMs: evidence.sleep.deadlineMs,
		indexReads: evidence.readStats.indexReads,
		operatorWakeRequests: evidence.operatorCancel.requestsAfterWake,
	})}`);
}

if (PHASE === "prepare") {
	await prepare();
} else if (PHASE === "first") {
	await first();
} else {
	await restart();
}
