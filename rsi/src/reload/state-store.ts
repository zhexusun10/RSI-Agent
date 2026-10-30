import { isAbsolute } from "node:path";
import { RsiError } from "../shared/errors.ts";
import type { ContentRevision } from "../shared/hash.ts";
import type { LkgSnapshot } from "../shared/plugins.ts";
import type { PluginGenerationState, ReloadHealthState } from "../shared/preflight.ts";
import { AtomicJsonFile, appendBoundedLog } from "./atomic-file.ts";
import type {
	ReloadActiveState,
	ReloadFailureRecord,
	ReloadHistoryEntry,
	ReloadInProgress,
	ReloadPendingCandidate,
	ReloadPersistentState,
} from "./types.ts";
import { initialReloadPersistentState } from "./types.ts";

const MAX_HISTORY = 30;
const MAX_STATE_BYTES = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is ContentRevision {
	return typeof value === "string" && value.startsWith("sha256:") && value.length > 10;
}

function assertAbsolute(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
		throw new RsiError("INTERNAL", `Invalid persistent state ${label}.`);
	}
	return value;
}

function validateLkg(value: unknown): LkgSnapshot {
	if (!isRecord(value)) throw new RsiError("INTERNAL", "Invalid LKG state.");
	if (
		!Number.isInteger(value.generation) ||
		typeof value.candidateId !== "string" ||
		!isDigest(value.digest) ||
		typeof value.healthyTurns !== "number" ||
		typeof value.verifiedAtMs !== "number"
	) {
		throw new RsiError("INTERNAL", "Invalid LKG state fields.");
	}
	return {
		generation: value.generation as number,
		candidateId: value.candidateId,
		digest: value.digest,
		path: assertAbsolute(value.path, "lkg.path"),
		healthyTurns: value.healthyTurns,
		verifiedAtMs: value.verifiedAtMs,
	};
}

function validateActive(value: unknown): ReloadActiveState | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new RsiError("INTERNAL", "Invalid active reload state.");
	if (
		typeof value.candidateId !== "string" ||
		!Number.isInteger(value.generation) ||
		!isDigest(value.digest) ||
		typeof value.attemptId !== "string" ||
		typeof value.loadedAtMs !== "number" ||
		(value.phase !== "probation" && value.phase !== "promoted" && value.phase !== "baseline")
	) {
		throw new RsiError("INTERNAL", "Invalid active reload fields.");
	}
	return {
		candidateId: value.candidateId,
		generation: value.generation as number,
		digest: value.digest,
		path: assertAbsolute(value.path, "active.path"),
		attemptId: value.attemptId,
		phase: value.phase,
		loadedAtMs: value.loadedAtMs,
	};
}

function validatePending(value: unknown): ReloadPendingCandidate | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new RsiError("INTERNAL", "Invalid pending candidate state.");
	if (
		typeof value.candidateId !== "string" ||
		!Number.isInteger(value.generation) ||
		!isDigest(value.digest) ||
		typeof value.preparedAtMs !== "number" ||
		(value.phase !== "prepared" && value.phase !== "validated")
	) {
		throw new RsiError("INTERNAL", "Invalid pending candidate fields.");
	}
	return {
		candidateId: value.candidateId,
		generation: value.generation as number,
		digest: value.digest,
		path: assertAbsolute(value.path, "pending.path"),
		phase: value.phase,
		preparedAtMs: value.preparedAtMs,
	};
}

function validateReloading(value: unknown): ReloadInProgress | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new RsiError("INTERNAL", "Invalid reloading state.");
	if (
		typeof value.attemptId !== "string" ||
		typeof value.candidateId !== "string" ||
		!Number.isInteger(value.generation) ||
		!isDigest(value.digest) ||
		typeof value.startedAtMs !== "number" ||
		typeof value.deadlineMs !== "number"
	) {
		throw new RsiError("INTERNAL", "Invalid reloading fields.");
	}
	return {
		attemptId: value.attemptId,
		candidateId: value.candidateId,
		generation: value.generation as number,
		digest: value.digest,
		path: assertAbsolute(value.path, "reloading.path"),
		startedAtMs: value.startedAtMs,
		deadlineMs: value.deadlineMs,
	};
}

