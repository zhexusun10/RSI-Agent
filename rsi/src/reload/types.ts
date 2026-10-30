import type { ContentRevision } from "../shared/hash.ts";
import type { PluginCandidate, LkgSnapshot, VerifiedPluginPin } from "../shared/plugins.ts";
import type { HealthTurnObservation, PreflightReport } from "../shared/preflight.ts";
import type { RsiJsonValue } from "../shared/json.ts";

export const RELOAD_MANIFEST_VERSION = 1 as const;
export const RELOAD_MANIFEST_FILENAME = "candidate.json";
export const RELOAD_PAYLOAD_DIRNAME = "payload" as const;
export const RELOAD_STATIC_CHECK_TIMEOUT_MS = 10_000;
export const RELOAD_MOCK_LOAD_TIMEOUT_MS = 3_000;
export const RELOAD_MOCK_SETTLE_MS = 250;
export const RELOAD_KILL_GRACE_MS = 750;
export const RELOAD_MAX_CHILD_OUTPUT_BYTES = 131_072;
export const RELOAD_MAX_CHILD_STDERR_BYTES = 16_384;

export type CandidateDiscoveryMode = "extension" | "extensions" | "explicit";

export interface CandidateSourceRootInput {
	/** Stable safe identifier used in the immutable payload path. */
	readonly id: string;
	/** Absolute path to a dedicated extension package or extensions directory. */
	readonly path: string;
	/** "extension" resolves one package/index; "extensions" mirrors Pi's one-level discovery. */
	readonly discovery?: CandidateDiscoveryMode;
	/** When discovery is "explicit", these paths are relative to path. */
	readonly entries?: readonly string[];
}

export interface CandidatePrepareInput {
	readonly generation: number;
	readonly sourceRoots: readonly CandidateSourceRootInput[];
	readonly trustedDependencyRoots?: readonly string[];
	readonly packages?: readonly VerifiedPluginPin[];
	readonly now: Date;
	/** Bootstrap-only allowance for an empty agent plugin source root. */
	readonly allowEmpty?: boolean;
	/** Fault-injection seam for deterministic concurrent-source tests. */
	readonly hooks?: {
		readonly beforeSourceRecheck?: () => Promise<void>;
	};
}

export interface CandidateManifestSource {
	readonly id: string;
	readonly originalPath: string;
	readonly discovery: CandidateDiscoveryMode;
	/** Candidate-relative payload directory. */
	readonly payloadPath: string;
	/** Entry paths relative to originalPath. */
	readonly entries: readonly string[];
}

export interface CandidateManifest {
	readonly version: typeof RELOAD_MANIFEST_VERSION;
	readonly createdBy: "rsi-agent/reload";
	readonly candidateId: string;
	readonly generation: number;
	readonly digest: ContentRevision;
	readonly createdAtMs: number;
	readonly payloadRoot: typeof RELOAD_PAYLOAD_DIRNAME;
	/** Candidate-relative paths in stable order. */
	readonly entries: readonly string[];
	readonly sources: readonly CandidateManifestSource[];
	readonly trustedDependencyRoots: readonly string[];
	readonly packages: readonly VerifiedPluginPin[];
	readonly fileCount: number;
	readonly totalBytes: number;
}

/** A candidate with its trusted immutable manifest. */
export interface ReloadCandidate extends PluginCandidate {
	readonly manifest: CandidateManifest;
}

export interface CandidateLimits {
	readonly maxFiles: number;
	readonly maxFileBytes: number;
	readonly maxTotalBytes: number;
}

export const DEFAULT_CANDIDATE_LIMITS: CandidateLimits = Object.freeze({
	maxFiles: 2_000,
	maxFileBytes: 4 * 1024 * 1024,
	maxTotalBytes: 64 * 1024 * 1024,
});

export interface CandidateVerification {
	readonly manifest: CandidateManifest;
	readonly digest: ContentRevision;
	readonly candidate: ReloadCandidate;
}

export interface RestoreRootAllowlist {
	/** Absolute plugin/source roots the Supervisor allows this store to replace. */
	readonly roots: readonly string[];
	/** Paths which must never be restored, such as markdowns and user documents. */
	readonly forbiddenRoots?: readonly string[];
}

export interface RestoreInterruptionReport {
	readonly recovered: readonly string[];
	readonly committed: readonly string[];
	readonly cleaned: readonly string[];
	readonly errors: readonly string[];
}

export interface PreflightDiagnostics {
	readonly staticSyntaxCheck: {
		readonly timedOut: boolean;
		readonly exitCode: number | null;
		readonly signal: string | null;
		readonly stderr: string;
	};
	readonly mockLoad: {
		readonly timedOut: boolean;
		readonly exitCode: number | null;
		readonly signal: string | null;
		readonly stderr: string;
	};
}

export interface PreflightOutcome {
	readonly report: PreflightReport;
	readonly diagnostics: PreflightDiagnostics;
}

export type ReloadAttemptPhase =
	| "prepared"
	| "validated"
	| "reloading"
	| "probation"
	| "promoted"
	| "baseline"
	| "failed"
	| "rolled-back";

export interface ReloadActiveState {
	readonly candidateId: string;
	readonly generation: number;
	readonly digest: ContentRevision;
	readonly path: string;
	readonly attemptId: string;
	readonly phase: "probation" | "promoted" | "baseline";
	readonly loadedAtMs: number;
}

export interface ReloadPendingCandidate {
	readonly candidateId: string;
	readonly generation: number;
	readonly digest: ContentRevision;
	readonly path: string;
	readonly phase: "prepared" | "validated";
	readonly preparedAtMs: number;
	readonly preflight?: PreflightReport;
}

