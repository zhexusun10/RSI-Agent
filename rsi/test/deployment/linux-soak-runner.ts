#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	detectTargetPrerequisites,
	readJson,
	startTargetHarness,
	waitFor,
	type TargetHarness,
} from "./linux-target-harness.ts";

interface SoakSample {
	readonly atMs: number;
	readonly health:
		| {
				readonly updatedAtMs: number;
				readonly ageMs: number;
				readonly supervisorPid: number;
				readonly workerPid: number | null;
				readonly workerState: string;
				readonly sleepActive: boolean;
				readonly watchdogPhase: string | null;
		  }
		| null;
	readonly resources: {
		readonly supervisorRssKb: number | null;
		readonly workerRssKb: number | null;
		readonly processCount: number;
		readonly dataFreeBytes: number | null;
		readonly stateFreeBytes: number | null;
	} | null;
	readonly logs: {
		readonly files: Readonly<Record<string, number>>;
		readonly totalBytes: number;
	};
	readonly recovery: {
		readonly phase: string | null;
		readonly incidents: number;
		readonly recoveryMode: string | null;
		readonly pendingNotices: number;
	};
	readonly problems: readonly string[];
}

function usage() {
	console.error(`Usage: node test/deployment/linux-soak-runner.ts [--hours N] [--sample-ms N] [--report FILE]

This runner executes inside the target Linux container. It uses only the
repository test-mode faux provider. The default duration is 24 hours; shorten
it only for an explicit bounded diagnostic run.`);
}

