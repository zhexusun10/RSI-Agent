import { randomUUID } from "node:crypto";
import { RsiError } from "../shared/errors.ts";
import type { HeartbeatReport } from "../shared/ipc/protocol.ts";
import type { AutonomousLoopPort, LoopPauseState, SleepGatePort } from "../shared/ports.ts";
import type { SleepState } from "../shared/sleep.ts";
import { formatLogTimestamp, formatTimestamp, type Clock } from "../shared/time.ts";
import {
	type ContinuationKind,
	type LoopState,
	type LoopStateStore,
	type PersistedContinuation,
	type PersistedSleepState,
} from "./state.ts";
import { scheduleAfterDelay, scheduleAtDeadline, type LoopTimerHandle, type LoopTimerPort } from "./timer.ts";

export type LoopPhase = "idle" | "running" | "sleeping" | "backoff" | "reloading" | "stopped";

export interface LoopWorkerRunRequest {
	readonly continuationId: string;
	readonly kind: ContinuationKind;
	readonly generation: number | null;
	readonly sessionId: string | null;
	/** Factual Runtime state only; this module never writes an Agent persona or instruction prompt. */
	readonly message: string;
	readonly atMs: number;
}

export interface LoopWorkerRunResult {
	readonly accepted: boolean;
	readonly runId?: string;
	readonly queued?: boolean;
	readonly detail?: string;
}

/**
 * Narrow Worker contract for the Supervisor-side loop. The real Worker must
 * dedupe `continuationId` and must call the model-request gate before every
 * provider request. The Supervisor never loads plugins.
 */
export interface LoopWorkerPort {
	currentGeneration(): number | null;
	currentSessionId(): string | null;
	hasQueuedTasks(): boolean | Promise<boolean>;
	startRuntimeTurn(request: LoopWorkerRunRequest): Promise<LoopWorkerRunResult>;
	abortActiveRun?(reason: string): Promise<void>;
}

export type LoopWorkerEvent =
	| {
			readonly type: "agent_settled";
			readonly runId: string;
			readonly generation: number | null;
			readonly sessionId: string | null;
			readonly aborted: boolean;
			readonly stopReason?: string;
			readonly queuedTasks?: boolean;
			readonly atMs?: number;
	  }
	| {
			readonly type: "run_started";
			readonly runId: string;
			readonly generation: number | null;
			readonly sessionId: string | null;
			readonly source: "runtime" | "sleep" | "operator" | "unknown";
			readonly atMs?: number;
	  }
	| {
			readonly type: "agent_end";
			readonly runId?: string;
			readonly willRetry?: boolean;
	  }
	| {
			readonly type: "session_changed";
			readonly generation: number | null;
			readonly sessionId: string | null;
			readonly atMs?: number;
	  }
	| { readonly type: "reload_started"; readonly reason?: string }
	| {
			readonly type: "reload_completed";
			readonly generation: number | null;
			readonly sessionId: string | null;
			readonly atMs?: number;
	  };

