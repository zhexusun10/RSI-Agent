import type { ChildProcess } from "node:child_process";
import { appendWorkerStderrLog, resetWorkerStderrLog } from "../shared/stderr-log.ts";
import { readFile, readdir } from "node:fs/promises";
import { RsiError } from "../shared/errors.ts";
import type {
	SandboxExit,
	SandboxOutputSnapshot,
	SandboxProcessHandle,
	SandboxProcessControlPort,
} from "./types.ts";

export interface ProcessIdentity {
	readonly pid: number;
	readonly startTime: string;
}

export interface ProcessStat extends ProcessIdentity {
	readonly ppid: number;
	readonly pgid: number;
}

export interface ProcessTerminationOptions {
	readonly graceMs: number;
	readonly killWaitMs: number;
}

const activeProcesses = new Set<BubblewrapSandboxProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const handle of activeProcesses) {
			handle.killNow("SIGKILL");
		}
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

class BoundedCollector {
	private readonly chunks: Buffer[] = [];
	private readonly maxBytes: number;
	private kept = 0;
	private total = 0;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	append(chunk: Buffer): void {
		this.total += chunk.length;
		if (this.kept >= this.maxBytes) return;
		const take = chunk.subarray(0, Math.min(chunk.length, this.maxBytes - this.kept));
		if (take.length === 0) return;
		this.chunks.push(Buffer.from(take));
		this.kept += take.length;
	}

	text(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}

	get totalBytes(): number {
		return this.total;
	}

	get truncated(): boolean {
		return this.total > this.kept;
	}

	get keptBytes(): number {
		return this.kept;
	}
}

/** Read one Linux process stat record without trusting comm's parentheses. */
export async function readProcessStat(pid: number): Promise<ProcessStat | null> {
	if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) return null;
	let text: string;
	try {
		text = await readFile(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	const close = text.lastIndexOf(")");
	if (close === -1) return null;
	const fields = text
		.slice(close + 2)
		.trim()
		.split(/\s+/);
	if (fields.length < 20) return null;
	const ppid = Number(fields[1]);
	const pgid = Number(fields[2]);
	const startTime = fields[19] ?? "";
	if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || startTime.length === 0) return null;
	return { pid, ppid, pgid, startTime };
}

async function listAllProcessStats(): Promise<ProcessStat[]> {
	if (process.platform !== "linux") return [];
	let names: string[];
	try {
		names = await readdir("/proc");
	} catch {
		return [];
	}
	const pids = names
		.filter((name) => /^\d+$/.test(name))
		.map(Number)
		.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
	const stats = await Promise.all(pids.map((pid) => readProcessStat(pid)));
	return stats.filter((entry): entry is ProcessStat => entry !== null);
}

async function ancestorPidsOfSelf(): Promise<Set<number>> {
	const result = new Set<number>([process.pid]);
	let current = process.pid;
	for (let depth = 0; depth < 64; depth += 1) {
		const stat = await readProcessStat(current);
		if (stat === null || stat.ppid <= 1 || result.has(stat.ppid)) break;
		result.add(stat.ppid);
		current = stat.ppid;
	}
	return result;
}

/**
 * Collect the host PIDs belonging to one sandbox: descendants of the bwrap
 * process and every process in its detached process group. The function also
 * works after the bwrap parent exits when the group still has members.
 */
export async function collectProcessTree(rootPid: number, processGroupId: number): Promise<ProcessIdentity[]> {
	if (process.platform !== "linux" || rootPid <= 0) return [];
	const stats = await listAllProcessStats();
	const protectedPids = await ancestorPidsOfSelf();
	const byParent = new Map<number, ProcessStat[]>();
	for (const stat of stats) {
		const children = byParent.get(stat.ppid);
		if (children === undefined) byParent.set(stat.ppid, [stat]);
		else children.push(stat);
	}
	const selected = new Map<number, ProcessStat>();
	const queue = [rootPid];
	while (queue.length > 0) {
		const parent = queue.shift();
		if (parent === undefined) continue;
		for (const child of byParent.get(parent) ?? []) {
			if (selected.has(child.pid) || protectedPids.has(child.pid)) continue;
			selected.set(child.pid, child);
			queue.push(child.pid);
		}
	}
	for (const stat of stats) {
		if (stat.pgid === processGroupId && !protectedPids.has(stat.pid)) {
			selected.set(stat.pid, stat);
		}
	}
	return [...selected.values()]
		.map((stat) => ({ pid: stat.pid, startTime: stat.startTime }))
		.sort((left, right) => left.pid - right.pid);
}

