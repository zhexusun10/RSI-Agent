import { RsiError } from "../shared/errors.ts";
import type { LkgSnapshot, PluginCandidate } from "../shared/plugins.ts";
import type { PluginGenerationState } from "../shared/preflight.ts";
import type { SnapshotStorePort } from "../shared/ports.ts";
import { HEALTHY_TURNS_REQUIRED } from "../shared/policy.ts";
import type { Clock } from "../shared/time.ts";
import type { ImmutableCandidateStore } from "./candidate-store.ts";
import type { ReloadStateStore } from "./state-store.ts";
import type { RestoreRootAllowlist } from "./types.ts";

/**
 * Shared SnapshotStorePort projection over the reload journal.
 *
 * createLkg refuses to materialize a candidate unless the persisted health
 * record for the exact generation/digest has reached three turns. This keeps
 * the public port from becoming a promotion bypass.
 */
export class ReloadSnapshotStore implements SnapshotStorePort {
	readonly stateStore: ReloadStateStore;
	readonly candidateStore: ImmutableCandidateStore;
	readonly allowlist: RestoreRootAllowlist;
	readonly clock: Clock;

	constructor(input: {
		readonly stateStore: ReloadStateStore;
		readonly candidateStore: ImmutableCandidateStore;
		readonly allowlist: RestoreRootAllowlist;
		readonly clock: Clock;
	}) {
		this.stateStore = input.stateStore;
		this.candidateStore = input.candidateStore;
		this.allowlist = input.allowlist;
		this.clock = input.clock;
	}

	async loadState(): Promise<PluginGenerationState> {
		return this.stateStore.loadPluginGenerationState();
	}

	async saveState(state: PluginGenerationState): Promise<void> {
		await this.stateStore.savePluginGenerationState(state);
	}

	async createLkg(candidate: PluginCandidate, now: Date): Promise<LkgSnapshot> {
		const state = (await this.stateStore.load()).state;
		const health = state.health;
		if (
			state.active === null ||
			health === null ||
			health.healthyTurns < HEALTHY_TURNS_REQUIRED ||
			state.active.generation !== candidate.generation ||
			state.active.digest !== candidate.digest ||
			state.active.candidateId !== candidate.candidateId
		) {
			throw new RsiError(
				"RELOAD_FAILED",
				"LKG promotion requires three healthy turns for the exact loaded generation/digest.",
			);
		}
		const verified = await this.candidateStore.verifyCandidate(candidate.path);
		if (verified.digest !== candidate.digest) {
			throw new RsiError("CANDIDATE_CHANGED", "Candidate changed before LKG creation.");
		}
		return this.candidateStore.createLkg(verified.candidate, now, HEALTHY_TURNS_REQUIRED);
	}

	async restoreLkg(snapshot: LkgSnapshot): Promise<void> {
		await this.candidateStore.verifyLkg(snapshot);
		await this.candidateStore.restoreCandidateSources(snapshot.path, this.allowlist);
	}

	async restoreInterrupted(): Promise<void> {
		await this.candidateStore.recoverInterruptedRestores(this.allowlist);
	}
}
