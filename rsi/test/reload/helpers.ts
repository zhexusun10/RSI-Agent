import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { SandboxHandle, SandboxPolicy } from "../../src/shared/sandbox.ts";
import type { Clock } from "../../src/shared/time.ts";
import type { HeartbeatReport } from "../../src/shared/ipc/protocol.ts";
import type { LkgSnapshot } from "../../src/shared/plugins.ts";
import type { RuntimeEventMap, RuntimeEventName, RuntimeEventPublisher } from "../../src/shared/events.ts";
import type {
	PiSdkReloadPort,
	ReloadObserverPort,
	SdkReloadOutcome,
	SdkReloadRequest,
} from "../../src/reload/types.ts";
import type { PreflightLauncherPort } from "../../src/reload/preflight-runner.ts";
import {
	PREFLIGHT_KIND_ENV,
	PREFLIGHT_RESULT_ENV,
	type MockLoadWorkerResult,
	type PreflightWorkerKind,
	type StaticCheckWorkerResult,
} from "../../src/reload/workers/child-protocol.ts";
import type {
	WatchdogProcessPort,
	WatchdogRecoveryPort,
	WatchdogTimers,
	WorkerRestartInfo,
} from "../../src/watchdog/types.ts";

export class FakeClock implements Clock {
	private current: number;

	constructor(startMs = 1_700_000_000_000) {
		this.current = startMs;
	}

	now(): Date {
		return new Date(this.current);
	}

	advance(ms: number): void {
		this.current += ms;
	}

	set(ms: number): void {
		this.current = ms;
	}
}

interface FakeTimer {
	readonly callback: () => void;
	readonly due: number;
	readonly intervalMs: number | null;
}

export class FakeTimers implements WatchdogTimers {
	private readonly timers = new Map<number, FakeTimer>();
	private nextId = 1;
	private readonly clock: Clock;

	constructor(clock: Clock) {
		this.clock = clock;
	}

	setTimeout(handler: () => void, ms: number): unknown {
		const id = this.nextId++;
		this.timers.set(id, { callback: handler, due: this.clock.now().getTime() + Math.max(0, ms), intervalMs: null });
		return id;
	}

	clearTimeout(handle: unknown): void {
		if (typeof handle === "number") this.timers.delete(handle);
	}

	setInterval(handler: () => void, ms: number): unknown {
		const id = this.nextId++;
		this.timers.set(id, {
			callback: handler,
			due: this.clock.now().getTime() + Math.max(1, ms),
			intervalMs: Math.max(1, ms),
		});
		return id;
	}

	clearInterval(handle: unknown): void {
		if (typeof handle === "number") this.timers.delete(handle);
	}

	runDue(): number {
		const now = this.clock.now().getTime();
		let ran = 0;
		for (const [id, timer] of [...this.timers.entries()]) {
			if (timer.due > now) continue;
			if (timer.intervalMs === null) this.timers.delete(id);
			else this.timers.set(id, { ...timer, due: now + timer.intervalMs });
			timer.callback();
			ran += 1;
		}
		return ran;
	}

	count(): number {
		return this.timers.size;
	}
}

export class RecordingEvents implements RuntimeEventPublisher {
	readonly events: { readonly event: RuntimeEventName; readonly payload: unknown }[] = [];

	emit<K extends RuntimeEventName>(event: K, payload: RuntimeEventMap[K]): void {
		this.events.push({ event, payload });
	}

	names(): string[] {
		return this.events.map((entry) => entry.event);
	}
}

export interface FakeLauncherBehavior {
	readonly staticOk?: boolean;
	readonly mockOk?: boolean;
	readonly staticErrors?: readonly string[];
	readonly mockErrors?: readonly string[];
	readonly mockExitCode?: number;
	readonly staticExitCode?: number;
}

function staticResult(ok: boolean, errors: readonly string[]): StaticCheckWorkerResult {
	return { kind: "static", ok, errors, filesChecked: 1, externalModules: 0 };
}

function mockResult(ok: boolean, errors: readonly string[]): MockLoadWorkerResult {
	return {
		kind: "mock",
		ok,
		errors,
		loadedEntries: [],
		extensionCount: ok ? 1 : 0,
		registrations: { tools: 0, commands: 0, flags: 0, handlers: 0 },
		sessionStartHandlers: 0,
	};
}

