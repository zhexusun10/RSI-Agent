import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RsiError } from "../shared/errors.ts";
import type { RuntimeEventPublisher } from "../shared/events.ts";
import type { SleepGrant } from "../shared/ipc/protocol.ts";
import type { SleepGatePort } from "../shared/ports.ts";
import {
	computeSleepDeadline,
	createSleepState,
	parseSleepRequest,
	SLEEP_TOOL_NAME,
	type SleepDeadline,
	type SleepRequestInput,
	type SleepState,
} from "../shared/sleep.ts";
import {
	assertValidTimeZone,
	daysInMonth,
	formatLogTimestamp,
	formatTimestamp,
	type Clock,
} from "../shared/time.ts";
import {
	type LoopStateStore,
	type PersistedSleepState,
} from "./state.ts";
import { scheduleAtDeadline, type LoopTimerHandle, type LoopTimerPort } from "./timer.ts";

export const SLEEP_DURATION_PATTERN_TEXT = "^([1-9][0-9]{0,14})([smh])$";
export const SLEEP_UNTIL_PATTERN_TEXT = "^[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$";

export interface ModelRequestGateContext {
	readonly generation: number | null;
	readonly sessionId: string | null;
	readonly requestId?: string;
}

/**
 * The Worker must call this before every conversational provider request,
 * including tool-result follow-ups, plugin continuations, queued messages, and
 * recovery after a restart. Waiting is asynchronous and does not block timers,
 * IPC, or heartbeat work.
 */
export interface ModelRequestGatePort {
	beforeModelRequest(context: ModelRequestGateContext, signal?: AbortSignal): Promise<void>;
}

export type SleepWakeReason = "deadline" | "cancelled";

export interface SleepWakeNotification {
	readonly sleep: PersistedSleepState;
	readonly wakeId: string;
	readonly reason: SleepWakeReason;
	readonly atMs: number;
}

export interface SleepSchedulerOptions {
	readonly clock: Clock;
	readonly timeZone: string;
	readonly store: LoopStateStore;
	readonly timers: LoopTimerPort;
	readonly events?: RuntimeEventPublisher;
	readonly generation?: () => number | null;
	readonly sessionId?: () => string | null;
	readonly onSleepEntered?: (sleep: PersistedSleepState) => void | Promise<void>;
	readonly onWake?: (notification: SleepWakeNotification) => void | Promise<void>;
	readonly onError?: (error: unknown) => void;
}

interface GateWaiter {
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enforce the public sleep schema: exactly the two optional fields, known keys only. */
export function assertSleepToolInput(input: unknown): asserts input is SleepRequestInput {
	if (!isRecord(input)) {
		throw new RsiError("SLEEP_INVALID", "sleep requires an object with exactly one of duration or until.");
	}
	for (const key of Object.keys(input)) {
		if (key !== "duration" && key !== "until") {
			throw new RsiError("SLEEP_INVALID", `Unknown sleep parameter: ${key}`);
		}
	}
	parseSleepRequest(input);
}

function withErrorStack(error: unknown, message: string): RsiError {
	const stack = error instanceof Error && error.stack ? error.stack : String(error);
	if (error instanceof RsiError) {
		return new RsiError(error.code, `${message}: ${error.message}`, {
			retryable: error.retryable,
			details: { stack, cause: error.message },
			cause: error,
		});
	}
	return new RsiError("SLEEP_INVALID", `${message}: ${error instanceof Error ? error.message : String(error)}`, {
		details: { stack },
		cause: error,
	});
}

function assertAbsoluteCivilFields(input: unknown): void {
	if (!isRecord(input) || typeof input.until !== "string") return;
	const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(input.until);
	if (!match) return;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (
		year < 1 ||
		year > 9999 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month) ||
		minute < 0 ||
		minute > 59 ||
		second < 0 ||
		second > 59 ||
		hour < 0 ||
		hour > 24 ||
		(hour === 24 && (minute !== 0 || second !== 0))
	) {
		throw new RsiError("SLEEP_INVALID", "until is not a valid civil date/time.");
	}
}

/** Shared deadline calculation plus civil-date and representable-Date checks. */
export function computeValidatedSleepDeadline(
	input: unknown,
	now: Date,
	timeZone: string,
): SleepDeadline {
	assertValidTimeZone(timeZone);
	if (Number.isNaN(now.getTime())) {
		throw new RsiError("SLEEP_INVALID", "now must be a valid instant.");
	}
	assertAbsoluteCivilFields(input);
	const deadline = computeSleepDeadline(input, now, timeZone);
	if (!Number.isFinite(new Date(deadline.deadlineMs).getTime())) {
		throw new RsiError("SLEEP_INVALID", "sleep deadline is outside the representable Date range.");
	}
	return deadline;
}