function validateHealth(value: unknown): ReloadPersistentState["health"] {
	if (value === null) return null;
	if (!isRecord(value)) throw new RsiError("INTERNAL", "Invalid health state.");
	if (
		typeof value.attemptId !== "string" ||
		typeof value.candidateId !== "string" ||
		!Number.isInteger(value.generation) ||
		!isDigest(value.digest) ||
		!Number.isInteger(value.healthyTurns) ||
		(value.lastTurnKey !== null && typeof value.lastTurnKey !== "string") ||
		(value.lastTurnIndex !== null && !Number.isInteger(value.lastTurnIndex)) ||
		typeof value.startedAtMs !== "number"
	) {
		throw new RsiError("INTERNAL", "Invalid health state fields.");
	}
	return {
		attemptId: value.attemptId,
		candidateId: value.candidateId,
		generation: value.generation as number,
		digest: value.digest,
		healthyTurns: value.healthyTurns as number,
		lastTurnKey: value.lastTurnKey,
		lastTurnIndex: value.lastTurnIndex as number | null,
		startedAtMs: value.startedAtMs,
	};
}

function validateFailure(value: unknown): ReloadFailureRecord | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new RsiError("INTERNAL", "Invalid failure state.");
	if (
		typeof value.attemptId !== "string" ||
		typeof value.candidateId !== "string" ||
		!Number.isInteger(value.generation) ||
		!isDigest(value.digest) ||
		typeof value.failedAtMs !== "number" ||
		typeof value.reason !== "string" ||
		typeof value.phase !== "string"
	) {
		throw new RsiError("INTERNAL", "Invalid failure state fields.");
	}
	return {
		attemptId: value.attemptId,
		candidateId: value.candidateId,
		generation: value.generation as number,
		digest: value.digest,
		failedAtMs: value.failedAtMs,
		phase: value.phase as ReloadFailureRecord["phase"],
		reason: value.reason,
		...(Array.isArray(value.diagnostics) && value.diagnostics.every((item) => typeof item === "string")
			? { diagnostics: value.diagnostics as string[] }
			: {}),
	};
}

function validateHistory(value: unknown): ReloadHistoryEntry[] {
	if (!Array.isArray(value)) throw new RsiError("INTERNAL", "Invalid reload history.");
	const entries: ReloadHistoryEntry[] = [];
	for (const item of value) {
		if (!isRecord(item)) throw new RsiError("INTERNAL", "Invalid reload history entry.");
		if (
			typeof item.attemptId !== "string" ||
			typeof item.candidateId !== "string" ||
			!Number.isInteger(item.generation) ||
			!isDigest(item.digest) ||
			typeof item.phase !== "string" ||
			typeof item.atMs !== "number"
		) {
			throw new RsiError("INTERNAL", "Invalid reload history fields.");
		}
		entries.push({
			attemptId: item.attemptId,
			candidateId: item.candidateId,
			generation: item.generation as number,
			digest: item.digest,
			phase: item.phase as ReloadHistoryEntry["phase"],
			atMs: item.atMs,
			...(typeof item.reason === "string" ? { reason: item.reason } : {}),
		});
	}
	return entries.slice(-MAX_HISTORY);
}

export function validateReloadPersistentState(value: unknown): ReloadPersistentState {
	if (!isRecord(value) || value.version !== 1 || typeof value.updatedAtMs !== "number") {
		throw new RsiError("INTERNAL", "Invalid reload persistent state.");
	}
	return {
		version: 1,
		active: validateActive(value.active),
		pending: validatePending(value.pending),
		reloading: validateReloading(value.reloading),
		health: validateHealth(value.health),
		lkg: value.lkg === null ? null : validateLkg(value.lkg),
		lastFailure: validateFailure(value.lastFailure),
		history: validateHistory(value.history),
		updatedAtMs: value.updatedAtMs,
	};
}

export interface PersistentStateLoad {
	readonly state: ReloadPersistentState;
	readonly recovered: boolean;
	readonly interruptedReload: ReloadFailureRecord | null;
	readonly diagnostics: readonly string[];
}

/** Atomic reload journal plus human-readable bounded log. */
export class ReloadStateStore {
	readonly file: AtomicJsonFile<ReloadPersistentState>;
	readonly logPath: string | null;
	private readonly now: () => Date;
	private readonly logLimitBytes: number;

