import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SleepGatePort } from "../shared/ports.ts";
import type { SleepGrant } from "../shared/ipc/protocol.ts";
import { SLEEP_TOOL_NAME, parseSleepRequest, type SleepRequestInput, type SleepState } from "../shared/sleep.ts";
import { formatTimestamp, type Clock } from "../shared/time.ts";
import type { WorkerToSupervisorEvents } from "../shared/ipc/protocol.ts";
import type { WorkerTelemetryEvent, WorkerTelemetryPort } from "./worker-types.ts";
import { TimedSleepWaiter, type SleepWaiter } from "./request-context.ts";

const sleepParameters = Type.Object({
	duration: Type.Optional(
		Type.String({ description: "Positive integer followed by s, m, or h. Mutually exclusive with until." }),
	),
	until: Type.Optional(
		Type.String({ description: "Absolute time YYYY/MM/DD HH:mm:ss. Mutually exclusive with duration." }),
	),
});

export type SleepToolInput = Static<typeof sleepParameters>;

export interface SleepEventSink {
	sendEvent<E extends "sleep.entered" | "sleep.woke">(
		event: E,
		payload: WorkerToSupervisorEvents[E],
	): void;
}

export interface SleepControllerOptions {
	readonly gate: SleepGatePort;
	readonly clock: Clock;
	readonly timeZone: string;
	readonly events?: SleepEventSink;
	readonly telemetry?: WorkerTelemetryPort;
}

/**
 * Owns the explicit sleep state for this process. It never pauses the event loop:
 * waits are timers, heartbeats continue, and every subsequent model request checks
 * the gate again so a native tool loop, queued follow-up, or continuity continuation
 * cannot slip a request in before the deadline.
 */
export class SleepController {
	readonly waiter: SleepWaiter;
	private readonly clock: Clock;
	private readonly timeZone: string;
	private readonly events: SleepEventSink | undefined;
	private readonly telemetry: WorkerTelemetryPort | undefined;
	private readonly woken = new Set<string>();
	private readonly cancellationBySleep = new Map<string, string>();
	private readonly cancelledSleepIds = new Set<string>();
	private readonly effectiveGate: SleepGatePort;
	private activeDeadline: number | undefined;
	private activeSleepId: string | undefined;
	private lastStatus: SleepState | null = null;

	constructor(options: SleepControllerOptions) {
		this.clock = options.clock;
		this.timeZone = options.timeZone;
		this.events = options.events;
		this.telemetry = options.telemetry;
		this.effectiveGate = {
			request: async (input, now, toolCallId) => await options.gate.request(input, now, toolCallId),
			status: async () => {
				const state = await options.gate.status();
				this.lastStatus = state;
				return state && this.cancelledSleepIds.has(state.sleepId)
					? { ...state, status: "cancelled" as const }
					: state;
			},
			cancel: async (reason, now) => await options.gate.cancel(reason, now),
		};
		this.waiter = new TimedSleepWaiter({
			gate: this.effectiveGate,
			clock: options.clock,
			onWake: (state) => this.emitWake(state),
		});
	}

	async status(): Promise<SleepState | null> {
		return await this.effectiveGate.status();
	}

	/**
	 * Load the Supervisor-owned sleep record before the first heartbeat.
	 * A Worker replacement during an explicit sleep must advertise `sleeping`;
	 * otherwise the Watchdog treats the intentionally idle Worker as a
	 * heartbeat failure. The persisted deadline remains authoritative.
	 */
	async restorePersistedState(): Promise<void> {
		const state = await this.effectiveGate.status();
		this.lastStatus = state;
		if (state?.status === "active") {
			this.activeDeadline = state.deadlineMs;
			this.activeSleepId = state.sleepId;
		} else {
			this.activeDeadline = undefined;
			this.activeSleepId = undefined;
		}
	}

	get sleeping(): boolean {
		const now = this.clock.now().getTime();
		if (this.activeDeadline !== undefined && now < this.activeDeadline) return true;
		return this.lastStatus?.status === "active" && now < this.lastStatus.deadlineMs;
	}

	cancel(reason: string): boolean {
		const sleepId = this.activeSleepId ?? this.lastStatus?.sleepId;
		const active = this.activeSleepId !== undefined || this.lastStatus?.status === "active";
		if (active && sleepId !== undefined) {
			this.cancellationBySleep.set(sleepId, reason);
			this.cancelledSleepIds.add(sleepId);
		}
		this.waiter.cancel(reason);
		this.activeDeadline = undefined;
		return active;
	}

	async cancelExternal(reason: string): Promise<boolean> {
		const state = await this.effectiveGate.status();
		const hadActive = state?.status === "active" || this.activeSleepId !== undefined;
		if (state !== null) {
			this.cancelledSleepIds.add(state.sleepId);
			this.cancellationBySleep.set(state.sleepId, reason);
		}
		this.cancel(reason);
		return hadActive;
	}