export interface LoopSleepPort extends SleepGatePort {
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface SleepWakeHook {
	wakeDueOnce(): Promise<void>;
}

export interface AutonomousLoopOptions {
	readonly clock: Clock;
	readonly timeZone: string;
	readonly store: LoopStateStore;
	readonly timers: LoopTimerPort;
	readonly worker: LoopWorkerPort;
	readonly sleep: LoopSleepPort;
	readonly sleepScheduler?: SleepWakeHook;
	readonly baseBackoffMs?: number;
	readonly maxBackoffMs?: number;
	readonly wakeMessage?: (input: {
		readonly kind: ContinuationKind;
		readonly at: Date;
		readonly timeZone: string;
	}) => string;
	readonly onError?: (error: unknown) => void;
}

const DEFAULT_BASE_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;
const MAX_SETTLED_MEMORY = 256;

/** Factual Runtime state text only. It does not contain an Agent prompt or persona. */
export function defaultRuntimeWakeMessage(input: {
	readonly kind: ContinuationKind;
	readonly at: Date;
	readonly timeZone: string;
}): string {
	return `Runtime state: ${input.kind} at ${formatTimestamp(input.at, input.timeZone)} ${input.timeZone}.`;
}

function isActiveSleep(sleep: PersistedSleepState | null): sleep is PersistedSleepState {
	return sleep?.status === "active";
}

function isPendingContinuation(continuation: PersistedContinuation | null): continuation is PersistedContinuation {
	return continuation?.status === "pending" || continuation?.status === "dispatching";
}

/**
 * Supervisor-owned autonomous loop state machine.
 *
 * Only an explicit SleepState pauses it. `agent_end` is ignored; the final
 * `agent_settled` is the only continuation trigger. A successful sleep request
 * cancels any queued Supervisor continuation, and the Worker-side model gate is
 * responsible for blocking native retries/continuations while the sleep record
 * remains active.
 */
export class AutonomousLoop implements AutonomousLoopPort {
	private readonly clock: Clock;
	private readonly timeZone: string;
	private readonly store: LoopStateStore;
	private readonly timers: LoopTimerPort;
	private readonly worker: LoopWorkerPort;
	private readonly sleep: LoopSleepPort;
	private readonly sleepScheduler: SleepWakeHook | undefined;
	private readonly baseBackoffMs: number;
	private readonly maxBackoffMs: number;
	private readonly wakeMessage: (input: {
		readonly kind: ContinuationKind;
		readonly at: Date;
		readonly timeZone: string;
	}) => string;
	private readonly onError: ((error: unknown) => void) | undefined;

	private started = false;
	private stopped = false;
	private reloadInProgress = false;
	private phase: LoopPhase = "idle";
	private lastState: LoopState | null = null;
	private lastSleep: PersistedSleepState | null = null;
	private continuationTimer: LoopTimerHandle | undefined;
	private continuationScheduled = false;
	private scheduledContinuationId: string | null = null;
	private dispatchingIds = new Set<string>();
	private settledRuns = new Set<string>();
	private activeRunId: string | null = null;
	private backoffAttempt = 0;
	private epoch = 0;

	constructor(options: AutonomousLoopOptions) {
		this.clock = options.clock;
		this.timeZone = options.timeZone;
		this.store = options.store;
		this.timers = options.timers;
		this.worker = options.worker;
		this.sleep = options.sleep;
		this.sleepScheduler = options.sleepScheduler;
		this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
		this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
		this.wakeMessage = options.wakeMessage ?? defaultRuntimeWakeMessage;
		this.onError = options.onError;
		if (!Number.isFinite(this.baseBackoffMs) || this.baseBackoffMs < 1) {
			throw new RsiError("CONFIG_INVALID", "baseBackoffMs must be a finite positive number.");
		}
		if (!Number.isFinite(this.maxBackoffMs) || this.maxBackoffMs < this.baseBackoffMs) {
			throw new RsiError("CONFIG_INVALID", "maxBackoffMs must be finite and at least baseBackoffMs.");
		}
	}

	async start(): Promise<void> {
		if (this.started && !this.stopped) return;
		this.started = true;
		this.stopped = false;
		this.reloadInProgress = false;
		this.epoch += 1;
		const epoch = this.epoch;
		const loaded = await this.store.read();
		this.lastState = loaded;
		this.lastSleep = loaded.sleep;
		if (loaded.stoppedReason !== null) {
			this.lastState = await this.store.update((state) => ({ ...state, stoppedReason: null }));
		}
		const currentGeneration = this.worker.currentGeneration();
		const currentSession = this.worker.currentSessionId();
		this.lastState = await this.store.update((state) => ({
			...state,
			generation: currentGeneration,
			sessionId: currentSession,
		}));
		this.lastSleep = this.lastState.sleep;
		if (isActiveSleep(this.lastSleep)) this.phase = "sleeping";
		await this.sleep.start();
		if (!this.started || this.stopped || epoch !== this.epoch) return;
		const state = await this.store.read();
		this.lastState = state;
		this.lastSleep = state.sleep;
		if (isActiveSleep(this.lastSleep)) {
			this.phase = "sleeping";
			return;
		}
		if (isPendingContinuation(state.continuation)) {
			await this.dispatchContinuation(state.continuation.id);
			return;
		}
		if (state.pendingOperatorInputs > 0) {
			this.phase = "idle";
			return;
		}
		if (await this.hasQueuedWork()) {
			this.phase = "idle";
			return;
		}
		// A due persisted sleep may have been delivered by sleep.start() and
		// already scheduled or started the one sleep-wake continuation.
		if (this.activeRunId !== null || this.continuationScheduled) return;
		await this.scheduleContinuation("runtime-wake", null, 0);
	}