	constructor(input: {
		readonly stateFile: string;
		readonly clock: { now(): Date };
		readonly logPath?: string;
		readonly logLimitBytes?: number;
		readonly serialize?: (value: ReloadPersistentState) => string;
	}) {
		this.file = new AtomicJsonFile(input.stateFile, validateReloadPersistentState, input.serialize);
		this.logPath = input.logPath ?? null;
		this.now = () => input.clock.now();
		this.logLimitBytes = input.logLimitBytes ?? 256 * 1024;
	}

	async load(): Promise<PersistentStateLoad> {
		await this.file.cleanupTemps();
		const read = await this.file.read();
		const diagnostics = [...read.diagnostics];
		let state = read.value ?? initialReloadPersistentState(this.now());
		let interruptedReload: ReloadFailureRecord | null = null;
		if (state.reloading !== null) {
			const current = state.reloading;
			interruptedReload = {
				attemptId: current.attemptId,
				candidateId: current.candidateId,
				generation: current.generation,
				digest: current.digest,
				failedAtMs: this.now().getTime(),
				phase: "reloading",
				reason: "reload was interrupted by a process restart",
			};
			state = {
				...state,
				reloading: null,
				health: null,
				lastFailure: interruptedReload,
				history: [
					...state.history,
					{
						attemptId: current.attemptId,
						candidateId: current.candidateId,
						generation: current.generation,
						digest: current.digest,
						phase: "failed" as const,
						atMs: interruptedReload.failedAtMs,
						reason: interruptedReload.reason,
					},
				].slice(-MAX_HISTORY),
				updatedAtMs: this.now().getTime(),
			};
			diagnostics.push(`Interrupted reload ${current.attemptId} was marked failed.`);
			await this.file.write(state);
		}
		return { state, recovered: read.recovered, interruptedReload, diagnostics };
	}

	async save(state: ReloadPersistentState): Promise<void> {
		const bounded: ReloadPersistentState = {
			...state,
			history: state.history.slice(-MAX_HISTORY),
			updatedAtMs: Math.max(state.updatedAtMs, this.now().getTime()),
		};
		if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_STATE_BYTES) {
			throw new RsiError("INTERNAL", "Reload persistent state exceeds the size bound.");
		}
		await this.file.write(bounded);
	}

	async log(kind: string, detail: unknown): Promise<void> {
		if (this.logPath === null) return;
		const line = `${JSON.stringify({ atMs: this.now().getTime(), kind, detail })}\n`;
		await appendBoundedLog(this.logPath, line, this.logLimitBytes);
	}

	/** Shared SnapshotStorePort-compatible projection. */
	toPluginGenerationState(state: ReloadPersistentState): PluginGenerationState {
		const health: ReloadHealthState | null =
			state.health === null
				? null
				: {
						attemptId: state.health.attemptId,
						candidateId: state.health.candidateId,
						generation: state.health.generation,
						digest: state.health.digest,
						startedAtMs: state.health.startedAtMs,
						healthyTurns: state.health.healthyTurns,
						phase:
							state.health.healthyTurns >= 3
								? "promoted"
								: state.reloading === null
									? "observing"
									: "reloading",
					};
		return {
			version: 1,
			activeGeneration: state.active?.generation ?? null,
			activeDigest: state.active?.digest ?? null,
			health,
			lkg: state.lkg,
			updatedAtMs: state.updatedAtMs,
		};
	}

	async loadPluginGenerationState(): Promise<PluginGenerationState> {
		return this.toPluginGenerationState((await this.load()).state);
	}

	async savePluginGenerationState(state: PluginGenerationState): Promise<void> {
		const current = (await this.load()).state;
		let active = current.active;
		if (state.activeGeneration !== null && state.activeDigest !== null) {
			if (
				active === null ||
				active.generation !== state.activeGeneration ||
				active.digest !== state.activeDigest
			) {
				throw new RsiError(
					"RELOAD_FAILED",
					"SnapshotStorePort cannot invent an active snapshot without a prepared candidate path.",
				);
			}
		} else {
			active = null;
		}
		const next: ReloadPersistentState = {
			...current,
			active,
			lkg: state.lkg,
			updatedAtMs: this.now().getTime(),
		};
		await this.save(next);
	}
}