/** Fast preflight launcher for lifecycle tests. Real child execution is covered separately. */
export class FakePreflightLauncher implements PreflightLauncherPort {
	readonly launched: PreflightWorkerKind[] = [];
	behavior: FakeLauncherBehavior = {};
	private nextPid = 20_000;

	async launch(input: {
		readonly workerEntry: string;
		readonly cwd: string;
		readonly env: Readonly<Record<string, string>>;
		readonly signal?: AbortSignal;
	}): Promise<SandboxHandle> {
		const kind = input.env[PREFLIGHT_KIND_ENV] as PreflightWorkerKind;
		this.launched.push(kind);
		const resultPath = input.env[PREFLIGHT_RESULT_ENV];
		const ok = kind === "static" ? this.behavior.staticOk ?? true : this.behavior.mockOk ?? true;
		const errors = kind === "static" ? this.behavior.staticErrors ?? [] : this.behavior.mockErrors ?? [];
		if (resultPath) {
			const result = kind === "static" ? staticResult(ok, errors) : mockResult(ok, errors);
			await writeFile(resultPath, `${JSON.stringify(result)}\n`, "utf8");
		}
		const exitCode = ok ? 0 : kind === "static" ? this.behavior.staticExitCode ?? 1 : this.behavior.mockExitCode ?? 1;
		const pid = this.nextPid++;
		return {
			pid,
			startedAtMs: Date.now(),
			wait: async () => ({ exitCode, signal: null }),
			terminate: async () => undefined,
		};
	}

	async killTree(): Promise<void> {}
}

export const LOCAL_TEST_SANDBOX_POLICY: SandboxPolicy = {
	kind: "bubblewrap",
	bwrapPath: "bwrap",
	network: "unrestricted",
	capabilities: [],
	noNewPrivileges: true,
	unsharePid: true,
	unshareIpc: true,
	unshareUts: true,
	procfs: "isolated",
	rootFilesystem: "container-root",
	protected: [],
	canonicalProtected: [],
	hidden: [],
	writable: [],
	ipc: {
		transport: "unix",
		hostSocketPath: "/tmp/rsi-test.sock",
		workerSocketPath: "/run/rsi/worker.sock",
		stdoutIsProtocol: false,
	},
	hardlinkPolicy: "broker-owned-nlink-1-and-protected-hardlinks",
};

export class FakeSdkReload implements PiSdkReloadPort {
	readonly requests: SdkReloadRequest[] = [];
	failure: Error | null = null;
	digestOverride: string | null = null;
	generationOverride: number | null = null;

	async reload(request: SdkReloadRequest): Promise<SdkReloadOutcome> {
		this.requests.push(request);
		if (this.failure !== null) throw this.failure;
		return {
			generation: this.generationOverride ?? request.generation,
			digest: (this.digestOverride ?? request.digest) as SdkReloadOutcome["digest"],
			loadedEntryPaths: request.candidate.manifest.entries,
		};
	}
}

export class FakeObserver implements ReloadObserverPort {
	readonly begins: string[] = [];
	readonly completes: string[] = [];
	readonly failures: string[] = [];
	readonly resets: string[] = [];

	async beginReload(input: { readonly attemptId: string }): Promise<void> {
		this.begins.push(input.attemptId);
	}

	async completeReload(input: { readonly attemptId: string }): Promise<void> {
		this.completes.push(input.attemptId);
	}

	async failReload(input: { readonly attemptId: string; readonly reason: string }): Promise<void> {
		this.failures.push(`${input.attemptId}:${input.reason}`);
	}

	async resetProbation(reason: string): Promise<void> {
		this.resets.push(reason);
	}
}

export class FakeProcessTree implements WatchdogProcessPort {
	readonly killed: { readonly pid: number; readonly signal: NodeJS.Signals }[] = [];
	private readonly alive = new Set<number>();

	markAlive(pid: number): void {
		this.alive.add(pid);
	}

	markDead(pid: number): void {
		this.alive.delete(pid);
	}

	async killTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
		this.killed.push({ pid, signal });
		this.alive.delete(pid);
	}

	isAlive(pid: number): boolean {
		return this.alive.has(pid);
	}
}