	async stop(reason: string): Promise<void> {
		if (this.stopped) return;
		if (typeof reason !== "string" || reason.trim().length === 0) {
			throw new RsiError("INTERNAL", "stop reason must be a non-empty string.");
		}
		this.stopped = true;
		this.phase = "stopped";
		this.epoch += 1;
		this.clearContinuationTimer();
		this.continuationScheduled = false;
		this.scheduledContinuationId = null;
		const now = this.clock.now();
		try {
			this.lastState = await this.store.update((state) => {
				const continuation =
					state.continuation && isPendingContinuation(state.continuation)
						? {
								...state.continuation,
								status: "skipped" as const,
								error: `runtime stopped: ${reason}`,
							}
						: state.continuation;
				return {
					...state,
					stoppedReason: reason,
					continuation,
					updatedAtMs: now.getTime(),
				};
			});
			this.lastSleep = this.lastState.sleep;
		} catch (error) {
			this.reportError(error);
		}
		await this.sleep.stop();
		if (this.activeRunId && this.worker.abortActiveRun) {
			try {
				await this.worker.abortActiveRun(reason);
			} catch (error) {
				this.reportError(error);
			}
		}
		this.activeRunId = null;
		this.started = false;
	}

	async pauseForSleep(state: SleepState): Promise<void> {
		this.lastSleep = state as PersistedSleepState;
		this.phase = "sleeping";
		await this.cancelPendingContinuation("explicit-sleep-entered");
	}

	async resumeFromSleep(state: SleepState): Promise<void> {
		this.lastSleep = state as PersistedSleepState;
		if (state.status === "active") {
			this.phase = "sleeping";
			return;
		}
		await this.resumeAfterSleep();
	}

	/** Feed this into the Worker heartbeat report. Sleep is a live state, not a missed lease. */
	heartbeatState(): HeartbeatReport["state"] {
		if (this.phase === "stopped" || this.stopped) return "stopping";
		if (!this.started) return "starting";
		if (isActiveSleep(this.lastSleep)) return "sleeping";
		if (this.reloadInProgress || this.phase === "reloading") return "reloading";
		if (this.activeRunId !== null || this.phase === "running") return "busy";
		return "idle";
	}

	status(): LoopPauseState {
		if (this.phase === "stopped" || this.stopped) return { state: "stopped" };
		const sleep = this.lastSleep;
		if (isActiveSleep(sleep)) {
			return {
				state: "sleeping",
				reason: "explicit-sleep",
				sleepId: sleep.sleepId,
				deadlineMs: sleep.deadlineMs,
			};
		}
		return { state: "running" };
	}

	async handleWorkerEvent(event: LoopWorkerEvent): Promise<void> {
		switch (event.type) {
			case "agent_end":
				// Pi may still retry, compact, or drain queues after agent_end.
				return;
			case "agent_settled":
				await this.handleSettled(event);
				return;
			case "run_started":
				await this.handleRunStarted(event);
				return;
			case "session_changed":
				await this.updateRuntime(event.generation, event.sessionId);
				return;
			case "reload_started":
				await this.notifyReloadStarted(event.reason ?? "reload");
				return;
			case "reload_completed":
				await this.notifyReloadFinished(event.generation, event.sessionId);
				return;
		}
	}

	/** Record operator-originated input. It is delivered through Worker input, not a loop prompt. */
	async noteOperatorInput(_inputId?: string): Promise<void> {
		const state = await this.store.update((current) => ({
			...current,
			pendingOperatorInputs: current.pendingOperatorInputs + 1,
			lastError: null,
		}));
		this.lastState = state;
		if (this.continuationScheduled) {
			await this.cancelPendingContinuation("operator-input-pending");
		}
	}