export interface ReloadInProgress {
	readonly attemptId: string;
	readonly candidateId: string;
	readonly generation: number;
	readonly digest: ContentRevision;
	readonly path: string;
	readonly startedAtMs: number;
	readonly deadlineMs: number;
}

export interface ReloadFailureRecord {
	readonly attemptId: string;
	readonly candidateId: string;
	readonly generation: number;
	readonly digest: ContentRevision;
	readonly failedAtMs: number;
	readonly phase: ReloadAttemptPhase;
	readonly reason: string;
	readonly diagnostics?: readonly string[];
}

export interface ReloadHistoryEntry {
	readonly attemptId: string;
	readonly candidateId: string;
	readonly generation: number;
	readonly digest: ContentRevision;
	readonly phase: ReloadAttemptPhase;
	readonly atMs: number;
	readonly reason?: string;
}

export interface ReloadPersistentState {
	readonly version: 1;
	readonly active: ReloadActiveState | null;
	readonly pending: ReloadPendingCandidate | null;
	readonly reloading: ReloadInProgress | null;
	readonly health: {
		readonly attemptId: string;
		readonly candidateId: string;
		readonly generation: number;
		readonly digest: ContentRevision;
		readonly healthyTurns: number;
		readonly lastTurnKey: string | null;
		readonly lastTurnIndex: number | null;
		readonly startedAtMs: number;
	} | null;
	readonly lkg: LkgSnapshot | null;
	readonly lastFailure: ReloadFailureRecord | null;
	readonly history: readonly ReloadHistoryEntry[];
	readonly updatedAtMs: number;
}

export function initialReloadPersistentState(now: Date): ReloadPersistentState {
	return {
		version: 1,
		active: null,
		pending: null,
		reloading: null,
		health: null,
		lkg: null,
		lastFailure: null,
		history: [],
		updatedAtMs: now.getTime(),
	};
}

export interface ReloadRequest {
	readonly reason: string;
	readonly source: "control" | "command-shim" | "extension-command-context" | "worker";
	readonly sessionId?: string;
	readonly candidateId?: string;
	/** Identical in-flight requests with the same key are coalesced. */
	readonly dedupeKey?: string;
}

export type ReloadRequestResult =
	| {
			readonly ok: true;
			readonly authorized: true;
			readonly attemptId: string;
			readonly candidateId: string;
			readonly generation: number;
			readonly digest: ContentRevision;
	  }
	| {
			readonly ok: false;
			readonly authorized: false;
			readonly code:
				| "NO_CANDIDATE"
				| "PREFLIGHT_FAILED"
				| "CANDIDATE_CHANGED"
				| "RELOAD_BUSY"
				| "RELOAD_FAILED"
				| "SESSION_INACTIVE"
				| "STOPPING";
			readonly error: string;
			readonly diagnostics?: readonly string[];
	  };

export interface SdkReloadRequest {
	readonly attemptId: string;
	readonly candidate: ReloadCandidate;
	readonly generation: number;
	readonly digest: ContentRevision;
	readonly deadlineMs: number;
}

export interface SdkReloadOutcome {
	readonly generation: number;
	readonly digest: ContentRevision;
	readonly loadedEntryPaths?: readonly string[];
}

/** Implemented by the Worker/Supervisor integration around the real Pi SDK reload. */
export interface PiSdkReloadPort {
	reload(request: SdkReloadRequest, signal?: AbortSignal): Promise<SdkReloadOutcome>;
}

export interface ReloadObserverPort {
	beginReload(input: {
		readonly attemptId: string;
		readonly candidateId: string;
		readonly generation: number;
		readonly digest: ContentRevision;
		readonly deadlineMs: number;
	}): Promise<void>;
	completeReload(input: {
		readonly attemptId: string;
		readonly generation: number;
		readonly digest: ContentRevision;
	}): Promise<void>;
	failReload(input: { readonly attemptId: string; readonly reason: string }): Promise<void>;
	resetProbation(reason: string): Promise<void>;
}

export interface HealthRecordResult {
	readonly count: number;
	readonly required: number;
	readonly promoted: boolean;
	readonly duplicate: boolean;
}

export interface ReloadLogEvent {
	readonly atMs: number;
	readonly kind: string;
	readonly detail: RsiJsonValue;
}

export interface RecoveryIncidentInput {
	readonly incidentId: string;
	readonly reason: string;
	readonly atMs: number;
	readonly generation: number | null;
	readonly candidateId: string | null;
	readonly lkg: LkgSnapshot;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly stderrTail: string;
}

export function isHealthObservation(value: HealthTurnObservation): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof value.attemptId === "string" &&
		Number.isInteger(value.generation) &&
		Number.isInteger(value.turnIndex) &&
		typeof value.stopReason === "string" &&
		typeof value.aborted === "boolean" &&
		Number.isInteger(value.assistantMessages) &&
		typeof value.atMs === "number"
	);
}

export function historyEntry(record: {
	attemptId: string;
	candidateId: string;
	generation: number;
	digest: ContentRevision;
	phase: ReloadAttemptPhase;
	atMs: number;
	reason?: string;
}): ReloadHistoryEntry {
	return {
		attemptId: record.attemptId,
		candidateId: record.candidateId,
		generation: record.generation,
		digest: record.digest,
		phase: record.phase,
		atMs: record.atMs,
		...(record.reason === undefined ? {} : { reason: record.reason }),
	};
}