export class FakeRecovery implements WatchdogRecoveryPort {
	lkg: LkgSnapshot | null = null;
	restoreCalls: LkgSnapshot[] = [];
	startCalls: { snapshot: LkgSnapshot; reason: string }[] = [];
	rollbackCalls: { snapshot: LkgSnapshot; reason: string }[] = [];
	timeoutCalls: { attemptId: string; reason: string }[] = [];
	unrecoverableCalls: string[] = [];
	startError: Error | null = null;
	restoreError: Error | null = null;
	recoverInterruptedRestoreCalled = 0;
	nextPid = 50_000;
	readonly clock: Clock;

	constructor(clock: Clock) {
		this.clock = clock;
	}

	async getLkg(): Promise<LkgSnapshot | null> {
		return this.lkg;
	}

	async restoreLkg(snapshot: LkgSnapshot): Promise<void> {
		this.restoreCalls.push(snapshot);
		if (this.restoreError !== null) throw this.restoreError;
	}

	async recordRollback(snapshot: LkgSnapshot, reason: string): Promise<void> {
		this.rollbackCalls.push({ snapshot, reason });
	}

	async startFromSnapshot(snapshot: LkgSnapshot, reason: string): Promise<WorkerRestartInfo> {
		this.startCalls.push({ snapshot, reason });
		if (this.startError !== null) throw this.startError;
		return { pid: this.nextPid++, startedAtMs: this.clock.now().getTime(), generation: snapshot.generation };
	}

	async recoverInterruptedRestore(): Promise<void> {
		this.recoverInterruptedRestoreCalled += 1;
	}

	async onReloadTimeout(input: { attemptId: string; reason: string }): Promise<void> {
		this.timeoutCalls.push(input);
	}

	async onUnrecoverable(reason: string): Promise<void> {
		this.unrecoverableCalls.push(reason);
	}
}

export function fakeLkg(generation = 3): LkgSnapshot {
	return {
		generation,
		candidateId: `gen-${String(generation).padStart(6, "0")}-abcdefabcdef`,
		digest: `sha256:${"a".repeat(64)}`,
		path: `/state/snapshots/lkg/gen-${String(generation).padStart(6, "0")}-abcdefabcdef`,
		healthyTurns: 3,
		verifiedAtMs: 1,
	};
}

export function heartbeat(
	sequence: number,
	state: HeartbeatReport["state"] = "idle",
	pid = 1234,
	generation: number | null = 3,
): HeartbeatReport {
	return {
		sequence,
		workerPid: pid,
		generation,
		state,
		healthTurns: 0,
		memoryRevision: null,
		sentAtMs: 1,
	};
}

export async function makeTempRoot(label: string): Promise<string> {
	// The CI/worktree environment can have a very deep OS temp path. Windows
	// child_process cwd is still subject to MAX_PATH in some Node versions, so
	// candidate roots used by real preflight children use a short base.
	const configured = process.env.RSI_TEST_TMPDIR;
	const base = configured ?? (process.platform === "win32" ? "C:/rsi-tmp" : tmpdir());
	await mkdir(base, { recursive: true, mode: 0o700 });
	const root = join(base, `rsi-${label}-${randomUUID()}`);
	await mkdir(root, { recursive: true, mode: 0o700 });
	return root;
}

export async function cleanupRoot(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
	for (const [relativePath, content] of Object.entries(files)) {
		const absolute = join(root, ...relativePath.split("/"));
		await mkdir(join(absolute, ".."), { recursive: true });
		await writeFile(absolute, content, "utf8");
	}
}

export function uniqueIdFactory(prefix = "attempt"): () => string {
	let index = 0;
	return () => `${prefix}-${++index}`;
}

export function simpleExtensionSource(body = "pi.registerFlag('preflight-test', { type: 'boolean' });"): string {
	return [
		'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
		"export default function extension(pi: ExtensionAPI): void {",
		`\t${body}`,
		"}",
		"",
	].join("\n");
}

export function simplePackage(): { "package.json": string; "index.ts": string } {
	return {
		"package.json": JSON.stringify({ name: "rsi-test-plugin", version: "1.0.0", type: "module" }, null, 2),
		"index.ts": simpleExtensionSource(),
	};
}