function parseArgs(argv: string[]) {
	let hours = Number(process.env.RSI_SOAK_HOURS ?? "24");
	let sampleMs = Number(process.env.RSI_SOAK_SAMPLE_MS ?? "30000");
	let reportPath = process.env.RSI_SOAK_REPORT ?? "/run/rsi-artifacts/linux-soak-report.json";
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--hours") hours = Number(argv[++index]);
		else if (arg === "--sample-ms") sampleMs = Number(argv[++index]);
		else if (arg === "--report") reportPath = argv[++index] ?? reportPath;
		else if (arg === "--help" || arg === "-h") {
			usage();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours must be a positive number");
	if (!Number.isSafeInteger(sampleMs) || sampleMs < 1_000) throw new Error("--sample-ms must be an integer >= 1000");
	return { durationMs: Math.round(hours * 3_600_000), sampleMs, reportPath };
}

function isAlive(pid: number | null): boolean {
	if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function rssKb(pid: number | null): Promise<number | null> {
	if (pid === null) return null;
	try {
		const status = await readFile(`/proc/${pid}/status`, "utf8");
		const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
		return match === null ? null : Number(match[1]);
	} catch {
		return null;
	}
}

async function processParents(): Promise<Map<number, number>> {
	const parents = new Map<number, number>();
	for (const name of await readdir("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const statText = await readFile(`/proc/${name}/stat`, "utf8");
			const close = statText.lastIndexOf(")");
			if (close === -1) continue;
			const fields = statText.slice(close + 2).trim().split(/\s+/);
			const parent = Number(fields[1]);
			if (Number.isSafeInteger(parent)) parents.set(Number(name), parent);
		} catch {
			// A process can exit while /proc is sampled.
		}
	}
	return parents;
}

function descendantCount(parents: ReadonlyMap<number, number>, root: number): number {
	const children = new Map<number, number[]>();
	for (const [pid, ppid] of parents) {
		const list = children.get(ppid) ?? [];
		list.push(pid);
		children.set(ppid, list);
	}
	const queue = [root];
	const seen = new Set<number>();
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;
		for (const child of children.get(current) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			queue.push(child);
		}
	}
	return seen.size;
}

async function logSizes(logsDir: string): Promise<{ files: Record<string, number>; totalBytes: number }> {
	const files: Record<string, number> = {};
	let totalBytes = 0;
	try {
		for (const name of await readdir(logsDir)) {
			if (!name.endsWith(".log") && !/\.log\.\d+$/.test(name)) continue;
			try {
				const info = await stat(join(logsDir, name));
				files[name] = info.size;
				totalBytes += info.size;
			} catch {
				// Rotation can remove a file between readdir and stat.
			}
		}
	} catch {
		// The logs directory is created by the runtime; absence is reported by health.
	}
	return { files, totalBytes };
}

async function freeBytes(path: string): Promise<number | null> {
	try {
		const info = await statfs(path);
		return info.bavail * info.bsize;
	} catch {
		return null;
	}
}

async function sample(harness: TargetHarness, maxHealthAgeMs: number): Promise<SoakSample> {
	const now = Date.now();
	const problems: string[] = [];
	let health: SoakSample["health"] = null;
	try {
		const raw = await readJson<Record<string, any>>(join(harness.stateDir, "runtime", "health.json"));
		const ageMs = now - Number(raw.updatedAtMs);
		const workerPid = typeof raw.worker?.pid === "number" ? raw.worker.pid : null;
		const workerState = String(raw.worker?.state ?? "unknown");
		const sleepActive = raw.sleep?.active === true;
		const deadlineMs = typeof raw.sleep?.deadlineMs === "number" ? raw.sleep.deadlineMs : null;
		health = {
			updatedAtMs: Number(raw.updatedAtMs),
			ageMs,
			supervisorPid: Number(raw.supervisor?.pid),
			workerPid,
			workerState,
			sleepActive,
			watchdogPhase: typeof raw.watchdog?.phase === "string" ? raw.watchdog.phase : null,
		};
		if (ageMs > maxHealthAgeMs) problems.push(`health file is stale (${ageMs} ms)`);
		if (raw.supervisor?.state !== "running") problems.push(`supervisor state is ${String(raw.supervisor?.state)}`);
		if (!isAlive(Number(raw.supervisor?.pid))) problems.push("supervisor pid is not alive");
		if (workerState === "sleeping") {
			if (!sleepActive || deadlineMs === null || deadlineMs <= now) {
				problems.push("sleeping health has no future active deadline");
			}
		} else if (workerState === "healthy") {
			if (!isAlive(workerPid)) problems.push("healthy worker pid is not alive");
		} else {
			problems.push(`worker state is ${workerState}`);
		}
		if (health.watchdogPhase === "suspect" || health.watchdogPhase === "rollback") {
			problems.push(`watchdog phase is ${health.watchdogPhase}`);
		}
	} catch (error) {
		problems.push(`health file unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}

	const parents = await processParents();
	const watchdogFile = join(harness.stateDir, "watchdog.json");
	let recovery: SoakSample["recovery"] = {
		phase: null,
		incidents: 0,
		recoveryMode: null,
		pendingNotices: 0,
	};
	try {
		const watchdog = await readJson<Record<string, any>>(watchdogFile);
		const incidents = Array.isArray(watchdog.incidents) ? watchdog.incidents.length : 0;
		const recoveryMode =
			typeof watchdog.recovery === "object" && watchdog.recovery !== null
				? String(watchdog.recovery.mode ?? "")
				: null;
		recovery = {
			phase: typeof watchdog.phase === "string" ? watchdog.phase : null,
			incidents,
			recoveryMode,
			pendingNotices: recovery.pendingNotices,
		};
		if (watchdog.phase === "unrecoverable" || recoveryMode === "unrecoverable") {
			problems.push("watchdog is unrecoverable");
		}
	} catch {
		// The watchdog state is created after the Worker starts.
	}
	try {
		const notices = await readJson<Record<string, any>>(join(harness.stateDir, "control", "recovery-notices.json"));
		recovery = {
			...recovery,
			pendingNotices: Array.isArray(notices.pending) ? notices.pending.length : 0,
		};
	} catch {
		// No notice file means no pending notice.
	}

	const resources = health === null
		? null
		: {
				supervisorRssKb: await rssKb(health.supervisorPid),
				workerRssKb: await rssKb(health.workerPid),
				processCount: descendantCount(parents, process.pid),
				dataFreeBytes: await freeBytes(harness.paths.dataDir),
				stateFreeBytes: await freeBytes(harness.stateDir),
			};
	const logs = await logSizes(harness.paths.logsDir);
	if (logs.totalBytes > 128 * 1024 * 1024) {
		problems.push(`logs exceed the bounded 128 MiB soak limit (${logs.totalBytes} bytes)`);
	}
	if (health?.workerPid !== null && health?.workerPid !== undefined && !isAlive(health.workerPid)) {
		problems.push("host Worker pid is not alive");
	}
	return { atMs: now, health, resources, logs, recovery, problems };
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const prerequisites = await detectTargetPrerequisites();
	if (prerequisites.skipReason !== undefined) {
		throw new Error(`Soak prerequisites failed: ${prerequisites.skipReason}`);
	}
	const startedAt = Date.now();
	const deadline = startedAt + options.durationMs;
	const harness = await startTargetHarness({ expectEmptyVolumes: process.env.RSI_TARGET_EXPECT_EMPTY === "1" });
	const samples: SoakSample[] = [];
	let stopped = false;
	const writeReport = async (complete: boolean) => {
		const report = {
			version: 1,
			startedAt: new Date(startedAt).toISOString(),
			finishedAt: new Date().toISOString(),
			requestedDurationMs: options.durationMs,
			sampleIntervalMs: options.sampleMs,
			complete,
			sampleCount: samples.length,
			firstSample: samples[0] ?? null,
			lastSample: samples.at(-1) ?? null,
			failures: samples.flatMap((entry) => entry.problems.map((problem) => ({ atMs: entry.atMs, problem }))),
			samples,
			prerequisites: prerequisites.report,
		};
		await mkdir(dirname(options.reportPath), { recursive: true }).catch(() => undefined);
		await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
		return report;
	};
	const stop = async (signal: string) => {
		if (stopped) return;
		stopped = true;
		console.error(`[soak] received ${signal}; writing partial report and stopping the test runtime.`);
		await writeReport(false).catch(() => undefined);
		await harness.cleanup().catch(() => undefined);
		process.exit(signal === "SIGTERM" ? 143 : 130);
	};
	process.on("SIGTERM", () => void stop("SIGTERM"));
	process.on("SIGINT", () => void stop("SIGINT"));
	try {
		await harness.setScript([
			{ toolCalls: [{ name: "sleep", id: "soak-sleep", arguments: { duration: "10s" } }] },
			{ text: "soak wake" },
			...Array.from({ length: 50 }, (_, index) => ({ text: `soak healthy turn ${index + 1}` })),
			{ text: "soak idle", stopReason: "error", errorMessage: "soak continues sampling without provider calls" },
		]);
		await waitFor(
			async () => {
				try {
					const health = await readJson<Record<string, any>>(join(harness.stateDir, "runtime", "health.json"));
					return health.worker?.state === "healthy" || health.worker?.state === "sleeping" ? health : undefined;
				} catch {
					return undefined;
				}
			},
			"first soak health file",
			120_000,
		);
		while (Date.now() < deadline) {
			const current = await sample(harness, 60_000);
			samples.push(current);
			console.log(
				`[soak] sample at=${new Date(current.atMs).toISOString()} worker=${current.health?.workerState ?? "unknown"} ` +
					`rss=${current.resources?.workerRssKb ?? "?"}KB logs=${current.logs.totalBytes}B ` +
					`recovery=${current.recovery.phase ?? "?"} problems=${current.problems.length}`,
			);
			if (current.problems.length > 0) {
				throw new Error(`Soak sample failed: ${current.problems.join(" | ")}`);
			}
			await new Promise((resolveDelay) =>
				setTimeout(resolveDelay, Math.min(options.sampleMs, Math.max(1_000, deadline - Date.now()))),
			);
		}
		const report = await writeReport(true);
		if (report.failures.length > 0) {
			throw new Error(`Soak recorded ${report.failures.length} failure(s); see ${options.reportPath}`);
		}
		console.log(
			`[soak] complete durationMs=${Date.now() - startedAt} samples=${samples.length} report=${options.reportPath}`,
		);
	} catch (error) {
		await writeReport(false).catch(() => undefined);
		throw error;
	} finally {
		await harness.cleanup().catch(() => undefined);
	}
}

await main().catch((error) => {
	console.error(`[soak] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exitCode = 1;
});
