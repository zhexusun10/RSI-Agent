import { RsiError } from "../shared/errors.ts";
import type { ContentRevision } from "../shared/hash.ts";
import type { Clock } from "../shared/time.ts";
import type { ReloadCoordinator } from "./reload-coordinator.ts";
import type { ReloadRequest, ReloadRequestResult } from "./types.ts";

export interface ReloadAuthorityPort {
	requestReload(request: ReloadRequest, signal?: AbortSignal): Promise<ReloadRequestResult>;
}

export interface ActiveReloadSession {
	readonly sessionId: string;
	readonly generation: number | null;
	readonly digest: ContentRevision | null;
	readonly registeredAtMs: number;
}

/**
 * The only external reload authority. Control tool, command shim, Worker IPC,
 * and the extension command context must all call this gate. None may call the
 * SDK's ctx.reload directly before a gate authorization completes.
 */
export class ReloadGate implements ReloadAuthorityPort {
	readonly coordinator: ReloadCoordinator;
	readonly clock: Clock;
	private readonly sessions = new Map<string, ActiveReloadSession>();
	private readonly inFlight = new Map<string, Promise<ReloadRequestResult>>();

	constructor(coordinator: ReloadCoordinator, clock: Clock) {
		this.coordinator = coordinator;
		this.clock = clock;
	}

	registerSession(sessionId: string, state: { generation?: number | null; digest?: ContentRevision | null } = {}): () => void {
		if (sessionId.length === 0 || sessionId.length > 128) {
			throw new RsiError("RELOAD_FAILED", "Reload session id must be a non-empty bounded string.");
		}
		this.sessions.set(sessionId, {
			sessionId,
			generation: state.generation ?? null,
			digest: state.digest ?? null,
			registeredAtMs: this.clock.now().getTime(),
		});
		return () => {
			this.sessions.delete(sessionId);
		};
	}

	unregisterSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	listSessions(): readonly ActiveReloadSession[] {
		return [...this.sessions.values()];
	}

	async requestReload(request: ReloadRequest, signal?: AbortSignal): Promise<ReloadRequestResult> {
		if (request.source !== "control" && request.source !== "worker") {
			if (request.sessionId === undefined || !this.sessions.has(request.sessionId)) {
				return {
					ok: false,
					authorized: false,
					code: "SESSION_INACTIVE",
					error: `Reload request from ${request.source} is not bound to an active Pi session.`,
				};
			}
		}
		const key =
			request.dedupeKey ??
			(request.sessionId === undefined
				? undefined
				: `${request.sessionId}:${request.reason}:${request.candidateId ?? ""}`);
		if (key !== undefined) {
			const existing = this.inFlight.get(key);
			if (existing !== undefined) return existing;
		}
		const operation = this.coordinator.requestReload(request, signal).finally(() => {
			if (key !== undefined) this.inFlight.delete(key);
		});
		if (key !== undefined) this.inFlight.set(key, operation);
		const result = await operation;
		if (result.ok) {
			for (const [sessionId, session] of this.sessions) {
				this.sessions.set(sessionId, { ...session, generation: result.generation, digest: result.digest });
			}
		}
		return result;
	}

	requestFromControl(reason: string, candidateId?: string, signal?: AbortSignal): Promise<ReloadRequestResult> {
		return this.requestReload(
			{ reason, source: "control", ...(candidateId === undefined ? {} : { candidateId }) },
			signal,
		);
	}

	requestFromWorker(reason: string, sessionId?: string, signal?: AbortSignal): Promise<ReloadRequestResult> {
		return this.requestReload({ reason, source: "worker", ...(sessionId === undefined ? {} : { sessionId }) }, signal);
	}

	requestFromCommandShim(
		reason: string,
		sessionId: string,
		signal?: AbortSignal,
	): Promise<ReloadRequestResult> {
		return this.requestReload({ reason, source: "command-shim", sessionId }, signal);
	}

	requestFromExtensionCommandContext(
		reason: string,
		sessionId: string,
		signal?: AbortSignal,
	): Promise<ReloadRequestResult> {
		return this.requestReload({ reason, source: "extension-command-context", sessionId }, signal);
	}
}

/** Minimal structural view of Pi's ExtensionCommandContext used by the guard. */
export interface ReloadableExtensionCommandContext {
	reload(): Promise<void>;
}

/**
 * Wrap a Pi ExtensionCommandContext so ctx.reload() can only go through the
 * external reload authority. The original ctx.reload is never invoked by this
 * wrapper; the authority performs the preflight and the real SDK reload in the
 * controlled Worker path.
 */
export function guardExtensionCommandContext<C extends ReloadableExtensionCommandContext>(
	ctx: C,
	authority: ReloadAuthorityPort,
	request: {
		readonly reason: string;
		readonly sessionId: string;
		readonly candidateId?: string;
		readonly dedupeKey?: string;
	},
): C {
	return new Proxy(ctx, {
		get(target, property, receiver) {
			if (property === "reload") {
				return async (): Promise<void> => {
					const result = await authority.requestReload({
						reason: request.reason,
						source: "extension-command-context",
						sessionId: request.sessionId,
						...(request.candidateId === undefined ? {} : { candidateId: request.candidateId }),
						...(request.dedupeKey === undefined ? {} : { dedupeKey: request.dedupeKey }),
					});
					if (!result.ok) {
						throw new RsiError("RELOAD_FAILED", result.error, {
							details: { code: result.code, ...(result.diagnostics === undefined ? {} : { diagnostics: [...result.diagnostics] }) },
						});
					}
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
}

/**
 * Command-shim guard for slash commands or control handlers. The handler must
 * call the returned function instead of any local real reload.
 */
export function guardReloadCommand(
	authority: ReloadAuthorityPort,
	request: {
		readonly reason: string;
		readonly sessionId: string;
		readonly candidateId?: string;
		readonly dedupeKey?: string;
	},
): () => Promise<ReloadRequestResult> {
	return () =>
		authority.requestReload({
			reason: request.reason,
			source: "command-shim",
			sessionId: request.sessionId,
			...(request.candidateId === undefined ? {} : { candidateId: request.candidateId }),
			...(request.dedupeKey === undefined ? {} : { dedupeKey: request.dedupeKey }),
		});
}