/**
 * Persistent explicit-sleep authority. It owns the sleep portion of the
 * external loop ledger, the long-delay timer, the model-request gate, and
 * exactly-once wake notification.
 */
export class SleepScheduler implements SleepGatePort, ModelRequestGatePort {
	private readonly clock: Clock;
	private readonly timeZone: string;
	private readonly store: LoopStateStore;
	private readonly timers: LoopTimerPort;
	private readonly events: RuntimeEventPublisher | undefined;
	private readonly generation: () => number | null;
	private readonly sessionId: () => string | null;
	private readonly onSleepEntered: ((sleep: PersistedSleepState) => void | Promise<void>) | undefined;
	private readonly onWake: ((notification: SleepWakeNotification) => void | Promise<void>) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private timer: LoopTimerHandle | undefined;
	private waiters = new Set<GateWaiter>();
	private wakeInFlight: Promise<void> | undefined;
	private stopped = false;

	constructor(options: SleepSchedulerOptions) {
		this.clock = options.clock;
		this.timeZone = assertValidTimeZone(options.timeZone);
		this.store = options.store;
		this.timers = options.timers;
		this.events = options.events;
		this.generation = options.generation ?? (() => null);
		this.sessionId = options.sessionId ?? (() => null);
		this.onSleepEntered = options.onSleepEntered;
		this.onWake = options.onWake;
		this.onError = options.onError;
	}

	/** Resume any persisted sleep. A due deadline is notified once, immediately. */
	async start(): Promise<void> {
		this.stopped = false;
		await this.recover();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.clearTimer();
		const waiters = [...this.waiters];
		this.waiters.clear();
		for (const waiter of waiters) {
			waiter.reject(new RsiError("SLEEP_INVALID", "Runtime is stopping; model request remains gated."));
		}
	}

	async request(input: SleepRequestInput, now: Date, _toolCallId?: string): Promise<SleepGrant> {
		if (this.stopped) {
			throw new RsiError("SLEEP_INVALID", "Runtime is stopping; sleep cannot be requested.");
		}
		assertSleepToolInput(input);
		const deadline = computeValidatedSleepDeadline(input, now, this.timeZone);
		const sleepId = `sleep-${randomUUID()}`;
		const sleepState = createSleepState({ sleepId, deadline, now });
		const record: PersistedSleepState = {
			...sleepState,
			generationAtRequest: this.generation(),
			wakeId: `runtime-wake:${sleepId}`,
			wakeNotifiedAtMs: null,
		};
		const outcome = await this.store.transact((state) => {
			if (state.sleep?.status === "active") {
				throw new RsiError("SLEEP_INVALID", "An explicit sleep is already active.", {
					details: { sleepId: state.sleep.sleepId, deadlineMs: state.sleep.deadlineMs },
				});
			}
			return {
				state: {
					...state,
					generation: this.generation(),
					sessionId: this.sessionId(),
					sleep: record,
					continuation: null,
					stoppedReason: null,
					lastError: null,
				},
				result: record,
			};
		});
		this.clearTimer();
		this.armDeadline(outcome.state.sleep?.deadlineMs ?? deadline.deadlineMs);
		this.events?.emit("sleep.requested", record);
		this.events?.emit("sleep.entered", record);
		this.events?.emit("loop.paused", {
			reason: "explicit-sleep",
			sleepId: record.sleepId,
			atMs: now.getTime(),
		});
		if (this.onSleepEntered) await this.onSleepEntered(record);
		return {
			accepted: true,
			sleepId: record.sleepId,
			deadlineMs: record.deadlineMs,
			deadlineLocal: formatTimestamp(record.deadlineMs, record.timeZone),
			timeZone: record.timeZone,
			state: record,
		};
	}

	async status(): Promise<SleepState | null> {
		const state = await this.store.read();
		return state.sleep;
	}

