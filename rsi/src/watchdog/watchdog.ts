import { readTail, AtomicJsonFile, appendBoundedLog } from "../reload/atomic-file.ts";
import type { HeartbeatReport } from "../shared/ipc/protocol.ts";
import type { RuntimeEventPublisher } from "../shared/events.ts";
import type { WatchdogPort, WorkerProcessInfo } from "../shared/ports.ts";
import type { Clock } from "../shared/time.ts";
import type { RecoveryNoticeStore } from "./notifications.ts";
import {
	DEFAULT_BUSY_LEASE_MULTIPLIER,
	DEFAULT_HEARTBEAT_TIMEOUT_MS,
	DEFAULT_MAX_RESTARTS,
	DEFAULT_RESTART_BASE_MS,
	DEFAULT_RESTART_MAX_MS,
	DEFAULT_STABLE_RESET_MS,
	DEFAULT_WATCHDOG_TICK_MS,
	MAX_NOTICE_LOG_BYTES,
	MAX_WATCHDOG_LOG_BYTES,
	initialWatchdogState,
	systemWatchdogTimers,
	validateWatchdogPersistentState,
	type WatchdogExpectedExit,
	type WatchdogIncidentRecord,
	type WatchdogPersistentState,
	type WatchdogProcessPort,
	type WatchdogRecoveryPort,
	type WatchdogRecoveryState,
	type WatchdogTimers,
	type WorkerRestartInfo,
} from "./types.ts";

export interface WatchdogOptions {
	readonly stateFile: string;
	readonly clock: Clock;
	readonly recovery: WatchdogRecoveryPort;
	readonly notifications: RecoveryNoticeStore;
	readonly events?: RuntimeEventPublisher;
	readonly processTree?: WatchdogProcessPort;
	readonly timers?: WatchdogTimers;
	readonly heartbeatTimeoutMs?: number;
	readonly busyLeaseMultiplier?: number;
	readonly tickIntervalMs?: number;
	readonly restartBaseMs?: number;
	readonly restartMaxMs?: number;
	readonly maxRestarts?: number;
	readonly stableResetMs?: number;
	readonly missedHeartbeatLimit?: number;
	readonly workerStderrPath?: string;
	readonly logPath?: string;
	readonly onDiagnostic?: (message: string) => void;
}

function defaultProcessPort(): WatchdogProcessPort {
	return {
		async killTree(pid, signal = "SIGKILL") {
			if (!Number.isInteger(pid) || pid <= 1) return;
			if (process.platform === "win32") {
				const { execFile } = await import("node:child_process");
				const { promisify } = await import("node:util");
				await promisify(execFile)("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).catch(
					() => undefined,
				);
				return;
			}
			try {
				process.kill(-pid, signal);
			} catch {
				// Fall through to the direct pid.
			}
			try {
				process.kill(pid, signal);
			} catch {
				// Already gone.
			}
		},
		isAlive(pid) {
			if (!Number.isInteger(pid) || pid <= 1) return false;
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		},
	};
}

function retirePid(retired: readonly number[], pid: number | null): number[] {
	if (pid === null || !Number.isInteger(pid) || pid <= 1) return [...retired];
	return [...new Set([...retired, pid])].slice(-32);
}

function boundedLog(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_NOTICE_LOG_BYTES) return text;
	const bytes = Buffer.from(text, "utf8");
	return bytes.subarray(bytes.length - MAX_NOTICE_LOG_BYTES).toString("utf8");
}

function heartbeatLabel(state: HeartbeatReport["state"]): boolean {
	return state === "busy" || state === "reloading";
}

/**
 * External Watchdog. It never imports or executes a plugin, and it uses only
 * injected process/recovery ports so unit tests can use a fake clock and tree
 * killer. Heartbeats can be suspended during explicit sleep; normal async
 * network/tool waits keep the Worker event loop alive and therefore heartbeat.
 */
export class Watchdog implements WatchdogPort {
	readonly clock: Clock;
	readonly recovery: WatchdogRecoveryPort;
	readonly notifications: RecoveryNoticeStore;
	readonly events: RuntimeEventPublisher | undefined;
	readonly processTree: WatchdogProcessPort;
	readonly timers: WatchdogTimers;
	readonly heartbeatTimeoutMs: number;
	readonly busyLeaseMultiplier: number;
	readonly tickIntervalMs: number;
	readonly restartBaseMs: number;
	readonly restartMaxMs: number;
	readonly maxRestarts: number;
	readonly stableResetMs: number;
	readonly missedHeartbeatLimit: number;
	readonly workerStderrPath: string | undefined;
	readonly logPath: string | undefined;
	readonly onDiagnostic: (message: string) => void;
	readonly stateFile: AtomicJsonFile<WatchdogPersistentState>;
	private state: WatchdogPersistentState | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private startPromise: Promise<void> | null = null;
	private intervalHandle: unknown = null;
	private retryHandle: unknown = null;
	private started = false;

