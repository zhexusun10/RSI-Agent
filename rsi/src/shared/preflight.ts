import { RsiError } from "./errors.ts";
import type { ContentRevision } from "./hash.ts";
import { HEALTHY_TURNS_REQUIRED, PREFLIGHT_MOCK_LOAD_TIMEOUT_MS } from "./policy.ts";
import type { LkgSnapshot, PluginCandidate } from "./plugins.ts";

export { HEALTHY_TURNS_REQUIRED, PREFLIGHT_MOCK_LOAD_TIMEOUT_MS };

export type HasAssistants = { readonly role: string };

/** A candidate is an immutable, read-only, content-addressed snapshot. */
export interface ImmutableCandidate {
	readonly candidateId: string;
	readonly generation: number;
	readonly path: string;
	readonly digest: ContentRevision;
	readonly createdAtMs: number;
	readonly readOnly: true;
}

export interface PreflightCheckResult {
	readonly ok: boolean;
	readonly durationMs: number;
	readonly errors: readonly string[];
}

export interface PreflightReport {
	readonly candidateId: string;
	readonly generation: number;
	readonly digest: ContentRevision;
	readonly staticSyntaxCheck: PreflightCheckResult;
	readonly mockLoad: PreflightCheckResult;
	readonly ok: boolean;
	readonly completedAtMs: number;
	/** Sandbox-visible entry paths for a Worker-initiated session.reload. */
	readonly entryPaths?: readonly string[];
}

export interface ReloadHealthState {
	readonly attemptId: string;
	readonly candidateId: string;
	readonly generation: number;
	readonly digest: ContentRevision;
	readonly startedAtMs: number;
	readonly healthyTurns: number;
	readonly phase: "reloading" | "observing" | "promoted" | "rolled-back";
}

export interface HealthTurnObservation {
	readonly attemptId: string;
	readonly generation: number;
	readonly turnIndex: number;
	readonly stopReason: string;
	readonly aborted: boolean;
	readonly assistantMessages: number;
	readonly atMs: number;
}

/**
 * A healthy turn is a consecutive settled agent run: agent_settled was not
 * aborted, at least one assistant message exists, and the last assistant
 * message did not end with error or aborted. Tool-use turns are healthy.
 */
export function classifyHealthyTurn(observation: HealthTurnObservation): boolean {
	return (
		!observation.aborted &&
		observation.assistantMessages > 0 &&
		observation.stopReason !== "error" &&
		observation.stopReason !== "aborted"
	);
}

export interface HealthCountResult {
	readonly consecutiveHealthyTurns: number;
	readonly required: number;
	readonly readyToPromote: boolean;
}

/** Advance or reset the consecutive health counter. */
export function advanceHealthTurns(previous: number, healthy: boolean): HealthCountResult {
	const next = healthy ? Math.min(HEALTHY_TURNS_REQUIRED, previous + 1) : 0;
	return {
		consecutiveHealthyTurns: next,
		required: HEALTHY_TURNS_REQUIRED,
		readyToPromote: next >= HEALTHY_TURNS_REQUIRED,
	};
}

export interface PluginGenerationState {
	readonly version: 1;
	readonly activeGeneration: number | null;
	readonly activeDigest: ContentRevision | null;
	readonly health: ReloadHealthState | null;
	readonly lkg: LkgSnapshot | null;
	readonly updatedAtMs: number;
}

export function initialPluginGenerationState(now: Date): PluginGenerationState {
	return {
		version: 1,
		activeGeneration: null,
		activeDigest: null,
		health: null,
		lkg: null,
		updatedAtMs: now.getTime(),
	};
}

/** Preflight, load, and promotion must all observe the same candidate digest. */
export function assertCandidateDigest(
	candidate: Pick<ImmutableCandidate, "candidateId" | "digest">,
	actualDigest: ContentRevision,
): void {
	if (candidate.digest !== actualDigest) {
		throw new RsiError("CANDIDATE_CHANGED", `Candidate ${candidate.candidateId} changed after preflight.`, {
			details: { expected: candidate.digest, actual: actualDigest },
		});
	}
}

export function assertPluginCandidate(candidate: PluginCandidate): void {
	if (!candidate.readOnly) {
		throw new RsiError("PREFLIGHT_FAILED", "Plugin candidate must be read-only.");
	}
	if (!Number.isInteger(candidate.generation) || candidate.generation < 1) {
		throw new RsiError("PREFLIGHT_FAILED", "Plugin candidate generation must be a positive integer.");
	}
}

export interface WatchdogState {
	readonly version: 1;
	readonly workerPid: number | null;
	readonly generation: number | null;
	readonly lastHeartbeatAtMs: number | null;
	readonly leaseExpiresAtMs: number | null;
	readonly missedHeartbeats: number;
	readonly phase: "idle" | "healthy" | "suspect" | "rollback";
	readonly updatedAtMs: number;
}

export function isHeartbeatExpired(state: WatchdogState, now: Date): boolean {
	return state.leaseExpiresAtMs !== null && now.getTime() > state.leaseExpiresAtMs;
}