	async cancel(reason: string, now: Date): Promise<boolean> {
		if (typeof reason !== "string" || reason.trim().length === 0) {
			throw new RsiError("SLEEP_INVALID", "cancel reason must be a non-empty string.");
		}
		if (Number.isNaN(now.getTime())) {
			throw new RsiError("SLEEP_INVALID", "now must be a valid instant.");
		}
		const outcome = await this.store.transact((state) => {
			const sleep = state.sleep;
			if (!sleep || sleep.status !== "active") {
				return { state, result: null };
			}
			const cancelled: PersistedSleepState = {
				...sleep,
				status: "cancelled",
				updatedAtMs: now.getTime(),
				wakeNotifiedAtMs: now.getTime(),
			};
			return {
				state: { ...state, sleep: cancelled, continuation: null, lastError: null },
				result: cancelled,
			};
		});
		if (!outcome.persisted || !outcome.result) return false;
		this.clearTimer();
		this.resolveWaiters();
		this.events?.emit("sleep.woke", outcome.result);
		this.events?.emit("loop.resumed", {
			reason: "sleep-complete",
			sleepId: outcome.result.sleepId,
			atMs: now.getTime(),
		});
		if (this.onWake) {
			try {
				await this.onWake({
					sleep: outcome.result,
					wakeId: outcome.result.wakeId,
					reason: "cancelled",
					atMs: now.getTime(),
				});
			} catch (error) {
				this.reportError(error);
			}
		}
		return true;
	}

	async beforeModelRequest(_context: ModelRequestGateContext, signal?: AbortSignal): Promise<void> {
		for (;;) {
			if (signal?.aborted) {
				throw new RsiError("INTERNAL", "Model request was aborted while waiting for sleep.", { retryable: true });
			}
			if (this.stopped) {
				throw new RsiError("SLEEP_INVALID", "Runtime is stopping; model request is gated.");
			}
			const state = await this.store.read();
			const sleep = state.sleep;
			if (!sleep || sleep.status !== "active") return;
			const nowMs = this.clock.now().getTime();
			if (nowMs < sleep.deadlineMs) {
				if (!this.timer) this.armDeadline(sleep.deadlineMs);
				await this.waitForWake(signal);
				continue;
			}
			await this.wakeDueOnce();
			if (this.stopped) {
				throw new RsiError("SLEEP_INVALID", "Runtime is stopping; model request is gated.");
			}
			const after = await this.store.read();
			if (!after.sleep || after.sleep.status !== "active") return;
			// A replacement sleep may have been persisted between the wake and this check.
			if (after.sleep.sleepId !== sleep.sleepId) continue;
			return;
		}
	}

	/** Persist and deliver a due wake exactly once. Safe to call from timer, gate, or restart. */
	async wakeDueOnce(): Promise<void> {
		if (this.wakeInFlight) return this.wakeInFlight;
		this.wakeInFlight = this.performWakeDueOnce().finally(() => {
			this.wakeInFlight = undefined;
		});
		return this.wakeInFlight;
	}

	private async performWakeDueOnce(): Promise<void> {
		const now = this.clock.now();
		const outcome = await this.store.transact((state) => {
			const sleep = state.sleep;
			if (!sleep || sleep.status !== "active" || sleep.wakeNotifiedAtMs !== null) {
				return { state, result: null };
			}
			if (now.getTime() < sleep.deadlineMs) {
				return { state, result: null };
			}
			const completed: PersistedSleepState = {
				...sleep,
				status: "completed",
				updatedAtMs: now.getTime(),
				wakeNotifiedAtMs: now.getTime(),
			};
			return { state: { ...state, sleep: completed }, result: completed };
		});
		const sleep = outcome.state.sleep;
		if (!outcome.persisted || !outcome.result) {
			if (sleep?.status === "active" && now.getTime() < sleep.deadlineMs) {
				this.armDeadline(sleep.deadlineMs);
			}
			return;
		}
		this.clearTimer();
		this.events?.emit("sleep.woke", outcome.result);
		this.events?.emit("loop.resumed", {
			reason: "sleep-complete",
			sleepId: outcome.result.sleepId,
			atMs: now.getTime(),
		});
		this.resolveWaiters();
		if (this.onWake) {
			try {
				await this.onWake({
					sleep: outcome.result,
					wakeId: outcome.result.wakeId,
					reason: "deadline",
					atMs: now.getTime(),
				});
			} catch (error) {
				this.reportError(error);
			}
		}
	}

	private async recover(): Promise<void> {
		const state = await this.store.read();
		const sleep = state.sleep;
		if (!sleep || sleep.status !== "active") {
			this.clearTimer();
			return;
		}
		const nowMs = this.clock.now().getTime();
		if (nowMs < sleep.deadlineMs) {
			this.armDeadline(sleep.deadlineMs);
			if (this.onSleepEntered) {
				try {
					await this.onSleepEntered(sleep);
				} catch (error) {
					this.reportError(error);
				}
			}
			return;
		}
		await this.wakeDueOnce();
	}