	async updateRuntime(generation: number | null, sessionId: string | null): Promise<void> {
		const changed =
			this.lastState?.generation !== generation || this.lastState?.sessionId !== sessionId;
		this.lastState = await this.store.update((state) => ({ ...state, generation, sessionId }));
		if (!changed) return;
		this.epoch += 1;
		this.settledRuns.clear();
		this.activeRunId = null;
		this.backoffAttempt = 0;
		await this.cancelPendingContinuation("runtime-generation-changed");
		if (!this.started || this.stopped || this.reloadInProgress) return;
		if (isActiveSleep((await this.store.read()).sleep)) {
			this.phase = "sleeping";
			return;
		}
		if (await this.hasQueuedWork()) return;
		await this.scheduleContinuation("runtime-wake", null, 0);
	}

	async notifyReloadStarted(reason: string): Promise<void> {
		this.reloadInProgress = true;
		this.phase = "reloading";
		this.epoch += 1;
		this.clearContinuationTimer();
		this.continuationScheduled = false;
		this.scheduledContinuationId = null;
		await this.cancelPendingContinuation(`reload: ${reason}`);
	}

	async notifyReloadFinished(
		generation: number | null,
		sessionId: string | null,
		options: { readonly force?: boolean; readonly delayMs?: number } = {},
	): Promise<void> {
		this.reloadInProgress = false;
		this.phase = "idle";
		await this.updateRuntime(generation, sessionId);
		if (!this.started || this.stopped || this.reloadInProgress) return;
		if (isActiveSleep((await this.store.read()).sleep)) {
			this.phase = "sleeping";
			return;
		}
		if (!options.force && (await this.hasQueuedWork())) return;
		await this.scheduleContinuation("runtime-wake", null, options.delayMs ?? 0);
	}

	private async handleSettled(event: Extract<LoopWorkerEvent, { type: "agent_settled" }>): Promise<void> {
		if (this.settledRuns.has(event.runId)) return;
		const prior = await this.store.read();
		if (prior.lastSettledRunId === event.runId) return;
		this.settledRuns.add(event.runId);
		if (this.settledRuns.size > MAX_SETTLED_MEMORY) {
			const first = this.settledRuns.values().next().value;
			if (first !== undefined) this.settledRuns.delete(first);
		}
		const currentGeneration = this.worker.currentGeneration();
		const currentSession = this.worker.currentSessionId();
		if (currentGeneration !== null && event.generation !== null && event.generation !== currentGeneration) {
			return;
		}
		if (currentSession !== null && event.sessionId !== null && event.sessionId !== currentSession) {
			return;
		}
		if (this.activeRunId !== null && event.runId !== this.activeRunId) {
			return;
		}
		this.activeRunId = null;
		const state = await this.store.update((current) => ({
			...current,
			lastSettledRunId: event.runId,
			lastError: null,
		}));
		this.lastState = state;
		this.lastSleep = state.sleep;
		if (!this.started || this.stopped || this.reloadInProgress) return;
		if (isActiveSleep(state.sleep)) {
			this.phase = "sleeping";
			if (state.sleep.deadlineMs <= this.clock.now().getTime() && this.sleepScheduler) {
				await this.sleepScheduler.wakeDueOnce();
			}
			return;
		}
		if (event.aborted) {
			this.phase = "idle";
			return;
		}
		let queued = event.queuedTasks;
		if (queued === undefined) {
			try {
				queued = await this.worker.hasQueuedTasks();
			} catch (error) {
				this.reportError(error);
				await this.scheduleBackoff("technical-retry", event.runId);
				return;
			}
		}
		if (queued || state.pendingOperatorInputs > 0) {
			this.phase = "idle";
			return;
		}
		if (event.stopReason === "error") {
			await this.scheduleBackoff("technical-retry", event.runId);
			return;
		}
		await this.scheduleContinuation("runtime-wake", event.runId, 0);
	}

	private async handleRunStarted(
		event: Extract<LoopWorkerEvent, { type: "run_started" }>,
	): Promise<void> {
		this.activeRunId = event.runId;
		this.phase = "running";
		if (this.continuationScheduled) {
			await this.cancelPendingContinuation("run-already-started");
		}
		if (event.source === "operator") {
			this.lastState = await this.store.update((state) => ({
				...state,
				pendingOperatorInputs: Math.max(0, state.pendingOperatorInputs - 1),
			}));
		}
	}

