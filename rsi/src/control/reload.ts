import { randomUUID } from "node:crypto";
import { RsiError, type RsiErrorCode } from "../shared/errors.ts";
import type { RuntimeEventPublisher } from "../shared/events.ts";
import type { PreflightReport } from "../shared/preflight.ts";
import type { WorkerIpcClient } from "../shared/ipc/port.ts";
import type { Clock } from "../shared/time.ts";
import { assertCandidateId, assertControlReason } from "./protocol.ts";
import type { ControlSource } from "./protocol.ts";

export interface ReloadPreflightInput {
	readonly reason: string;
	readonly candidateId?: string;
}

export interface ReloadPreflightPort {
	preflight(input: ReloadPreflightInput, signal?: AbortSignal): Promise<PreflightReport>;
}

export interface ReloadApplyPlan {
	readonly report: PreflightReport;
	readonly requestId: string;
	readonly reason: string;
	readonly approvedGeneration: number;
	readonly source: ControlSource;
}

export interface ReloadApplyResult {
	readonly generation: number;
	readonly detail?: string;
	readonly attemptId?: string;
}

export interface ReloadApplyPort {
	apply(plan: ReloadApplyPlan): Promise<ReloadApplyResult>;
}

export interface ReloadRequest {
	readonly requestId: string;
	readonly reason: string;
	readonly candidateId?: string;
	readonly source: ControlSource;
	readonly generation: number | null;
	readonly sessionId: string | null;
}

export interface ReloadOutcome {
	readonly generation: number;
	readonly detail: string;
	readonly attemptId?: string;
	readonly report: PreflightReport;
}

export interface ReloadCoordinatorOptions {
	readonly clock: Clock;
	readonly preflight: ReloadPreflightPort;
	readonly apply: ReloadApplyPort;
	readonly currentGeneration: () => number | null;
	readonly events?: RuntimeEventPublisher;
}

interface InFlightReload {
	readonly requestId: string;
	readonly fingerprint: string;
	readonly promise: Promise<ReloadOutcome>;
}

function fingerprint(input: ReloadRequest): string {
	return JSON.stringify({
		reason: input.reason,
		candidateId: input.candidateId ?? null,
		source: input.source,
		generation: input.generation,
		sessionId: input.sessionId,
	});
}

function withStack(error: unknown, code: RsiErrorCode, prefix: string): RsiError {
	if (error instanceof RsiError) {
		const stack = error.stack ?? error.message;
		return new RsiError(error.code, `${prefix}: ${error.message}`, {
			retryable: error.retryable,
			details: { stack, cause: error.message },
			cause: error,
		});
	}
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? error.stack ?? message : message;
	return new RsiError(code, `${prefix}: ${message}`, {
		retryable: true,
		details: { stack },
		cause: error,
	});
}

/**
 * One external reload gate used by Supervisor commands, the Agent slash tool,
 * and the Worker's extension command-context reload binding. Preflight and
 * generation approval always happen before `apply` may call the raw reload.
 */
export class ReloadCoordinator {
	private readonly clock: Clock;
	private readonly preflightPort: ReloadPreflightPort;
	private readonly applyPort: ReloadApplyPort;
	private readonly currentGeneration: () => number | null;
	private readonly events: RuntimeEventPublisher | undefined;
	private inFlight: InFlightReload | undefined;

	constructor(options: ReloadCoordinatorOptions) {
		this.clock = options.clock;
		this.preflightPort = options.preflight;
		this.applyPort = options.apply;
		this.currentGeneration = options.currentGeneration;
		this.events = options.events;
	}

	generation(): number | null {
		return this.currentGeneration();
	}

	get busy(): boolean {
		return this.inFlight !== undefined;
	}

	async request(input: ReloadRequest): Promise<ReloadOutcome> {
		const reason = assertControlReason(input.reason);
		const candidateId =
			input.candidateId === undefined ? undefined : assertCandidateId(input.candidateId);
		const normalized: ReloadRequest = {
			...input,
			reason,
			...(candidateId === undefined ? {} : { candidateId }),
		};
		const requestFingerprint = fingerprint(normalized);
		if (this.inFlight) {
			if (
				this.inFlight.requestId === normalized.requestId &&
				this.inFlight.fingerprint === requestFingerprint
			) {
				return this.inFlight.promise;
			}
			throw new RsiError("RELOAD_FAILED", "Another reload is already in progress.", {
				retryable: true,
				details: { inFlightRequestId: this.inFlight.requestId },
			});
		}
		const promise = this.perform(normalized);
		this.inFlight = {
			requestId: normalized.requestId,
			fingerprint: requestFingerprint,
			promise,
		};
		try {
			return await promise;
		} finally {
			if (this.inFlight?.requestId === normalized.requestId) this.inFlight = undefined;
		}
	}