	private armDeadline(deadlineMs: number): void {
		this.clearTimer();
		this.timer = scheduleAtDeadline(deadlineMs, this.clock, this.timers, () => {
			this.timer = undefined;
			void this.wakeDueOnce().catch((error: unknown) => this.reportError(error));
		});
	}

	private clearTimer(): void {
		this.timer?.cancel();
		this.timer = undefined;
	}

	private waitForWake(signal?: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const waiter: GateWaiter = {
				resolve: () => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			};
			const onAbort = (): void => {
				this.waiters.delete(waiter);
				waiter.reject(new RsiError("INTERNAL", "Model request was aborted while sleeping.", { retryable: true }));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.waiters.add(waiter);
		});
	}

	private resolveWaiters(): void {
		const waiters = [...this.waiters];
		this.waiters.clear();
		for (const waiter of waiters) waiter.resolve();
	}

	private reportError(error: unknown): void {
		if (this.onError) this.onError(error);
		else console.error(`[rsi-loop] sleep scheduler error at ${formatLogTimestamp(this.clock.now(), this.timeZone)}:`, error);
	}
}

export const SLEEP_TOOL_PARAMETERS = Type.Object(
	{
		duration: Type.Optional(
			Type.String({
				description: "Positive integer duration with s, m, or h, for example 30s, 5m, or 2h.",
				pattern: SLEEP_DURATION_PATTERN_TEXT,
			}),
		),
		until: Type.Optional(
			Type.String({
				description: "Absolute time in YYYY/MM/DD HH:mm:ss in the runtime time zone.",
				pattern: SLEEP_UNTIL_PATTERN_TEXT,
			}),
		),
	},
	{ additionalProperties: false },
);

export interface SleepToolSuccessDetails {
	readonly sleepId: string;
	readonly deadlineMs: number;
	readonly deadlineLocal: string;
	readonly timeZone: string;
}

export interface SleepToolErrorDetails {
	readonly error: true;
	readonly code: string;
	readonly message: string;
	readonly stack: string;
}

export type SleepToolDetails = SleepToolSuccessDetails | SleepToolErrorDetails;

export function createSleepTool(
	scheduler: SleepGatePort,
	clock: Clock,
): ToolDefinition<typeof SLEEP_TOOL_PARAMETERS, SleepToolDetails> {
	return {
		name: SLEEP_TOOL_NAME,
		label: "Sleep",
		description:
			"Pause the autonomous runtime until a relative duration or an absolute wall-clock deadline. Exactly one of duration or until is required.",
		parameters: SLEEP_TOOL_PARAMETERS,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			try {
				if (signal?.aborted) {
					throw new RsiError("SLEEP_INVALID", "Sleep request was aborted.");
				}
				assertSleepToolInput(params);
				const grant = await scheduler.request(params, clock.now(), _toolCallId);
				return {
					content: [
						{
							type: "text",
							text: `Sleep accepted: ${grant.sleepId}. Wake deadline: ${grant.deadlineLocal} ${grant.timeZone}.`,
						},
					],
					details: {
						sleepId: grant.sleepId,
						deadlineMs: grant.deadlineMs,
						deadlineLocal: grant.deadlineLocal,
						timeZone: grant.timeZone,
					},
				};
			} catch (error) {
				const failure = withErrorStack(error, "Sleep request failed");
				const details = failure.details as { stack?: string } | undefined;
				const stack = details?.stack ?? failure.stack ?? failure.message;
				return {
					content: [{ type: "text", text: `${failure.message}
${stack}` }],
					details: {
						error: true,
						code: failure.code,
						message: failure.message,
						stack,
					},
					isError: true,
				};
			}
		},
	};
}

/**
 * Adapter for Pi's low-level `prepareRequest` hook. The Worker must install
 * this on the agent loop so every provider request, including a native
 * tool-result follow-up or plugin continuation, waits for the sleep gate.
 */
export function createPiPrepareRequestGate(
	gate: ModelRequestGatePort,
	getContext: () => { readonly generation: number | null; readonly sessionId: string | null },
): (request: unknown, signal?: AbortSignal) => Promise<void> {
	return async (_request: unknown, signal?: AbortSignal): Promise<void> => {
		const context = getContext();
		await gate.beforeModelRequest(context, signal);
	};
}