	/** Called by SleepScheduler when a deadline or cancellation transitions the sleep record. */
	async handleSleepWake(notification?: { readonly sleep?: PersistedSleepState; readonly reason?: string }): Promise<void> {
		if (notification?.sleep) this.lastSleep = notification.sleep;
		await this.resumeAfterSleep();
	}

	private async resumeAfterSleep(): Promise<void> {
		if (!this.started || this.stopped) return;
		const state = await this.store.read();
		this.lastState = state;
		this.lastSleep = state.sleep;
		if (isActiveSleep(state.sleep)) {
			this.phase = "sleeping";
			return;
		}
		this.phase = "idle";
		if (this.activeRunId !== null) {
			// A native tool follow-up/continuation is still inside the same run and will resume
			// after the model gate opens; do not append a second runtime turn.
			this.phase = "running";
			return;
		}
		if (isPendingContinuation(state.continuation)) {
			await this.dispatchContinuation(state.continuation.id);
			return;
		}
		if (state.pendingOperatorInputs > 0) return;
		if (await this.hasQueuedWork()) return;
		await this.scheduleContinuation("sleep-wake", null, 0);
	}

	private async scheduleBackoff(kind: ContinuationKind, sourceRunId: string | null): Promise<void> {
		if (this.stopped || !this.started) return;
		const delay = this.nextBackoffDelay();
		await this.scheduleContinuation(kind, sourceRunId, delay);
	}

	private nextBackoffDelay(): number {
		const exponent = Math.min(this.backoffAttempt, 20);
		this.backoffAttempt += 1;
		return Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** exponent);
	}

	private async scheduleContinuation(
		kind: ContinuationKind,
		sourceRunId: string | null,
		delayMs: number,
	): Promise<void> {
		if (!this.started || this.stopped || this.reloadInProgress) return;
		if (this.continuationScheduled) return;
		const state = await this.store.read();
		if (isActiveSleep(state.sleep)) {
			this.phase = "sleeping";
			this.lastSleep = state.sleep;
			return;
		}
		if (isPendingContinuation(state.continuation)) {
			this.continuationScheduled = true;
			this.scheduledContinuationId = state.continuation.id;
			this.armContinuation(state.continuation.id, 0);
			return;
		}
		const now = this.clock.now();
		const continuation: PersistedContinuation = {
			id: `continuation-${randomUUID()}`,
			kind,
			createdAtMs: now.getTime(),
			status: "pending",
			sourceRunId,
			dispatchedAtMs: null,
			acceptedRunId: null,
			error: null,
		};
		const outcome = await this.store.transact((current) => {
			if (isPendingContinuation(current.continuation)) {
				return { state: current, result: current.continuation };
			}
			return {
				state: {
					...current,
					continuation,
					lastError: null,
				},
				result: continuation,
			};
		});
		this.lastState = outcome.state;
		this.continuationScheduled = true;
		this.scheduledContinuationId = outcome.result.id;
		this.phase = delayMs > 0 ? "backoff" : "idle";
		this.armContinuation(outcome.result.id, delayMs);
	}

	private armContinuation(id: string, delayMs: number): void {
		this.clearContinuationTimer();
		const epoch = this.epoch;
		const fire = (): void => {
			this.continuationTimer = undefined;
			if (epoch !== this.epoch) return;
			void this.dispatchContinuation(id).catch((error: unknown) => this.reportError(error));
		};
		this.continuationTimer =
			delayMs > 0
				? scheduleAfterDelay(delayMs, this.clock, this.timers, fire)
				: scheduleAtDeadline(this.clock.now().getTime(), this.clock, this.timers, fire);
	}