	async run(input: SleepRequestInput, toolCallId: string, signal?: AbortSignal): Promise<{
		readonly grant: SleepGrant;
		readonly completedAt: Date;
		readonly cancelled: boolean;
		readonly cancellationReason?: string;
	}> {
		// Validate the mutually-exclusive form before crossing the process boundary.
		parseSleepRequest(input);
		const now = this.clock.now();
		const grant = await this.effectiveGate.request(input, now, toolCallId);
		this.activeSleepId = grant.sleepId;
		this.lastStatus = grant.state;
		this.activeDeadline = grant.deadlineMs;
		this.woken.delete(grant.sleepId);
		this.events?.sendEvent("sleep.entered", {
			sleepId: grant.sleepId,
			deadlineMs: grant.deadlineMs,
			atMs: now.getTime(),
		});
		await this.emitTelemetry({ type: "sleep", state: grant.state, atMs: now.getTime() });

		let externallyCancelled = false;
		try {
			await this.waitForDeadline(grant, signal);
		} finally {
			const finalState = await this.effectiveGate.status().catch(() => null);
			externallyCancelled = finalState?.status === "cancelled";
			this.activeDeadline = undefined;
			this.activeSleepId = undefined;
			this.lastStatus =
				finalState?.status === "cancelled"
					? finalState
					: { ...grant.state, status: "completed", updatedAtMs: this.clock.now().getTime() };
		}
		const cancellationReason =
			this.cancellationBySleep.get(grant.sleepId) ??
			(externallyCancelled ? "external cancellation" : undefined);
		this.cancellationBySleep.delete(grant.sleepId);
		if (cancellationReason === undefined) {
			this.emitWake(grant.state);
		}
		return {
			grant,
			completedAt: this.clock.now(),
			cancelled: cancellationReason !== undefined,
			...(cancellationReason === undefined ? {} : { cancellationReason }),
		};
	}

	private async waitForDeadline(grant: SleepGrant, signal?: AbortSignal): Promise<void> {
		for (;;) {
			if (signal?.aborted) throw signal.reason ?? new Error("Sleep aborted");
			const now = this.clock.now();
			const remaining = grant.deadlineMs - now.getTime();
			if (remaining <= 0) return;
			const state = await this.effectiveGate.status();
			if (state?.status === "cancelled" || state?.status === "completed") return;
			if (state && state.sleepId !== grant.sleepId) return;
			await new Promise<void>((resolve, reject) => {
				let timer: NodeJS.Timeout | undefined;
				const cleanup = (): void => {
					if (timer !== undefined) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				};
				const finish = (): void => {
					cleanup();
					resolve();
				};
				const onAbort = (): void => {
					cleanup();
					reject(signal?.reason ?? new Error("Sleep aborted"));
				};
				timer = setTimeout(finish, Math.max(1, Math.min(remaining, 250)));
				signal?.addEventListener("abort", onAbort, { once: true });
			});
			const reason = this.cancellationBySleep.get(grant.sleepId);
			if (reason !== undefined) return;
		}
	}

	private emitWake(state: SleepState): void {
		if (this.woken.has(state.sleepId) || this.cancelledSleepIds.has(state.sleepId)) return;
		this.woken.add(state.sleepId);
		const at = this.clock.now();
		this.events?.sendEvent("sleep.woke", { sleepId: state.sleepId, atMs: at.getTime() });
		void this.emitTelemetry({ type: "sleep", state: { ...state, status: "completed", updatedAtMs: at.getTime() }, atMs: at.getTime() });
	}

	private async emitTelemetry(event: WorkerTelemetryEvent): Promise<void> {
		try {
			await this.telemetry?.emit(event);
		} catch {
			// Telemetry is not allowed to break sleep or the agent loop.
		}
	}

	formatDeadline(deadlineMs: number): string {
		return formatTimestamp(deadlineMs, this.timeZone);
	}
}

export function createSleepTool(controller: SleepController): ToolDefinition<typeof sleepParameters, unknown> {
	return {
		name: SLEEP_TOOL_NAME,
		label: "sleep",
		description: "Wait until a relative duration or an absolute time before continuing.",
		promptSnippet: "Wait before the next model request",
		parameters: sleepParameters,
		async execute(toolCallId, params, signal) {
			const run = await controller.run(params, toolCallId, signal);
			if (run.cancelled) {
				return {
					content: [
						{
							type: "text",
							text: `Sleep ${run.grant.sleepId} was cancelled: ${run.cancellationReason ?? "external cancellation"}.`,
						},
					],
					details: {
						sleepId: run.grant.sleepId,
						deadlineMs: run.grant.deadlineMs,
						cancelled: true,
					},
					isError: true,
					terminate: true,
				};
			}
			const nowText = controller.formatDeadline(run.completedAt.getTime());
			return {
				content: [
					{
						type: "text",
						text: `Slept until ${nowText} (${run.grant.timeZone}); sleep deadline ${controller.formatDeadline(run.grant.deadlineMs)}.`,
					},
				],
				details: {
					sleepId: run.grant.sleepId,
					deadlineMs: run.grant.deadlineMs,
					deadlineLocal: run.grant.deadlineLocal,
					timeZone: run.grant.timeZone,
					cancelled: false,
				},
			};
		},
	};
}
