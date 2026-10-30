import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { RsiError } from "../shared/errors.ts";
import { advanceHealthTurns, classifyHealthyTurn, HEALTHY_TURNS_REQUIRED } from "../shared/preflight.ts";
import type { HealthTurnObservation, PreflightReport } from "../shared/preflight.ts";
import type { LkgSnapshot, PluginCandidate } from "../shared/plugins.ts";
import type { RuntimeEventPublisher } from "../shared/events.ts";
import type { ContentRevision } from "../shared/hash.ts";
import type { Clock } from "../shared/time.ts";
import type { ImmutableCandidateStore } from "./candidate-store.ts";
import type { ReloadPreflight } from "./preflight-runner.ts";
import type { PersistentStateLoad, ReloadStateStore } from "./state-store.ts";
import type {
	CandidatePrepareInput,
	HealthRecordResult,
	PiSdkReloadPort,
	PreflightDiagnostics,
	PreflightOutcome,
	ReloadCandidate,
	ReloadInProgress,
	ReloadObserverPort,
	ReloadPersistentState,
	ReloadRequest,
	ReloadRequestResult,
} from "./types.ts";
import { historyEntry, initialReloadPersistentState, isHealthObservation } from "./types.ts";

const MAX_HISTORY = 30;

export interface ReloadCoordinatorOptions {
	readonly candidateStore: ImmutableCandidateStore;
	readonly preflight: ReloadPreflight;
	readonly stateStore: ReloadStateStore;
	readonly sdkReload: PiSdkReloadPort;
	readonly clock: Clock;
	readonly events?: RuntimeEventPublisher;
	readonly observer?: ReloadObserverPort;
	readonly reloadTimeoutMs?: number;
	readonly idFactory?: () => string;
	readonly onDiagnostic?: (message: string) => void;
}

export interface ActiveExtensionSet {
	readonly candidateId: string;
	readonly generation: number;
	readonly digest: ContentRevision;
	readonly snapshotPath: string;
	readonly entryPaths: readonly string[];
}

function appendHistory(
	state: ReloadPersistentState,
	entry: Parameters<typeof historyEntry>[0],
): ReloadPersistentState {
	return { ...state, history: [...state.history, historyEntry(entry)].slice(-MAX_HISTORY) };
}

function isCandidateId(value: string): boolean {
	return /^gen-\d{6}-[0-9a-f]{12}$/.test(value);
}

/**
 * The single external authority for candidate preparation, preflight, real Pi
 * reload, three-turn probation, and LKG promotion.
 */
export class ReloadCoordinator {
	readonly candidateStore: ImmutableCandidateStore;
	readonly preflight: ReloadPreflight;
	readonly stateStore: ReloadStateStore;
	readonly sdkReload: PiSdkReloadPort;
	readonly clock: Clock;
	readonly events: RuntimeEventPublisher | undefined;
	readonly observer: ReloadObserverPort | undefined;
	readonly reloadTimeoutMs: number;
	readonly idFactory: () => string;
	readonly onDiagnostic: (message: string) => void;
	private stateCache: ReloadPersistentState | null = null;
	private stateLoadResult: PersistentStateLoad | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private stoppingReason: string | null = null;
	private readonly validatedCandidateIds = new Set<string>();