async function signalIdentity(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<boolean> {
	const current = await readProcessStat(identity.pid);
	if (current === null || current.startTime !== identity.startTime) return false;
	try {
		process.kill(identity.pid, signal);
		return true;
	} catch {
		return false;
	}
}

/** TERM/KILL a process group and concrete process identities without a shell. */
export async function signalProcessIdentities(
	identities: readonly ProcessIdentity[],
	processGroupId: number,
	signal: NodeJS.Signals,
): Promise<readonly number[]> {
	const signaled: number[] = [];
	if (processGroupId > 1) {
		try {
			process.kill(-processGroupId, signal);
		} catch {
			// The group may already be gone.
		}
	}
	for (const identity of identities) {
		if (await signalIdentity(identity, signal)) signaled.push(identity.pid);
	}
	return signaled;
}

function rememberIdentities(target: Map<number, string>, identities: readonly ProcessIdentity[]): void {
	for (const identity of identities) {
		if (!target.has(identity.pid)) target.set(identity.pid, identity.startTime);
	}
}

function identitiesFromMap(values: Map<number, string>): ProcessIdentity[] {
	return [...values.entries()].map(([pid, startTime]) => ({ pid, startTime }));
}

export async function terminateProcessTree(
	rootPid: number,
	processGroupId: number,
	options: ProcessTerminationOptions,
): Promise<void> {
	if (process.platform !== "linux" || rootPid <= 0) return;
	const remembered = new Map<number, string>();
	rememberIdentities(remembered, await collectProcessTree(rootPid, processGroupId));
	await signalProcessIdentities(identitiesFromMap(remembered), processGroupId, "SIGTERM");
	const deadline = Date.now() + Math.max(0, options.graceMs);
	while (Date.now() < deadline) {
		const root = await readProcessStat(rootPid);
		if (root === null) break;
		await delay(20);
	}
	rememberIdentities(remembered, await collectProcessTree(rootPid, processGroupId));
	// Kill every identity remembered during TERM, including children reparented
	// after bwrap exits, plus the current process group.
	await signalProcessIdentities(identitiesFromMap(remembered), processGroupId, "SIGKILL");
	const killDeadline = Date.now() + Math.max(0, options.killWaitMs);
	while (Date.now() < killDeadline) {
		const remaining = await signalProcessIdentities(
			identitiesFromMap(remembered),
			processGroupId,
			"SIGKILL",
		);
		if (remaining.length === 0) break;
		await delay(20);
	}
	// Give the kernel a chance to reap the PID-namespace init and its children.
	await delay(20);
}

export class BubblewrapSandboxProcess implements SandboxProcessHandle {
	readonly pid: number;
	readonly processGroupId: number;
	readonly exited: Promise<SandboxExit>;
	private readonly stdoutCollector: BoundedCollector;
	private readonly stderrCollector: BoundedCollector;
	private resolveExit!: (value: SandboxExit) => void;
	readonly startedAtMs: number;
	private exitedAtMs = 0;
	private exitValue: SandboxExit | null = null;
	private timedOut = false;
	private aborted = false;
	private terminationRequested = false;
	private childError: string | null = null;
	private readonly terminationOptions: ProcessTerminationOptions;
	private readonly child: ChildProcess;
	private terminationPromise: Promise<void> | null = null;

	constructor(
		child: ChildProcess,
		options: {
			readonly maxStdoutBytes: number;
			readonly maxStderrBytes: number;
			readonly terminationGraceMs: number;
			readonly killWaitMs: number;
			readonly stderrLogPath?: string;
			readonly stderrRedactions?: readonly string[];
		},
	) {
		if (child.pid === undefined) {
			throw new RsiError("SANDBOX_INVALID", "bubblewrap did not return a child PID.");
		}
		this.child = child;
		this.pid = child.pid;
		this.processGroupId = child.pid;
		this.startedAtMs = Date.now();
		this.terminationOptions = {
			graceMs: options.terminationGraceMs,
			killWaitMs: options.killWaitMs,
		};
		this.stdoutCollector = new BoundedCollector(options.maxStdoutBytes);
		this.stderrCollector = new BoundedCollector(options.maxStderrBytes);
		const stderrLogPath = options.stderrLogPath;
		const stderrRedactions = options.stderrRedactions ?? [];
		if (stderrLogPath !== undefined && stderrLogPath.length > 0) {
			resetWorkerStderrLog(stderrLogPath);
		}
		this.exited = new Promise<SandboxExit>((resolve) => {
			this.resolveExit = resolve;
		});
		child.stdout?.on("data", (chunk: Buffer | string) => {
			this.stdoutCollector.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			this.stderrCollector.append(bytes);
			if (stderrLogPath !== undefined && stderrLogPath.length > 0) {
				appendWorkerStderrLog(stderrLogPath, bytes.toString("utf8"), stderrRedactions);
			}
		});
		child.once("error", (error) => {
			this.childError = error.message;
		});
		child.once("close", (exitCode, signal) => {
			this.exitedAtMs = Date.now();
			this.exitValue = {
				exitCode,
				signal,
				timedOut: this.timedOut,
				aborted: this.aborted,
				terminated: this.terminationRequested,
				startedAtMs: this.startedAtMs,
				exitedAtMs: this.exitedAtMs,
				durationMs: this.exitedAtMs - this.startedAtMs,
				error: this.childError,
			};
			activeProcesses.delete(this);
			this.resolveExit(this.exitValue);
		});
		activeProcesses.add(this);
		installExitHook();
	}

	wait(): Promise<SandboxExit> {
		return this.exited;
	}

	output(): SandboxOutputSnapshot {
		return {
			stdout: this.stdoutCollector.text(),
			stderr: this.stderrCollector.text(),
			stdoutBytes: this.stdoutCollector.totalBytes,
			stderrBytes: this.stderrCollector.totalBytes,
			stdoutTruncated: this.stdoutCollector.truncated,
			stderrTruncated: this.stderrCollector.truncated,
		};
	}

	async descendants(): Promise<readonly number[]> {
		const identities = await collectProcessTree(this.pid, this.processGroupId);
		return identities.map((identity) => identity.pid);
	}

	async signalTree(signal: NodeJS.Signals): Promise<readonly number[]> {
		const identities = await collectProcessTree(this.pid, this.processGroupId);
		return signalProcessIdentities(identities, this.processGroupId, signal);
	}

	killNow(signal: NodeJS.Signals = "SIGKILL"): boolean {
		let sent = false;
		try {
			process.kill(-this.processGroupId, signal);
			sent = true;
		} catch {
			// Fall through to the top-level child.
		}
		try {
			this.child.kill(signal);
			sent = true;
		} catch {
			// Already exited.
		}
		return sent;
	}

	markTimedOut(): void {
		this.timedOut = true;
	}

	markAborted(): void {
		this.aborted = true;
	}

	terminate(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
		if (this.terminationPromise !== null) return this.terminationPromise;
		this.terminationRequested = true;
		this.terminationPromise = (async () => {
			if (this.exitValue !== null) return;
			const firstSignal: NodeJS.Signals = signal === "SIGKILL" ? "SIGKILL" : signal;
			const tracked = new Map<number, string>();
			rememberIdentities(tracked, await collectProcessTree(this.pid, this.processGroupId));
			await signalProcessIdentities(identitiesFromMap(tracked), this.processGroupId, firstSignal);
			if (firstSignal !== "SIGKILL") {
				await Promise.race([this.exited, delay(this.terminationOptions.graceMs)]);
			}
			// Remember descendants that appeared during the grace period, then
			// KILL every remembered identity even if bwrap itself already exited.
			rememberIdentities(tracked, await collectProcessTree(this.pid, this.processGroupId));
			const deadline = Date.now() + Math.max(0, this.terminationOptions.killWaitMs);
			for (;;) {
				rememberIdentities(tracked, await collectProcessTree(this.pid, this.processGroupId));
				const remaining = await signalProcessIdentities(
					identitiesFromMap(tracked),
					this.processGroupId,
					"SIGKILL",
				);
				if (remaining.length === 0 || Date.now() >= deadline) break;
				await delay(20);
			}
			if (this.exitValue === null) {
				try {
					this.child.kill("SIGKILL");
				} catch {
					// Already gone.
				}
				await Promise.race([this.exited, delay(this.terminationOptions.killWaitMs)]);
			}
		})();
		return this.terminationPromise;
	}
}

export function isSandboxProcessControl(value: unknown): value is SandboxProcessControlPort {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { terminate?: unknown }).terminate === "function" &&
		typeof (value as { wait?: unknown }).wait === "function"
	);
}