	private async dispatchContinuation(id: string): Promise<void> {
		if (this.dispatchingIds.has(id) || !this.started || this.stopped) return;
		if (this.reloadInProgress) return;
		const state = await this.store.read();
		const continuation = state.continuation;
		if (!continuation || continuation.id !== id || !isPendingContinuation(continuation)) return;
		this.lastState = state;
		if (isActiveSleep(state.sleep)) {
			if (state.sleep.deadlineMs <= this.clock.now().getTime() && this.sleepScheduler) {
				await this.sleepScheduler.wakeDueOnce();
			} else {
				this.phase = "sleeping";
				this.lastSleep = state.sleep;
			}
			return;
		}
		let queued: boolean;
		try {
			queued = await this.hasQueuedWork();
		} catch (error) {
			this.reportError(error);
			await this.markContinuationFailed(id, error);
			await this.scheduleBackoff("technical-retry", continuation.sourceRunId);
			return;
		}
		if (queued || state.pendingOperatorInputs > 0) {
			await this.markContinuationSkipped(id, queued ? "worker-queue-not-empty" : "operator-input-pending");
			this.phase = "idle";
			return;
		}
		this.dispatchingIds.add(id);
		this.clearContinuationTimer();
		this.continuationScheduled = false;
		this.scheduledContinuationId = null;
		const now = this.clock.now();
		try {
			const dispatching = await this.store.update((current) => {
				if (current.continuation?.id !== id) return current;
				return {
					...current,
					continuation: {
						...current.continuation,
						status: "dispatching",
						dispatchedAtMs: now.getTime(),
					},
				};
			});
			this.lastState = dispatching;
			const result = await this.worker.startRuntimeTurn({
				continuationId: id,
				kind: continuation.kind,
				generation: dispatching.generation,
				sessionId: dispatching.sessionId,
				message: this.wakeMessage({ kind: continuation.kind, at: now, timeZone: this.timeZone }),
				atMs: now.getTime(),
			});
			if (result.accepted) {
				this.activeRunId = result.runId ?? null;
				this.phase = "running";
				this.backoffAttempt = 0;
				this.lastState = await this.store.update((current) => {
					if (current.continuation?.id !== id) return current;
					return {
						...current,
						continuation: {
							...current.continuation,
							status: "accepted",
							acceptedRunId: result.runId ?? null,
							error: null,
						},
					};
				});
				return;
			}
			if (result.queued) {
				await this.markContinuationSkipped(id, "worker-queued");
				this.phase = "idle";
				return;
			}
			await this.markContinuationFailed(id, result.detail ?? "worker rejected runtime turn");
			await this.scheduleBackoff("technical-retry", continuation.sourceRunId);
		} catch (error) {
			this.reportError(error);
			await this.markContinuationFailed(id, error);
			await this.scheduleBackoff("technical-retry", continuation.sourceRunId);
		} finally {
			this.dispatchingIds.delete(id);
		}
	}

	private async markContinuationSkipped(id: string, reason: string): Promise<void> {
		this.lastState = await this.store.update((current) => {
			if (current.continuation?.id !== id) return current;
			return {
				...current,
				continuation: {
					...current.continuation,
					status: "skipped",
					error: reason,
				},
			};
		});
	}

	private async markContinuationFailed(id: string, error: unknown): Promise<void> {
		const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
		this.lastState = await this.store.update((current) => {
			if (current.continuation?.id !== id) return current;
			return {
				...current,
				lastError: message,
				continuation: {
					...current.continuation,
					status: "failed",
					error: message,
				},
			};
		});
	}

	private async cancelPendingContinuation(reason: string): Promise<void> {
		this.clearContinuationTimer();
		this.continuationScheduled = false;
		const id = this.scheduledContinuationId;
		this.scheduledContinuationId = null;
		const state = await this.store.read();
		const target = id ?? state.continuation?.id ?? null;
		if (!target) return;
		if (state.continuation?.id === target && isPendingContinuation(state.continuation)) {
			this.lastState = await this.store.update((current) => {
				if (current.continuation?.id !== target || !isPendingContinuation(current.continuation)) {
					return current;
				}
				return {
					...current,
					continuation: { ...current.continuation, status: "skipped", error: reason },
				};
			});
		}
	}

	private clearContinuationTimer(): void {
		this.continuationTimer?.cancel();
		this.continuationTimer = undefined;
	}

	private async hasQueuedWork(): Promise<boolean> {
		return this.worker.hasQueuedTasks();
	}

	private reportError(error: unknown): void {
		if (this.onError) this.onError(error);
		else console.error(`[rsi-loop] error at ${formatLogTimestamp(this.clock.now(), this.timeZone)}:`, error);
	}
}