	constructor(options: ReloadCoordinatorOptions) {
		this.candidateStore = options.candidateStore;
		this.preflight = options.preflight;
		this.stateStore = options.stateStore;
		this.sdkReload = options.sdkReload;
		this.clock = options.clock;
		this.events = options.events;
		this.observer = options.observer;
		this.reloadTimeoutMs = options.reloadTimeoutMs ?? 30_000;
		this.idFactory = options.idFactory ?? randomUUID;
		this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(operation, operation);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async loadState(): Promise<ReloadPersistentState> {
		if (this.stateCache !== null) return this.stateCache;
		const loaded = await this.stateStore.load();
		this.stateLoadResult = loaded;
		for (const diagnostic of loaded.diagnostics) this.onDiagnostic(diagnostic);
		let state = loaded.state;
		if (loaded.interruptedReload !== null) {
			this.onDiagnostic(
				`Reload ${loaded.interruptedReload.attemptId} was interrupted; previous active generation was kept.`,
			);
		}
		let changed = false;
		if (state.lkg !== null) {
			try {
				await this.candidateStore.verifyLkg(state.lkg);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				this.onDiagnostic(`Stored LKG is unusable and was cleared: ${reason}`);
				state = appendHistory(
					{
						...state,
						lkg: null,
						lastFailure: {
							attemptId: "state-validation",
							candidateId: state.lkg.candidateId,
							generation: state.lkg.generation,
							digest: state.lkg.digest,
							failedAtMs: this.clock.now().getTime(),
							phase: "failed",
							reason: `LKG validation failed: ${reason}`,
						},
					},
					{
						attemptId: "state-validation",
						candidateId: state.lkg.candidateId,
						generation: state.lkg.generation,
						digest: state.lkg.digest,
						phase: "failed",
						atMs: this.clock.now().getTime(),
						reason: "LKG validation failed",
					},
				);
				changed = true;
			}
		}
		if (state.active !== null) {
			try {
				const verification = await this.candidateStore.verifyCandidate(state.active.path);
				if (verification.digest !== state.active.digest) {
					throw new RsiError("CANDIDATE_CHANGED", "Active candidate digest does not match persisted state.");
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				this.onDiagnostic(`Persisted active candidate is unusable and was cleared: ${reason}`);
				state = appendHistory(
					{ ...state, active: null, health: null, pending: null },
					{
						attemptId: state.active.attemptId,
						candidateId: state.active.candidateId,
						generation: state.active.generation,
						digest: state.active.digest,
						phase: "failed",
						atMs: this.clock.now().getTime(),
						reason: "active snapshot invalid",
					},
				);
				changed = true;
			}
		}
		if (changed) {
			await this.stateStore.save({ ...state, updatedAtMs: this.clock.now().getTime() });
		}
		this.stateCache = state;
		return state;
	}

	private async persist(state: ReloadPersistentState): Promise<ReloadPersistentState> {
		const next = { ...state, updatedAtMs: this.clock.now().getTime() };
		await this.stateStore.save(next);
		this.stateCache = next;
		return next;
	}

	private async pruneSnapshots(state: ReloadPersistentState): Promise<void> {
		const keepCandidates = [state.active?.path, state.pending?.path, state.reloading?.path].filter(
			(path): path is string => path !== undefined,
		);
		try {
			const removedCandidates = await this.candidateStore.pruneCandidates(keepCandidates, 5);
			const removedLkg = await this.candidateStore.pruneLkg(state.lkg === null ? [] : [state.lkg.path], 3);
			if (removedCandidates.length + removedLkg.length > 0) {
				await this.stateStore.log("snapshots.pruned", {
					candidates: removedCandidates.length,
					lkg: removedLkg.length,
				});
			}
		} catch (error) {
			this.onDiagnostic(`Snapshot pruning failed: ${String(error)}`);
		}
	}

	private failedPreflightOutcome(candidate: ReloadCandidate, error: unknown): PreflightOutcome {
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		const report: PreflightReport = {
			candidateId: candidate.candidateId,
			generation: candidate.generation,
			digest: candidate.digest,
			staticSyntaxCheck: { ok: false, durationMs: 0, errors: [message] },
			mockLoad: { ok: false, durationMs: 0, errors: ["Mock load was not executed because preflight setup failed."] },
			ok: false,
			completedAtMs: this.clock.now().getTime(),
		};
		const diagnostics: PreflightDiagnostics = {
			staticSyntaxCheck: { timedOut: false, exitCode: null, signal: null, stderr: "" },
			mockLoad: { timedOut: false, exitCode: null, signal: null, stderr: "" },
		};
		return { report, diagnostics };
	}

	async currentState(): Promise<ReloadPersistentState> {
		return this.enqueue(() => this.loadState());
	}

	async loadDiagnostics(): Promise<PersistentStateLoad | null> {
		await this.currentState();
		return this.stateLoadResult;
	}

	private async resolveCandidateInternal(
		candidateId: string | undefined,
		state: ReloadPersistentState,
	): Promise<ReloadCandidate | null> {
		if (candidateId === undefined) {
			if (state.pending === null) return null;
			return (await this.candidateStore.verifyCandidate(state.pending.path)).candidate;
		}
		if (!isCandidateId(candidateId)) return null;
		if (state.pending?.candidateId === candidateId) {
			return (await this.candidateStore.verifyCandidate(state.pending.path)).candidate;
		}
		const candidates = [join(this.candidateStore.candidatesDir, candidateId), join(this.candidateStore.lkgDir, candidateId)];
		for (const path of candidates) {
			try {
				return (await this.candidateStore.verifyCandidate(path)).candidate;
			} catch {
				// Try the next location.
			}
		}
		return null;
	}

	async resolveCandidate(candidateId?: string): Promise<ReloadCandidate | null> {
		return this.enqueue(async () => {
			const state = await this.loadState();
			return this.resolveCandidateInternal(candidateId, state);
		});
	}

	async prepareCandidate(
		input: Omit<CandidatePrepareInput, "generation"> & { readonly generation?: number },
	): Promise<ReloadCandidate> {
		return this.enqueue(async () => {
			let state = await this.loadState();
			if (this.stoppingReason !== null) {
				throw new RsiError("RELOAD_FAILED", `Runtime is stopping: ${this.stoppingReason}`);
			}
			if (state.reloading !== null) {
				throw new RsiError("RELOAD_FAILED", "Cannot prepare a candidate while a reload is in progress.");
			}
			const generations = [
				state.active?.generation ?? 0,
				state.lkg?.generation ?? 0,
				state.pending?.generation ?? 0,
				state.lastFailure?.generation ?? 0,
				...state.history.map((entry) => entry.generation),
			];
			const generation = input.generation ?? Math.max(...generations) + 1;
			const candidate = await this.candidateStore.prepareCandidate({ ...input, generation });
			this.validatedCandidateIds.delete(candidate.candidateId);
			state = appendHistory(
				{
					...state,
					pending: {
						candidateId: candidate.candidateId,
						generation: candidate.generation,
						digest: candidate.digest,
						path: candidate.path,
						phase: "prepared",
						preparedAtMs: this.clock.now().getTime(),
					},
					lastFailure: null,
				},
				{
					attemptId: `prepare-${candidate.candidateId}`,
					candidateId: candidate.candidateId,
					generation: candidate.generation,
					digest: candidate.digest,
					phase: "prepared",
					atMs: this.clock.now().getTime(),
				},
			);
			const persisted = await this.persist(state);
			await this.pruneSnapshots(persisted);
			await this.stateStore.log("candidate.prepared", {
				candidateId: candidate.candidateId,
				generation: candidate.generation,
				digest: candidate.digest,
			});
			return candidate;
		});
	}

	private async validateCandidateInternal(
		candidate: ReloadCandidate,
		signal: AbortSignal | undefined,
	): Promise<{ readonly outcome: PreflightOutcome; readonly state: ReloadPersistentState }> {
		let state = await this.loadState();
		let outcome: PreflightOutcome;
		try {
			outcome = await this.preflight.run(candidate, signal);
		} catch (error) {
			outcome = this.failedPreflightOutcome(candidate, error);
		}
		this.events?.emit("reload.preflight", outcome.report);
		if (!outcome.report.ok) {
			const errors = [...outcome.report.staticSyntaxCheck.errors, ...outcome.report.mockLoad.errors];
			this.validatedCandidateIds.delete(candidate.candidateId);
			state = appendHistory(
				{
					...state,
					lastFailure: {
						attemptId: `preflight-${candidate.candidateId}`,
						candidateId: candidate.candidateId,
						generation: candidate.generation,
						digest: candidate.digest,
						failedAtMs: this.clock.now().getTime(),
						phase: "prepared",
						reason: "preflight failed",
						diagnostics: errors,
					},
					...(state.pending?.candidateId === candidate.candidateId ? { pending: { ...state.pending, phase: "prepared" as const } } : {}),
				},
				{
					attemptId: `preflight-${candidate.candidateId}`,
					candidateId: candidate.candidateId,
					generation: candidate.generation,
					digest: candidate.digest,
					phase: "failed",
					atMs: this.clock.now().getTime(),
					reason: "preflight failed",
				},
			);
			await this.persist(state);
			await this.stateStore.log("candidate.preflight.failed", {
				candidateId: candidate.candidateId,
				errors,
			});
			return { outcome, state };
		}
		this.validatedCandidateIds.add(candidate.candidateId);
		state = appendHistory(
			{
				...state,
				pending:
					state.pending?.candidateId === candidate.candidateId
						? { ...state.pending, phase: "validated" }
						: {
							candidateId: candidate.candidateId,
							generation: candidate.generation,
							digest: candidate.digest,
							path: candidate.path,
							phase: "validated",
							preparedAtMs: this.clock.now().getTime(),
						},
				lastFailure: null,
			},
			{
				attemptId: `preflight-${candidate.candidateId}`,
				candidateId: candidate.candidateId,
				generation: candidate.generation,
				digest: candidate.digest,
				phase: "validated",
				atMs: this.clock.now().getTime(),
			},
		);
		const persisted = await this.persist(state);
		await this.pruneSnapshots(persisted);
		await this.stateStore.log("candidate.validated", { candidateId: candidate.candidateId });
		return { outcome, state };
	}

	async validateCandidate(candidate: ReloadCandidate, signal?: AbortSignal): Promise<PreflightOutcome> {
		return this.enqueue(async () => {
			const { outcome } = await this.validateCandidateInternal(candidate, signal);
			return outcome;
		});
	}

	async prepareAndValidate(
		input: Omit<CandidatePrepareInput, "generation"> & { readonly generation?: number },
		signal?: AbortSignal,
	): Promise<{ readonly candidate: ReloadCandidate; readonly outcome: PreflightOutcome }> {
		const candidate = await this.prepareCandidate(input);
		const outcome = await this.validateCandidate(candidate, signal);
		return { candidate, outcome };
	}

	async requestReload(request: ReloadRequest, signal?: AbortSignal): Promise<ReloadRequestResult> {
		return this.enqueue(async () => {
			let state = await this.loadState();
			if (this.stoppingReason !== null) {
				return { ok: false, authorized: false, code: "STOPPING", error: `Stopping: ${this.stoppingReason}` };
			}
			if (state.reloading !== null) {
				return {
					ok: false,
					authorized: false,
					code: "RELOAD_BUSY",
					error: `Reload ${state.reloading.attemptId} is already in progress.`,
				};
			}
			let candidate: ReloadCandidate | null = null;
			if (request.candidateId !== undefined) {
				if (!isCandidateId(request.candidateId)) {
					return { ok: false, authorized: false, code: "NO_CANDIDATE", error: "Invalid candidate id." };
				}
				candidate = await this.resolveCandidateInternal(request.candidateId, state);
			} else if (state.pending !== null) {
				candidate = (await this.candidateStore.verifyCandidate(state.pending.path)).candidate;
			}
			if (candidate === null) {
				return {
					ok: false,
					authorized: false,
					code: "NO_CANDIDATE",
					error: "No prepared candidate is available for reload.",
				};
			}
			let pending = state.pending?.candidateId === candidate.candidateId ? state.pending : null;
			if (pending === null || pending.phase !== "validated" || !this.validatedCandidateIds.has(candidate.candidateId)) {
				try {
					const validated = await this.validateCandidateInternal(candidate, signal);
					const outcome = validated.outcome;
					if (!outcome.report.ok) {
						const errors = [...outcome.report.staticSyntaxCheck.errors, ...outcome.report.mockLoad.errors];
						return {
							ok: false,
							authorized: false,
							code: "PREFLIGHT_FAILED",
							error: `Preflight failed for ${candidate.candidateId}; real reload blocked.`,
							diagnostics: errors,
						};
					}
					state = validated.state;
					pending = state.pending;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						ok: false,
						authorized: false,
						code: error instanceof RsiError && error.code === "CANDIDATE_CHANGED" ? "CANDIDATE_CHANGED" : "PREFLIGHT_FAILED",
						error: message,
						diagnostics: [error instanceof Error ? error.stack ?? message : message],
					};
				}
			}
			try {
				const verification = await this.candidateStore.verifyCandidate(candidate.path);
				if (verification.digest !== candidate.digest) {
					return {
						ok: false,
						authorized: false,
						code: "CANDIDATE_CHANGED",
						error: "Candidate digest changed after preflight; real reload blocked.",
					};
				}
			} catch (error) {
				return {
					ok: false,
					authorized: false,
					code: "CANDIDATE_CHANGED",
					error: error instanceof Error ? error.message : String(error),
				};
			}
			const attemptId = this.idFactory();
			const startedAtMs = this.clock.now().getTime();
			const reloading: ReloadInProgress = {
				attemptId,
				candidateId: candidate.candidateId,
				generation: candidate.generation,
				digest: candidate.digest,
				path: candidate.path,
				startedAtMs,
				deadlineMs: startedAtMs + this.reloadTimeoutMs,
			};
			state = appendHistory(
				{ ...state, reloading, health: null },
				{
					attemptId,
					candidateId: candidate.candidateId,
					generation: candidate.generation,
					digest: candidate.digest,
					phase: "reloading",
					atMs: startedAtMs,
					reason: request.reason,
				},
			);
			await this.persist(state);
			await this.stateStore.log("reload.started", {
				attemptId,
				candidateId: candidate.candidateId,
				generation: candidate.generation,
				digest: candidate.digest,
				source: request.source,
			});
			this.events?.emit("reload.started", {
				attemptId,
				generation: candidate.generation,
				candidateDigest: candidate.digest,
				atMs: startedAtMs,
			});
			try {
				await this.observer?.beginReload({
					attemptId,
					candidateId: candidate.candidateId,
					generation: candidate.generation,
					digest: candidate.digest,
					deadlineMs: reloading.deadlineMs,
				});
				const outcome = await this.sdkReload.reload(
					{
						attemptId,
						candidate,
						generation: candidate.generation,
						digest: candidate.digest,
						deadlineMs: reloading.deadlineMs,
					},
					signal,
				);
				if (this.clock.now().getTime() > reloading.deadlineMs) {
					throw new RsiError("RELOAD_FAILED", `Real reload exceeded its deadline (${reloading.deadlineMs}).`);
				}
				if (outcome.generation !== candidate.generation || outcome.digest !== candidate.digest) {
					throw new RsiError(
						"CANDIDATE_CHANGED",
						`Real reload loaded generation/digest ${outcome.generation}/${outcome.digest}, expected ${candidate.generation}/${candidate.digest}.`,
					);
				}
				const afterLoad = await this.candidateStore.verifyCandidate(candidate.path);
				if (afterLoad.digest !== candidate.digest) {
					throw new RsiError("CANDIDATE_CHANGED", "Loaded candidate snapshot changed before activation.");
				}
				const loadedAtMs = this.clock.now().getTime();
				state = appendHistory(
					{
						...state,
						active: {
							candidateId: candidate.candidateId,
							generation: candidate.generation,
							digest: candidate.digest,
							path: candidate.path,
							attemptId,
							phase: "probation",
							loadedAtMs,
						},
						pending: null,
						reloading: null,
						health: {
							attemptId,
							candidateId: candidate.candidateId,
							generation: candidate.generation,
							digest: candidate.digest,
							healthyTurns: 0,
							lastTurnKey: null,
							lastTurnIndex: null,
							startedAtMs: loadedAtMs,
						},
						lastFailure: null,
					},
					{
						attemptId,
						candidateId: candidate.candidateId,
						generation: candidate.generation,
						digest: candidate.digest,
						phase: "probation",
						atMs: loadedAtMs,
					},
				);
				const persisted = await this.persist(state);
				await this.pruneSnapshots(persisted);
				await this.stateStore.log("reload.loaded", {
					attemptId,
					candidateId: candidate.candidateId,
					generation: candidate.generation,
					digest: candidate.digest,
				});
				await this.observer?.completeReload({
					attemptId,
					generation: candidate.generation,
					digest: candidate.digest,
				});
				return {
					ok: true,
					authorized: true,
					attemptId,
					candidateId: candidate.candidateId,
					generation: candidate.generation,
					digest: candidate.digest,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const stack = error instanceof Error && error.stack !== undefined ? error.stack : message;
				this.validatedCandidateIds.delete(candidate.candidateId);
				state = appendHistory(
					{
						...state,
						reloading: null,
						pending: state.pending?.candidateId === candidate.candidateId ? { ...state.pending, phase: "prepared" } : state.pending,
						health: null,
						lastFailure: {
							attemptId,
							candidateId: candidate.candidateId,
							generation: candidate.generation,
							digest: candidate.digest,
							failedAtMs: this.clock.now().getTime(),
							phase: "reloading",
							reason: message,
							diagnostics: [stack],
						},
					},
					{
						attemptId,
						candidateId: candidate.candidateId,
						generation: candidate.generation,
						digest: candidate.digest,
						phase: "failed",
						atMs: this.clock.now().getTime(),
						reason: message,
					},
				);
				await this.persist(state);
				await this.stateStore.log("reload.failed", { attemptId, reason: message });
				await this.observer?.failReload({ attemptId, reason: message }).catch(() => undefined);
				return {
					ok: false,
					authorized: false,
					code: error instanceof RsiError && error.code === "CANDIDATE_CHANGED" ? "CANDIDATE_CHANGED" : "RELOAD_FAILED",
					error: message,
					diagnostics: [stack],
				};
			}
		});
	}

	/**
	 * Persist and arm a Worker-initiated reload after the Worker already asked
	 * the external preflight service. The Supervisor remains authoritative: it
	 * verifies the exact validated candidate and persists the deadline before
	 * the Worker is allowed to call the real session.reload().
	 */
	async beginWorkerReload(input: {
		readonly candidateId: string;
		readonly reason: string;
	}): Promise<{ readonly attemptId: string; readonly requiredHealthTurns: 3 }> {
		return this.enqueue(async () => {
			let state = await this.loadState();
			if (this.stoppingReason !== null) {
				throw new RsiError("RELOAD_FAILED", `Runtime is stopping: ${this.stoppingReason}`);
			}
			if (state.reloading !== null) {
				throw new RsiError("RELOAD_FAILED", "A reload is already in progress.");
			}
			const candidate = await this.resolveCandidateInternal(input.candidateId, state);
			if (candidate === null) {
				throw new RsiError("PREFLIGHT_FAILED", `Unknown candidate: ${input.candidateId}`);
			}
			const pending = state.pending?.candidateId === candidate.candidateId ? state.pending : null;
			if (pending === null || pending.phase !== "validated" || !this.validatedCandidateIds.has(candidate.candidateId)) {
				const validated = await this.validateCandidateInternal(candidate, undefined);
				if (!validated.outcome.report.ok) {
					const errors = [
						...validated.outcome.report.staticSyntaxCheck.errors,
						...validated.outcome.report.mockLoad.errors,
					];
					throw new RsiError(
						"PREFLIGHT_FAILED",
						`Preflight failed for ${candidate.candidateId}; real reload was not started.`,
						{ details: { candidateId: candidate.candidateId, errors } },
					);
				}
				state = validated.state;
			}
			const verification = await this.candidateStore.verifyCandidate(candidate.path);
			if (verification.digest !== candidate.digest) {
				throw new RsiError("CANDIDATE_CHANGED", "Candidate changed after preflight; real reload blocked.");
			}
			const attemptId = this.idFactory();
			const startedAtMs = this.clock.now().getTime();
			const reloading: ReloadInProgress = {
				attemptId,
				candidateId: candidate.candidateId,
				generation: candidate.generation,
				digest: candidate.digest,
				path: candidate.path,
				startedAtMs,
				deadlineMs: startedAtMs + this.reloadTimeoutMs,
			};
			state = appendHistory(
				{ ...state, reloading, health: null },
				{
					attemptId,
					candidateId: candidate.candidateId,
					generation: candidate.generation,
					digest: candidate.digest,
					phase: "reloading",
					atMs: startedAtMs,
					reason: input.reason,
				},
			);
			await this.persist(state);
			await this.stateStore.log("reload.worker.begin", {
				attemptId,
				candidateId: candidate.candidateId,
				reason: input.reason,
			});
			this.events?.emit("reload.started", {
				attemptId,
				generation: candidate.generation,
				candidateDigest: candidate.digest,
				atMs: startedAtMs,
			});
			await this.observer?.beginReload({
				attemptId,
				candidateId: candidate.candidateId,
				generation: candidate.generation,
				digest: candidate.digest,
				deadlineMs: reloading.deadlineMs,
			});
			return { attemptId, requiredHealthTurns: 3 };
		});
	}

	/** Finalize a Worker-initiated reload after the Worker's real session.reload returned. */
	async completeWorkerReload(input: {
		readonly attemptId: string;
		readonly generation: number;
		readonly digest: ContentRevision;
	}): Promise<void> {
		await this.enqueue(async () => {
			let state = await this.loadState();
			const reloading = state.reloading;
			if (reloading === null || reloading.attemptId !== input.attemptId) {
				throw new RsiError("RELOAD_FAILED", "Worker completed a reload that is not in progress.");
			}
			if (this.clock.now().getTime() > reloading.deadlineMs) {
				throw new RsiError("RELOAD_FAILED", "Worker reload exceeded its persisted deadline.");
			}
			if (reloading.generation !== input.generation || reloading.digest !== input.digest) {
				throw new RsiError(
					"CANDIDATE_CHANGED",
					`Worker loaded generation/digest ${input.generation}/${input.digest}, expected ${reloading.generation}/${reloading.digest}.`,
				);
			}
			const verified = await this.candidateStore.verifyCandidate(reloading.path);
			if (verified.digest !== reloading.digest) {
				throw new RsiError("CANDIDATE_CHANGED", "Loaded candidate snapshot changed before activation.");
			}
			const loadedAtMs = this.clock.now().getTime();
			state = appendHistory(
				{
					...state,
					active: {
						candidateId: reloading.candidateId,
						generation: reloading.generation,
						digest: reloading.digest,
						path: reloading.path,
						attemptId: reloading.attemptId,
						phase: "probation",
						loadedAtMs,
					},
					pending: null,
					reloading: null,
					health: {
						attemptId: reloading.attemptId,
						candidateId: reloading.candidateId,
						generation: reloading.generation,
						digest: reloading.digest,
						healthyTurns: 0,
						lastTurnKey: null,
						lastTurnIndex: null,
						startedAtMs: loadedAtMs,
					},
					lastFailure: null,
				},
				{
					attemptId: reloading.attemptId,
					candidateId: reloading.candidateId,
					generation: reloading.generation,
					digest: reloading.digest,
					phase: "probation",
					atMs: loadedAtMs,
				},
			);
			const persisted = await this.persist(state);
			await this.pruneSnapshots(persisted);
			await this.stateStore.log("reload.worker.completed", {
				attemptId: reloading.attemptId,
				generation: reloading.generation,
				digest: reloading.digest,
			});
			await this.observer?.completeReload({
				attemptId: reloading.attemptId,
				generation: reloading.generation,
				digest: reloading.digest,
			});
		});
	}

	/** Persist a Worker-initiated reload failure and keep the previous active generation. */
	async failWorkerReload(attemptId: string, reason: string): Promise<void> {
		await this.enqueue(async () => {
			let state = await this.loadState();
			const reloading = state.reloading;
			if (reloading === null || reloading.attemptId !== attemptId) return;
			const failureAtMs = this.clock.now().getTime();
			state = appendHistory(
				{
					...state,
					reloading: null,
					health: null,
					pending:
						state.pending?.candidateId === reloading.candidateId
							? { ...state.pending, phase: "prepared" }
							: state.pending,
					lastFailure: {
						attemptId,
						candidateId: reloading.candidateId,
						generation: reloading.generation,
						digest: reloading.digest,
						failedAtMs: failureAtMs,
						phase: "reloading",
						reason,
					},
				},
				{
					attemptId,
					candidateId: reloading.candidateId,
					generation: reloading.generation,
					digest: reloading.digest,
					phase: "failed",
					atMs: failureAtMs,
					reason,
				},
			);
			this.validatedCandidateIds.delete(reloading.candidateId);
			await this.persist(state);
			await this.stateStore.log("reload.worker.failed", { attemptId, reason });
			await this.observer?.failReload({ attemptId, reason }).catch(() => undefined);
		});
	}

	/** Initial safe baseline: preflight + real load + exact LKG, without probation. */
	async initializeBaseline(candidate: ReloadCandidate, signal?: AbortSignal): Promise<{
		readonly ok: boolean;
		readonly lkg?: LkgSnapshot;
		readonly error?: string;
		readonly preflight?: PreflightReport;
	}> {
		return this.enqueue(async () => {
			let state = await this.loadState();
			if (state.lkg !== null) {
				return { ok: true, lkg: state.lkg };
			}
			if (state.active !== null) {
				return {
					ok: false,
					error: "An active generation exists without an LKG; refusing to invent a baseline.",
				};
			}
			if (state.reloading !== null) {
				return { ok: false, error: "A reload was already in progress during baseline initialization." };
			}
			let outcome;
			try {
				outcome = await this.preflight.run(candidate, signal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message };
			}
			this.events?.emit("reload.preflight", outcome.report);
			if (!outcome.report.ok) {
				const errors = [...outcome.report.staticSyntaxCheck.errors, ...outcome.report.mockLoad.errors];
				state = appendHistory(
					{
						...state,
						lastFailure: {
							attemptId: `baseline-${candidate.candidateId}`,
							candidateId: candidate.candidateId,
							generation: candidate.generation,
							digest: candidate.digest,
							failedAtMs: this.clock.now().getTime(),
							phase: "prepared",
							reason: "baseline preflight failed",
							diagnostics: errors,
						},
					},
					{
						attemptId: `baseline-${candidate.candidateId}`,
						candidateId: candidate.candidateId,
						generation: candidate.generation,
						digest: candidate.digest,
						phase: "failed",
						atMs: this.clock.now().getTime(),
						reason: "baseline preflight failed",
					},
				);
				await this.persist(state);
				return { ok: false, error: errors.join("\n"), preflight: outcome.report };
			}
			const attemptId = `baseline-${this.idFactory()}`;
			const startedAtMs = this.clock.now().getTime();
			const reloading: ReloadInProgress = {
				attemptId,
				candidateId: candidate.candidateId,
				generation: candidate.generation,
				digest: candidate.digest,
				path: candidate.path,
				startedAtMs,
				deadlineMs: startedAtMs + this.reloadTimeoutMs,
			};
			await this.persist({ ...state, reloading, updatedAtMs: startedAtMs });
			try {
				await this.observer?.beginReload(reloading);
				const loaded = await this.sdkReload.reload(
					{
						attemptId,
						candidate,
						generation: candidate.generation,
						digest: candidate.digest,
						deadlineMs: reloading.deadlineMs,
					},
					signal,
				);
				if (this.clock.now().getTime() > reloading.deadlineMs) {
					throw new RsiError("RELOAD_FAILED", "Initial load exceeded its deadline.");
				}
				if (loaded.generation !== candidate.generation || loaded.digest !== candidate.digest) {
					throw new RsiError("CANDIDATE_CHANGED", "Initial load did not load the preflighted candidate bytes.");
				}
				const lkg = await this.candidateStore.createLkg(candidate, this.clock.now(), 0);
				const loadedAtMs = this.clock.now().getTime();
				state = appendHistory(
					{
						...state,
						active: {
							candidateId: candidate.candidateId,
							generation: candidate.generation,
							digest: candidate.digest,
							path: candidate.path,
							attemptId,
							phase: "baseline",
							loadedAtMs,
						},
						pending: null,
						reloading: null,
						health: null,
						lkg,
						lastFailure: null,
					},
					{
						attemptId,
						candidateId: candidate.candidateId,
						generation: candidate.generation,
						digest: candidate.digest,
						phase: "baseline",
						atMs: loadedAtMs,
					},
				);
				const persistedBaseline = await this.persist(state);
				await this.pruneSnapshots(persistedBaseline);
				await this.stateStore.log("baseline.promoted", { candidateId: candidate.candidateId, lkg });
				this.events?.emit("reload.promoted", lkg);
				await this.observer?.completeReload({
					attemptId,
					generation: candidate.generation,
					digest: candidate.digest,
				});
				return { ok: true, lkg, preflight: outcome.report };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				state = appendHistory(
					{
						...state,
						reloading: null,
						lastFailure: {
							attemptId,
							candidateId: candidate.candidateId,
							generation: candidate.generation,
							digest: candidate.digest,
							failedAtMs: this.clock.now().getTime(),
							phase: "reloading",
							reason: message,
							diagnostics: [error instanceof Error ? error.stack ?? message : message],
						},
					},
					{
						attemptId,
						candidateId: candidate.candidateId,
						generation: candidate.generation,
						digest: candidate.digest,
						phase: "failed",
						atMs: this.clock.now().getTime(),
						reason: message,
					},
				);
				await this.persist(state);
				await this.observer?.failReload({ attemptId, reason: message }).catch(() => undefined);
				return { ok: false, error: message, preflight: outcome.report };
			}
		});
	}

	async recordHealthTurn(observation: HealthTurnObservation): Promise<HealthRecordResult> {
		if (!isHealthObservation(observation)) {
			throw new RsiError("HEALTH_TURN_INVALID", "Invalid health turn observation.");
		}
		return this.enqueue(async () => {
			let state = await this.loadState();
			const health = state.health;
			if (state.active === null || health === null || state.reloading !== null) {
				return { count: health?.healthyTurns ?? 0, required: HEALTHY_TURNS_REQUIRED, promoted: false, duplicate: true };
			}
			if (observation.attemptId !== health.attemptId || observation.generation !== health.generation) {
				return { count: health.healthyTurns, required: HEALTHY_TURNS_REQUIRED, promoted: false, duplicate: true };
			}
			const turnKey = `${observation.attemptId}:${observation.generation}:${observation.turnIndex}`;
			const previousTurnIndex = health.lastTurnIndex;
			if (health.lastTurnKey === turnKey || (previousTurnIndex !== null && observation.turnIndex <= previousTurnIndex)) {
				return {
					count: health.healthyTurns,
					required: HEALTHY_TURNS_REQUIRED,
					promoted: state.active.phase === "promoted",
					duplicate: true,
				};
			}
			const healthy = classifyHealthyTurn(observation);
			const advanced = advanceHealthTurns(health.healthyTurns, healthy);
			if (healthy && advanced.readyToPromote && state.active.phase !== "promoted") {
				const candidate = (await this.candidateStore.verifyCandidate(state.active.path)).candidate;
				if (candidate.digest !== state.active.digest || candidate.generation !== state.active.generation) {
					throw new RsiError("CANDIDATE_CHANGED", "Active candidate changed before health promotion.");
				}
				const lkg = await this.candidateStore.createLkg(candidate, this.clock.now(), HEALTHY_TURNS_REQUIRED);
				const promotedAtMs = this.clock.now().getTime();
				state = appendHistory(
					{
						...state,
						active: { ...state.active, phase: "promoted" },
						health: {
							...health,
							healthyTurns: HEALTHY_TURNS_REQUIRED,
							lastTurnKey: turnKey,
							lastTurnIndex: observation.turnIndex,
						},
						lkg,
						lastFailure: null,
					},
					{
						attemptId: state.active.attemptId,
						candidateId: state.active.candidateId,
						generation: state.active.generation,
						digest: state.active.digest,
						phase: "promoted",
						atMs: promotedAtMs,
					},
				);
				const persistedPromotion = await this.persist(state);
				await this.pruneSnapshots(persistedPromotion);
				await this.stateStore.log("reload.promoted", {
					candidateId: candidate.candidateId,
					generation: candidate.generation,
					digest: candidate.digest,
					lkg,
				});
				this.events?.emit("reload.promoted", lkg);
				this.events?.emit("reload.health", {
					observation,
					consecutiveHealthyTurns: HEALTHY_TURNS_REQUIRED,
					required: HEALTHY_TURNS_REQUIRED,
					atMs: promotedAtMs,
				});
				return {
					count: HEALTHY_TURNS_REQUIRED,
					required: HEALTHY_TURNS_REQUIRED,
					promoted: true,
					duplicate: false,
				};
			}
			const count = healthy ? advanced.consecutiveHealthyTurns : 0;
			state = {
				...state,
				health: {
					...health,
					healthyTurns: count,
					lastTurnKey: turnKey,
					lastTurnIndex: observation.turnIndex,
				},
				updatedAtMs: this.clock.now().getTime(),
			};
			await this.persist(state);
			this.events?.emit("reload.health", {
				observation,
				consecutiveHealthyTurns: count,
				required: HEALTHY_TURNS_REQUIRED,
				atMs: this.clock.now().getTime(),
			});
			return {
				count,
				required: HEALTHY_TURNS_REQUIRED,
				promoted: state.active?.phase === "promoted",
				duplicate: false,
			};
		});
	}

	/** Crash or reload interruption resets probation without inventing a promotion. */
	async resetProbation(reason: string): Promise<void> {
		await this.enqueue(async () => {
			let state = await this.loadState();
			if (state.health === null) return;
			state = appendHistory(
				{
					...state,
					health: null,
					active: state.active === null ? null : { ...state.active, phase: state.active.phase === "baseline" ? "baseline" : "probation" },
					reloading: null,
				},
				{
					attemptId: state.active?.attemptId ?? "unknown",
					candidateId: state.active?.candidateId ?? "unknown",
					generation: state.active?.generation ?? 0,
					digest: state.active?.digest ?? "sha256:0",
					phase: "probation",
					atMs: this.clock.now().getTime(),
					reason,
				},
			);
			await this.persist(state);
			await this.stateStore.log("probation.reset", { reason });
		});
	}

	/** Record a Watchdog rollback and point the active loader at the exact LKG snapshot. */
	async markRolledBack(lkg: LkgSnapshot, reason: string): Promise<void> {
		await this.enqueue(async () => {
			const verified = await this.candidateStore.verifyLkg(lkg);
			let state = await this.loadState();
			state = appendHistory(
				{
					...state,
					active: {
						candidateId: verified.candidateId,
						generation: verified.generation,
						digest: verified.digest,
						path: verified.path,
						attemptId: `rollback-${this.idFactory()}`,
						phase: "baseline",
						loadedAtMs: this.clock.now().getTime(),
					},
					pending: null,
					reloading: null,
					health: null,
					lkg,
					updatedAtMs: this.clock.now().getTime(),
				},
				{
					attemptId: `rollback-${lkg.candidateId}`,
					candidateId: lkg.candidateId,
					generation: lkg.generation,
					digest: lkg.digest,
					phase: "rolled-back",
					atMs: this.clock.now().getTime(),
					reason,
				},
			);
			const persistedRollback = await this.persist(state);
			await this.pruneSnapshots(persistedRollback);
			await this.stateStore.log("reload.rolledback", { lkg, reason });
		});
	}

	async getActiveExtensionSet(): Promise<ActiveExtensionSet | null> {
		return this.enqueue(async () => {
			const state = await this.loadState();
			if (state.active === null) return null;
			const candidate = (await this.candidateStore.verifyCandidate(state.active.path)).candidate;
			return {
				candidateId: candidate.candidateId,
				generation: candidate.generation,
				digest: candidate.digest,
				snapshotPath: candidate.path,
				entryPaths: candidate.manifest.entries.map((entry) => join(candidate.path, ...entry.split("/"))).filter(isAbsolute),
			};
		});
	}

	async getLkg(): Promise<LkgSnapshot | null> {
		return this.enqueue(async () => (await this.loadState()).lkg);
	}

	async setStopping(reason: string): Promise<void> {
		this.stoppingReason = reason;
		await this.enqueue(async () => {
			const state = await this.loadState();
			if (state.reloading === null) return;
			await this.persist({
				...state,
				reloading: null,
				health: null,
				lastFailure: {
					attemptId: state.reloading.attemptId,
					candidateId: state.reloading.candidateId,
					generation: state.reloading.generation,
					digest: state.reloading.digest,
					failedAtMs: this.clock.now().getTime(),
					phase: "reloading",
					reason: `reload interrupted by stop: ${reason}`,
				},
				updatedAtMs: this.clock.now().getTime(),
			});
		});
	}

	pluginCandidate(candidate: ReloadCandidate): PluginCandidate {
		return this.candidateStore.toPluginCandidate(candidate);
	}

	initialState(now: Date): ReloadPersistentState {
		return initialReloadPersistentState(now);
	}
}