	constructor(options: WatchdogOptions) {
		this.clock = options.clock;
		this.recovery = options.recovery;
		this.notifications = options.notifications;
		this.events = options.events;
		this.processTree = options.processTree ?? defaultProcessPort();
		this.timers = options.timers ?? systemWatchdogTimers;
		this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
		this.busyLeaseMultiplier = options.busyLeaseMultiplier ?? DEFAULT_BUSY_LEASE_MULTIPLIER;
		this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_WATCHDOG_TICK_MS;
		this.restartBaseMs = options.restartBaseMs ?? DEFAULT_RESTART_BASE_MS;
		this.restartMaxMs = options.restartMaxMs ?? DEFAULT_RESTART_MAX_MS;
		this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
		this.stableResetMs = options.stableResetMs ?? DEFAULT_STABLE_RESET_MS;
		this.missedHeartbeatLimit = options.missedHeartbeatLimit ?? 1;
		this.workerStderrPath = options.workerStderrPath;
		this.logPath = options.logPath;
		this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
		this.stateFile = new AtomicJsonFile(options.stateFile, validateWatchdogPersistentState);
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.startPromise = this.initialize();
		void this.startPromise.catch((error) => {
			this.onDiagnostic(`Watchdog start failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		});
	}

	async ready(): Promise<void> {
		if (!this.started) this.start();
		await this.startPromise;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(operation, operation);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async initialize(): Promise<void> {
		await this.stateFile.cleanupTemps();
		const read = await this.stateFile.read();
		let state = read.value ?? initialWatchdogState(this.clock.now());
		for (const diagnostic of read.diagnostics) this.onDiagnostic(diagnostic);
		if (state.phase === "stopped") {
			state = {
				...state,
				phase: "idle",
				operatorStopReason: null,
				expectedExit: null,
				workerPid: null,
				leaseExpiresAtMs: null,
				reload: null,
				sleepSuspended: false,
				updatedAtMs: this.clock.now().getTime(),
			};
		} else if (state.workerPid !== null) {
			// Pids are not durable across Supervisor restarts. Do not signal a pid
			// recorded by a previous process; the integration must report the new
			// Worker with recordWorkerStarted.
			state = {
				...state,
				workerPid: null,
				retiredWorkerPids: retirePid(state.retiredWorkerPids, state.workerPid),
				leaseExpiresAtMs: null,
				sleepSuspended: false,
				expectedExit: null,
				phase: state.phase === "healthy" || state.phase === "starting" || state.phase === "suspect" ? "idle" : state.phase,
				updatedAtMs: this.clock.now().getTime(),
			};
		}
		this.state = state;
		await this.stateFile.write(state);
		await this.recovery.recoverInterruptedRestore?.().catch((error) => {
			this.onDiagnostic(`Interrupted restore recovery failed: ${String(error)}`);
		});
		this.intervalHandle = this.timers.setInterval(() => {
			void this.tick().catch((error) => this.onDiagnostic(`Watchdog tick failed: ${String(error)}`));
		}, this.tickIntervalMs);
		if (state.recovery !== null && state.recovery.mode !== "unrecoverable") {
			this.scheduleRetry(state.recovery.nextAttemptAtMs);
		}
	}

	private async persist(state: WatchdogPersistentState): Promise<WatchdogPersistentState> {
		const next = { ...state, updatedAtMs: this.clock.now().getTime() };
		await this.stateFile.write(next);
		this.state = next;
		return next;
	}

	private async load(): Promise<WatchdogPersistentState> {
		await this.ready();
		if (this.state === null) throw new Error("Watchdog state was not initialized.");
		return this.state;
	}

	private log(kind: string, detail: Record<string, unknown>): Promise<void> {
		if (this.logPath === undefined) return Promise.resolve();
		const line = `${JSON.stringify({ atMs: this.clock.now().getTime(), kind, detail })}\n`;
		return appendBoundedLog(this.logPath, line, MAX_WATCHDOG_LOG_BYTES);
	}

	private clearRetry(): void {
		if (this.retryHandle !== null) {
			this.timers.clearTimeout(this.retryHandle);
			this.retryHandle = null;
		}
	}

	private scheduleRetry(atMs: number | null): void {
		this.clearRetry();
		if (atMs === null) return;
		const delay = Math.max(0, atMs - this.clock.now().getTime());
		this.retryHandle = this.timers.setTimeout(() => {
			this.retryHandle = null;
			void this.tick().catch((error) => this.onDiagnostic(`Watchdog retry failed: ${String(error)}`));
		}, delay);
	}

	private backoffFor(attempt: number): number {
		const exponent = Math.max(0, attempt - 1);
		return Math.min(this.restartMaxMs, this.restartBaseMs * 2 ** Math.min(exponent, 16));
	}

	async status(): Promise<WatchdogPersistentState> {
		return this.enqueue(async () => this.load());
	}

	async startAsync(): Promise<void> {
		await this.ready();
	}

	async stop(): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.load();
			this.clearRetry();
			if (this.intervalHandle !== null) {
				this.timers.clearInterval(this.intervalHandle);
				this.intervalHandle = null;
			}
			await this.persist({
				...state,
				phase: "stopped",
				expectedExit: state.workerPid === null ? null : { pid: state.workerPid, kind: "operator", reason: "watchdog stopped", atMs: this.clock.now().getTime() },
				reload: null,
				recovery: null,
				leaseExpiresAtMs: null,
				sleepSuspended: false,
				updatedAtMs: this.clock.now().getTime(),
			});
			await this.log("watchdog.stopped", {});
		});
	}

	async markOperatorStop(reason: string): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.load();
			this.clearRetry();
			await this.persist({
				...state,
				phase: "stopped",
				operatorStopReason: reason,
				expectedExit:
					state.workerPid === null
						? null
						: { pid: state.workerPid, kind: "operator", reason, atMs: this.clock.now().getTime() },
				reload: null,
				leaseExpiresAtMs: null,
				sleepSuspended: false,
				recovery: null,
				updatedAtMs: this.clock.now().getTime(),
			});
			await this.log("operator.stop", { reason });
		});
	}

	async markExpectedStop(reason: string, kind: "operator" | "reload" = "reload"): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.load();
			if (state.workerPid === null) return;
			const expected: WatchdogExpectedExit = {
				pid: state.workerPid,
				kind,
				reason,
				atMs: this.clock.now().getTime(),
			};
			await this.persist({ ...state, expectedExit: expected, updatedAtMs: this.clock.now().getTime() });
			await this.log("worker.stop.expected", { reason, kind, pid: expected.pid });
		});
	}

	async recordWorkerStarted(info: WorkerProcessInfo & { readonly generation?: number | null }): Promise<void> {
		await this.enqueue(async () => {
			const previous = await this.load();
			await this.recordWorkerStartedInternal(info, previous);
		});
	}

	private async recordWorkerStartedInternal(
		info: WorkerProcessInfo & { readonly generation?: number | null },
		state: WatchdogPersistentState,
	): Promise<WatchdogPersistentState> {
		const now = this.clock.now().getTime();
		// The Supervisor launch handle owns the host process id (the bwrap PID in
		// production). A Worker's PID-namespace id may be reported for diagnostics,
		// but it is never used for exit correlation, kill, or heartbeat leases.
		const hostPid = info.hostPid ?? info.pid;
		const reportedPid = info.hostPid === undefined ? (info.reportedPid ?? null) : info.pid;
		const retiredWorkerPids =
			state.workerPid !== null && state.workerPid !== hostPid
				? retirePid(state.retiredWorkerPids, state.workerPid)
				: state.retiredWorkerPids;
		const next = await this.persist({
			...state,
			phase: "starting",
			workerPid: hostPid,
			reportedWorkerPid: reportedPid,
			workerPidExplicit: info.hostPid !== undefined,
			retiredWorkerPids,
			generation: info.generation ?? state.generation,
			lastHeartbeatAtMs: null,
			leaseExpiresAtMs: now + this.heartbeatTimeoutMs,
			missedHeartbeats: 0,
			lastSequence: 0,
			workerHeartbeatState: null,
			sleepSuspended: false,
			expectedExit: null,
			recovery: null,
			lastWorkerStartedAtMs: now,
			operatorStopReason: null,
			updatedAtMs: now,
		});
		await this.log("worker.started", {
			pid: hostPid,
			reportedPid,
			generation: next.generation,
		});
		this.events?.emit("worker.ready", { pid: hostPid, generation: next.generation, atMs: now });
		return next;
	}

	async beginReload(input: {
		readonly attemptId: string;
		readonly candidateId: string;
		readonly generation: number;
		readonly digest: string;
		readonly deadlineMs: number;
	}): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.load();
			await this.persist({
				...state,
				phase: state.workerPid === null ? state.phase : "healthy",
				reload: {
					attemptId: input.attemptId,
					candidateId: input.candidateId,
					generation: input.generation,
					digest: input.digest,
					startedAtMs: this.clock.now().getTime(),
					deadlineMs: input.deadlineMs,
				},
				activeCandidateId: input.candidateId,
				generation: input.generation,
				updatedAtMs: this.clock.now().getTime(),
			});
			await this.log("reload.begin", {
				attemptId: input.attemptId,
				candidateId: input.candidateId,
				deadlineMs: input.deadlineMs,
			});
		});
	}

	async completeReload(input: { readonly attemptId: string; readonly generation: number; readonly digest: string }): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.load();
			if (state.reload?.attemptId !== input.attemptId) return;
			await this.persist({
				...state,
				reload: null,
				activeCandidateId: state.reload.candidateId,
				generation: input.generation,
				leaseExpiresAtMs:
					state.workerPid === null ? null : this.clock.now().getTime() + this.heartbeatTimeoutMs,
				phase: state.workerPid === null ? state.phase : "healthy",
				updatedAtMs: this.clock.now().getTime(),
			});
			await this.log("reload.complete", input);
		});
	}

	async failReload(input: { readonly attemptId: string; readonly reason: string }): Promise<void> {
		await this.enqueue(async () => {
			const state = await this.load();
			if (state.reload?.attemptId !== input.attemptId) return;
			await this.persist({
				...state,
				reload: null,
				phase: state.workerPid === null ? state.phase : "healthy",
				updatedAtMs: this.clock.now().getTime(),
			});
			await this.log("reload.fail", input);
		});
	}

	async recordHeartbeat(report: HeartbeatReport, now: Date): Promise<void> {
		await this.enqueue(async () => {
			let state = await this.load();
			const nowMs = now.getTime();
			if (state.phase === "stopped" || state.phase === "unrecoverable") return;
			if (!Number.isInteger(report.sequence) || !Number.isInteger(report.workerPid)) return;
			if (state.expectedExit?.kind === "watchdog" && state.expectedExit.pid === report.workerPid) {
				await this.log("heartbeat.killed-worker", { sequence: report.sequence, pid: report.workerPid });
				return;
			}
			if (state.workerPid !== report.workerPid) {
				if (state.workerPid === null) {
					state = {
						...state,
						workerPid: report.workerPid,
						workerPidExplicit: false,
						lastSequence: -1,
						lastHeartbeatAtMs: null,
						leaseExpiresAtMs: null,
					};
				} else {
					// A heartbeat must not replace the already launched host identity.
					await this.log("heartbeat.identity-mismatch", {
						sequence: report.sequence,
						pid: report.workerPid,
						currentPid: state.workerPid,
					});
					return;
				}
			}
			if (state.lastHeartbeatAtMs !== null && report.sequence <= state.lastSequence) {
				await this.log("heartbeat.duplicate", { sequence: report.sequence, pid: report.workerPid });
				return;
			}
			const sleeping = report.state === "sleeping";
			const multiplier = heartbeatLabel(report.state) ? this.busyLeaseMultiplier : 1;
			const lease = sleeping ? null : nowMs + this.heartbeatTimeoutMs * multiplier;
			let restartAttempts = state.restartAttempts;
			if (
				state.phase === "healthy" &&
				state.lastWorkerStartedAtMs !== null &&
				nowMs - state.lastWorkerStartedAtMs >= this.stableResetMs &&
				restartAttempts !== 0
			) {
				restartAttempts = 0;
			}
			state = await this.persist({
				...state,
				phase: state.recovery?.mode === "unrecoverable" ? state.phase : "healthy",
				lastHeartbeatAtMs: nowMs,
				leaseExpiresAtMs: lease,
				missedHeartbeats: 0,
				lastSequence: report.sequence,
				workerHeartbeatState: report.state,
				sleepSuspended: sleeping,
				generation: report.generation ?? state.generation,
				restartAttempts,
				expectedExit: null,
				updatedAtMs: nowMs,
			});
			this.events?.emit("worker.heartbeat", report);
			await this.log("heartbeat", {
				sequence: report.sequence,
				state: report.state,
				generation: report.generation,
			});
		});
	}

	async recordWorkerExit(
		exitCode: number | null,
		signal: string | null,
		now: Date,
		details: { readonly stderrTail?: string; readonly pid?: number } = {},
	): Promise<void> {
		await this.enqueue(async () => {
			let state = await this.load();
			let pid = details.pid ?? state.workerPid;
			this.events?.emit("worker.exit", { exitCode, signal, atMs: now.getTime() });
			if (details.pid !== undefined && state.workerPid !== null && details.pid !== state.workerPid) {
				if (state.workerPidExplicit || state.retiredWorkerPids.includes(details.pid)) {
					await this.log("worker.exit.stale", {
						pid: details.pid,
						currentPid: state.workerPid,
						exitCode,
						signal,
					});
					return;
				}
				// Legacy/ambiguous starts may have supplied only the Worker-reported
				// namespace id. The Supervisor's actual handle exit is authoritative
				// once; after adoption every other id is treated as stale.
				pid = details.pid;
				state = {
					...state,
					workerPid: details.pid,
					reportedWorkerPid: state.workerPid,
					workerPidExplicit: true,
				};
			}
			const expected = state.expectedExit;
			const matchesExpected = pid !== null && expected !== null && expected.pid === pid;
			if (matchesExpected && expected.kind === "operator") {
				await this.persist({
					...state,
					phase: "stopped",
					workerPid: null,
					retiredWorkerPids: retirePid(state.retiredWorkerPids, state.workerPid),
					leaseExpiresAtMs: null,
					sleepSuspended: false,
					expectedExit: null,
					reload: null,
					recovery: null,
					updatedAtMs: now.getTime(),
				});
				await this.log("worker.exit.operator", { exitCode, signal });
				return;
			}
			if (matchesExpected && expected.kind === "watchdog") {
				// Recovery was already initiated. Do not duplicate the incident/notification.
				await this.persist({
					...state,
					workerPid: null,
					retiredWorkerPids: retirePid(state.retiredWorkerPids, state.workerPid),
					leaseExpiresAtMs: null,
					sleepSuspended: false,
					expectedExit: null,
					updatedAtMs: now.getTime(),
				});
				await this.log("worker.exit.killed", { exitCode, signal });
				return;
			}
			if (matchesExpected && expected.kind === "reload") {
				const clean = exitCode === 0 || signal === "SIGTERM" || signal === "SIGINT";
				if (clean) {
					await this.persist({
						...state,
						phase: "starting",
						workerPid: null,
						retiredWorkerPids: retirePid(state.retiredWorkerPids, state.workerPid),
						leaseExpiresAtMs: null,
						sleepSuspended: false,
						expectedExit: null,
						updatedAtMs: now.getTime(),
					});
					await this.log("worker.exit.reload", { exitCode, signal });
					return;
				}
			}
			if (state.operatorStopReason !== null || state.phase === "stopped") {
				await this.persist({
					...state,
					phase: "stopped",
					workerPid: null,
					retiredWorkerPids: retirePid(state.retiredWorkerPids, state.workerPid),
					leaseExpiresAtMs: null,
					sleepSuspended: false,
					expectedExit: null,
					reload: null,
					updatedAtMs: now.getTime(),
				});
				await this.log("worker.exit.after.stop", { exitCode, signal });
				return;
			}
			if (signal === "SIGTERM" || signal === "SIGINT") {
				// A normal operator/service-manager SIGTERM is not a plugin crash.
				await this.persist({
					...state,
					phase: "stopped",
					operatorStopReason: `worker terminated by ${signal}`,
					workerPid: null,
					leaseExpiresAtMs: null,
					sleepSuspended: false,
					expectedExit: null,
					reload: null,
					recovery: null,
					updatedAtMs: now.getTime(),
				});
				await this.log("worker.exit.operator-signal", { signal });
				return;
			}
			if (pid === null) {
				await this.log("worker.exit.unattributed", { exitCode, signal });
				return;
			}
			const stderrTail = details.stderrTail ?? (await this.readWorkerStderr());
			const incident = this.createIncident(state, {
				reason: `worker exited unexpectedly (code=${String(exitCode)}, signal=${signal ?? "null"})`,
				exitCode,
				signal,
				stderrTail,
				atMs: now.getTime(),
			});
			state = {
				...state,
				workerPid: null,
				leaseExpiresAtMs: null,
				sleepSuspended: false,
				expectedExit: null,
				reload: null,
			};
			await this.initiateRecovery(state, incident);
		});
	}

	private createIncident(
		state: WatchdogPersistentState,
		input: {
			readonly reason: string;
			readonly exitCode: number | null;
			readonly signal: string | null;
			readonly stderrTail: string;
			readonly atMs: number;
		},
	): WatchdogIncidentRecord {
		const incidentId = `${state.workerPid ?? "none"}:${input.atMs}:${input.reason}`;
		return {
			incidentId,
			reason: input.reason,
			atMs: input.atMs,
			generation: state.reload?.generation ?? state.generation,
			candidateId: state.reload?.candidateId ?? state.activeCandidateId,
			exitCode: input.exitCode,
			signal: input.signal,
			stderrTail: boundedLog(input.stderrTail),
		};
	}

	private async readWorkerStderr(): Promise<string> {
		if (this.workerStderrPath === undefined) return "";
		return boundedLog(await readTail(this.workerStderrPath, MAX_NOTICE_LOG_BYTES));
	}

	private async initiateRecovery(state: WatchdogPersistentState, incident: WatchdogIncidentRecord): Promise<void> {
		if (state.phase === "unrecoverable" || state.phase === "stopped") return;
		if (state.lastIncident?.incidentId === incident.incidentId) return;
		const incidents = [...state.incidents, incident].slice(-20);
		const lkg = await this.recovery.getLkg();
		await this.log("watchdog.incident", {
			incidentId: incident.incidentId,
			reason: incident.reason,
			exitCode: incident.exitCode,
			signal: incident.signal,
			hasLkg: lkg !== null,
		});
		if (lkg === null) {
			await this.notifications.enqueueCrash({ incident, lkg: null, kind: "crash-no-lkg" }).catch((error) => {
				this.onDiagnostic(`Could not persist no-LKG recovery notice: ${String(error)}`);
			});
			const recovery: WatchdogRecoveryState = {
				incidentId: incident.incidentId,
				reason: incident.reason,
				attempts: 0,
				mode: "unrecoverable",
				nextAttemptAtMs: null,
				lastError: "no LKG snapshot; no fake rollback performed",
			};
			await this.persist({
				...state,
				phase: "unrecoverable",
				lastIncident: incident,
				incidents,
				recovery,
				leaseExpiresAtMs: null,
				updatedAtMs: this.clock.now().getTime(),
			});
			await this.log("watchdog.unrecoverable", { reason: "no LKG" });
			await this.recovery.onUnrecoverable?.(recovery.lastError ?? "no LKG").catch(() => undefined);
			return;
		}
		const attempt = state.restartAttempts + 1;
		try {
			await this.recovery.restoreLkg(lkg);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const exhausted = attempt > this.maxRestarts;
			const nextAt = exhausted ? null : this.clock.now().getTime() + this.backoffFor(attempt);
			const recovery: WatchdogRecoveryState = {
				incidentId: incident.incidentId,
				reason: incident.reason,
				attempts: attempt,
				mode: exhausted ? "unrecoverable" : "waiting",
				nextAttemptAtMs: nextAt,
				lastError: `LKG restore failed: ${message}`,
			};
			if (exhausted) {
				await this.notifications.enqueueCrash({ incident, lkg, kind: "rollback-failed" }).catch(() => undefined);
			}
			await this.persist({
				...state,
				phase: exhausted ? "unrecoverable" : "recovering",
				lastIncident: incident,
				incidents,
				recovery,
				restartAttempts: attempt,
				updatedAtMs: this.clock.now().getTime(),
			});
			await this.log("watchdog.restore.failed", { error: message, attempt });
			if (exhausted) await this.recovery.onUnrecoverable?.(recovery.lastError ?? "restore failed").catch(() => undefined);
			else this.scheduleRetry(nextAt);
			return;
		}
		await this.recovery.recordRollback?.(lkg, incident.reason).catch((error) => {
			this.onDiagnostic(`Could not record rollback in reload journal: ${String(error)}`);
		});
		const notice = await this.notifications.enqueueCrash({ incident, lkg, kind: "crash-rollback" }).catch((error) => {
			this.onDiagnostic(`Could not persist recovery notice: ${String(error)}`);
			return null;
		});
		const exhausted = attempt > this.maxRestarts;
		const nextAt = exhausted ? null : this.clock.now().getTime() + this.backoffFor(attempt);
		const recovery: WatchdogRecoveryState = {
			incidentId: incident.incidentId,
			reason: incident.reason,
			attempts: attempt,
			mode: exhausted ? "unrecoverable" : "waiting",
			nextAttemptAtMs: nextAt,
			lastError: null,
		};
		const nowMs = this.clock.now().getTime();
		await this.persist({
			...state,
			phase: exhausted ? "unrecoverable" : "rollback",
			lastIncident: incident,
			incidents,
			recovery,
			restartAttempts: attempt,
			expectedExit:
				state.workerPid === null
					? null
					: {
						pid: state.workerPid,
						kind: "watchdog",
						reason: incident.reason,
						atMs: nowMs,
					},
			leaseExpiresAtMs: null,
			sleepSuspended: false,
			activeCandidateId: lkg.candidateId,
			generation: lkg.generation,
			updatedAtMs: nowMs,
		});
		this.events?.emit("reload.rollback", { lkg, reason: incident.reason, atMs: nowMs });
		await this.log("watchdog.rollback", {
			lkgGeneration: lkg.generation,
			lkgCandidateId: lkg.candidateId,
			attempt,
			noticePending: notice?.notice.notificationId ?? null,
		});
		if (exhausted) {
			await this.recovery.onUnrecoverable?.("restart limit reached").catch(() => undefined);
			return;
		}
		this.scheduleRetry(nextAt);
	}

	private async attemptRestart(state: WatchdogPersistentState): Promise<void> {
		const recovery = state.recovery;
		if (recovery === null || recovery.mode === "unrecoverable") return;
		if (state.workerPid !== null && this.processTree.isAlive(state.workerPid)) {
			await this.processTree.killTree(state.workerPid, "SIGKILL");
			this.scheduleRetry(this.clock.now().getTime() + Math.min(this.restartBaseMs, 1_000));
			return;
		}
		const lkg = await this.recovery.getLkg();
		if (lkg === null) {
			const next = await this.persist({
				...state,
				phase: "unrecoverable",
				workerPid: null,
				recovery: {
					...recovery,
					mode: "unrecoverable",
					nextAttemptAtMs: null,
					lastError: "LKG disappeared during restart",
				},
				updatedAtMs: this.clock.now().getTime(),
			});
			await this.log("watchdog.restart.no-lkg", {});
			await this.recovery.onUnrecoverable?.(next.recovery?.lastError ?? "LKG disappeared").catch(() => undefined);
			return;
		}
		let rollbackReady = true;
		try {
			// Re-verify/reapply the exact LKG bytes before every launch. A recovery
			// resumed after a crash must never start from half-restored or old source.
			await this.recovery.restoreLkg(lkg);
		} catch (error) {
			rollbackReady = false;
			const message = error instanceof Error ? error.message : String(error);
			const attempt = recovery.attempts + 1;
			const exhausted = attempt > this.maxRestarts;
			const nextAt = exhausted ? null : this.clock.now().getTime() + this.backoffFor(attempt);
			if (exhausted && state.lastIncident !== null) {
				await this.notifications
					.enqueueCrash({ incident: state.lastIncident, lkg, kind: "rollback-failed" })
					.catch(() => undefined);
			}
			await this.persist({
				...state,
				phase: exhausted ? "unrecoverable" : "recovering",
				workerPid: null,
				restartAttempts: attempt,
				recovery: {
					incidentId: recovery.incidentId,
					reason: recovery.reason,
					attempts: attempt,
					mode: exhausted ? "unrecoverable" : "waiting",
					nextAttemptAtMs: nextAt,
					lastError: `LKG restore failed before restart: ${message}`,
				},
				updatedAtMs: this.clock.now().getTime(),
			});
			await this.log("watchdog.restore.failed", { error: message, attempt, phase: "restart" });
			if (exhausted) await this.recovery.onUnrecoverable?.(message).catch(() => undefined);
			else this.scheduleRetry(nextAt);
			return;
		}
		if (!rollbackReady) return;
		const starting = await this.persist({
			...state,
			phase: "recovering",
			workerPid: null,
			recovery: { ...recovery, mode: "restarting", nextAttemptAtMs: null, lastError: null },
			updatedAtMs: this.clock.now().getTime(),
		});
		try {
			const info: WorkerRestartInfo = await this.recovery.startFromSnapshot(lkg, recovery.reason);
			await this.recordWorkerStartedInternal(
				{
					pid: info.pid,
					...(info.reportedPid === undefined ? {} : { reportedPid: info.reportedPid }),
					startedAtMs: info.startedAtMs,
					generation: info.generation ?? lkg.generation,
				},
				{ ...starting, restartAttempts: recovery.attempts },
			);
			await this.log("watchdog.restarted", { pid: info.pid, attempt: recovery.attempts });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const attempt = recovery.attempts + 1;
			const exhausted = attempt > this.maxRestarts;
			const nextAt = exhausted ? null : this.clock.now().getTime() + this.backoffFor(attempt);
			const last = state.lastIncident;
			if (exhausted && last !== null) {
				await this.notifications
					.enqueueCrash({ incident: last, lkg, kind: "restart-failed" })
					.catch(() => undefined);
			}
			await this.persist({
				...starting,
				phase: exhausted ? "unrecoverable" : "rollback",
				restartAttempts: attempt,
				recovery: {
					incidentId: recovery.incidentId,
					reason: recovery.reason,
					attempts: attempt,
					mode: exhausted ? "unrecoverable" : "waiting",
					nextAttemptAtMs: nextAt,
					lastError: message,
				},
				updatedAtMs: this.clock.now().getTime(),
			});
			await this.log("watchdog.restart.failed", { error: message, attempt });
			if (exhausted) await this.recovery.onUnrecoverable?.(message).catch(() => undefined);
			else this.scheduleRetry(nextAt);
		}
	}

	async tick(now: Date = this.clock.now()): Promise<void> {
		await this.enqueue(async () => {
			let state = await this.load();
			if (state.phase === "stopped" || state.phase === "unrecoverable") return;
			const nowMs = now.getTime();
			if (
				state.restartAttempts !== 0 &&
				state.phase === "healthy" &&
				state.lastWorkerStartedAtMs !== null &&
				nowMs - state.lastWorkerStartedAtMs >= this.stableResetMs
			) {
				state = await this.persist({ ...state, restartAttempts: 0, updatedAtMs: nowMs });
			}
			if (
				state.recovery !== null &&
				state.recovery.mode !== "unrecoverable" &&
				state.recovery.nextAttemptAtMs !== null &&
				nowMs >= state.recovery.nextAttemptAtMs
			) {
				await this.attemptRestart(state);
				state = await this.load();
				if (state.phase === "stopped" || state.phase === "unrecoverable") return;
			}
			if (state.reload !== null && nowMs > state.reload.deadlineMs) {
				await this.handleReloadDeadline(state);
				return;
			}
			if (
				state.workerPid !== null &&
				state.leaseExpiresAtMs !== null &&
				nowMs > state.leaseExpiresAtMs &&
				!state.sleepSuspended
			) {
				const missed = state.missedHeartbeats + 1;
				this.events?.emit("worker.heartbeat.missed", {
					missed,
					lastHeartbeatAtMs: state.lastHeartbeatAtMs ?? 0,
					atMs: nowMs,
				});
				if (missed < this.missedHeartbeatLimit) {
					await this.persist({ ...state, phase: "suspect", missedHeartbeats: missed, updatedAtMs: nowMs });
					return;
				}
				const pid = state.workerPid;
				const stderrTail = await this.readWorkerStderr();
				await this.persist({
					...state,
					phase: "suspect",
					missedHeartbeats: missed,
					expectedExit: { pid, kind: "watchdog", reason: "heartbeat timeout", atMs: nowMs },
					updatedAtMs: nowMs,
				});
				this.events?.emit("watchdog.suspect", { missedHeartbeats: missed, atMs: nowMs });
				await this.processTree.killTree(pid, "SIGKILL").catch(() => undefined);
				const incident = this.createIncident(state, {
					reason: `heartbeat lost for more than ${this.heartbeatTimeoutMs}ms (event loop blocked)`,
					exitCode: null,
					signal: "SIGKILL",
					stderrTail,
					atMs: nowMs,
				});
				await this.initiateRecovery({ ...state, workerPid: pid, expectedExit: null }, incident);
			}
		});
	}

	private async handleReloadDeadline(state: WatchdogPersistentState): Promise<void> {
		const reload = state.reload;
		if (reload === null) return;
		const nowMs = this.clock.now().getTime();
		const pid = state.workerPid;
		const stderrTail = await this.readWorkerStderr();
		await this.recovery.onReloadTimeout?.({
			attemptId: reload.attemptId,
			reason: `reload deadline exceeded: ${reload.attemptId}`,
		}).catch((error) => this.onDiagnostic(`onReloadTimeout failed: ${String(error)}`));
		if (pid !== null) {
			await this.persist({
				...state,
				phase: "suspect",
				expectedExit: { pid, kind: "watchdog", reason: "reload deadline", atMs: nowMs },
				updatedAtMs: nowMs,
			});
			await this.processTree.killTree(pid, "SIGKILL").catch(() => undefined);
		}
		const incident = this.createIncident(state, {
			reason: `reload deadline exceeded for attempt ${reload.attemptId}`,
			exitCode: null,
			signal: pid === null ? null : "SIGKILL",
			stderrTail,
			atMs: nowMs,
		});
		await this.initiateRecovery({ ...state, reload: null, workerPid: pid, expectedExit: null }, incident);
	}
}