	private async perform(input: ReloadRequest): Promise<ReloadOutcome> {
		const startGeneration = this.currentGeneration();
		if (input.generation !== null && startGeneration !== null && input.generation !== startGeneration) {
			throw new RsiError("RELOAD_FAILED", "Reload request belongs to a stale session generation.", {
				retryable: true,
				details: {
					requestedGeneration: input.generation,
					currentGeneration: startGeneration,
				},
			});
		}
		let report: PreflightReport;
		try {
			report = await this.preflightPort.preflight({
				reason: input.reason,
				...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
			});
		} catch (error) {
			throw withStack(error, "PREFLIGHT_FAILED", "Reload preflight failed");
		}
		this.events?.emit("reload.preflight", report);
		if (!report.ok) {
			throw new RsiError("PREFLIGHT_FAILED", "Reload preflight rejected the candidate.", {
				details: {
					candidateId: report.candidateId,
					generation: report.generation,
					errors: [...report.staticSyntaxCheck.errors, ...report.mockLoad.errors],
					stack: "preflight report ok=false",
				},
			});
		}
		const afterPreflight = this.currentGeneration();
		if (afterPreflight !== startGeneration) {
			throw new RsiError("CANDIDATE_CHANGED", "Runtime generation changed while preflight was running.", {
				details: {
					startGeneration,
					afterPreflight,
					candidateId: report.candidateId,
					digest: report.digest,
				},
			});
		}
		if (startGeneration !== null && report.generation < startGeneration) {
			throw new RsiError("CANDIDATE_CHANGED", "Preflight candidate generation is older than the active generation.", {
				details: { startGeneration, candidateGeneration: report.generation },
			});
		}
		const approvedGeneration = report.generation;
		this.events?.emit("reload.started", {
			attemptId: input.requestId,
			generation: approvedGeneration,
			candidateDigest: report.digest,
			atMs: this.clock.now().getTime(),
		});
		let applied: ReloadApplyResult;
		try {
			applied = await this.applyPort.apply({
				report,
				requestId: input.requestId,
				reason: input.reason,
				approvedGeneration,
				source: input.source,
			});
		} catch (error) {
			throw withStack(error, "RELOAD_FAILED", "Approved reload failed");
		}
		return {
			generation: applied.generation,
			detail:
				applied.detail ??
				`Reload approved and applied for generation ${applied.generation} (candidate ${report.candidateId}).`,
			...(applied.attemptId === undefined ? {} : { attemptId: applied.attemptId }),
			report,
		};
	}
}

export interface WorkerReloadCoordinatorOptions {
	readonly clock: Clock;
	readonly ipc: WorkerIpcClient;
	/** Raw session reload. Only the coordinator's apply step may invoke this. */
	readonly reload: () => Promise<void>;
	readonly currentGeneration: () => number | null;
	readonly events?: RuntimeEventPublisher;
}

/**
 * Worker-side adapter. It uses the public Worker IPC preflight/start/failed
 * methods, then invokes the raw Pi reload only after the Supervisor returns an
 * approved preflight generation.
 */
export function createWorkerReloadCoordinator(
	options: WorkerReloadCoordinatorOptions,
): ReloadCoordinator {
	const preflight: ReloadPreflightPort = {
		async preflight(input, signal) {
			return options.ipc.request(
				"reload.preflight",
				{
					reason: input.reason,
					requestedBy: "worker",
					...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
				},
				{ ...(signal === undefined ? {} : { signal }) },
			);
		},
	};
	const apply: ReloadApplyPort = {
		async apply(plan) {
			const started = await options.ipc.request("reload.started", {
				preflightId: plan.report.candidateId,
				candidateId: plan.report.candidateId,
				digest: plan.report.digest,
			});
			try {
				await options.reload();
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				await options.ipc
					.request("reload.failed", { attemptId: started.attemptId, reason })
					.catch(() => undefined);
				throw error;
			}
			return {
				generation: plan.approvedGeneration,
				detail: `Reload completed for generation ${plan.approvedGeneration}.`,
				attemptId: started.attemptId,
			};
		},
	};
	return new ReloadCoordinator({
		clock: options.clock,
		preflight,
		apply,
		currentGeneration: options.currentGeneration,
		...(options.events === undefined ? {} : { events: options.events }),
	});
}

export interface GuardedReloadOptions {
	readonly reason?: string;
	readonly currentGeneration: () => number | null;
	readonly currentSessionId: () => string | null;
}

/**
 * Build a replacement for Pi's `commandContextActions.reload`. Extensions that
 * call `ctx.reload()` therefore pass through the same external gate as the
 * `/reload` tool instead of directly reloading Pi.
 */
export function createGuardedReloadAction(
	coordinator: ReloadCoordinator,
	options: GuardedReloadOptions,
): () => Promise<void> {
	return async () => {
		await coordinator.request({
			requestId: randomUUID(),
			reason: options.reason ?? "extension ctx.reload",
			source: "worker-shim",
			generation: options.currentGeneration(),
			sessionId: options.currentSessionId(),
		});
	};
}
