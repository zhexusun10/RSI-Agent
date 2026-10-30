import { lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { RsiError } from "../shared/errors.ts";
import { isPathWithin } from "../shared/paths.ts";
import {
	assertControlRequest,
	controlTokensEqual,
	createControlFailure,
	createControlSuccess,
	type ControlRequestEnvelope,
	type ControlResponseEnvelope,
} from "./protocol.ts";
import type { ReloadCoordinator } from "./reload.ts";
import { CONTROL_MAX_FRAME_BYTES } from "./types.ts";

export interface ControlServerOptions {
	readonly endpoint: string;
	/** External socket paths must stay below this protected state directory. */
	readonly endpointRoot?: string;
	readonly token?: string;
	readonly reload?: ReloadCoordinator;
	readonly currentGeneration: () => number | null;
	readonly currentSessionId?: () => string | null;
	readonly maxFrameBytes?: number;
	readonly maxRememberedRequests?: number;
	/** Optional trusted Supervisor command dispatcher (reload/shutdown/cancelSleep). */
	readonly dispatch?: (request: ControlRequestEnvelope) => Promise<{
		readonly detail: string;
		readonly generation?: number | null;
		readonly attemptId?: string;
	}>;
}

interface RememberedRequest {
	readonly fingerprint: string;
	readonly response: Promise<ControlResponseEnvelope>;
}

function isWindowsPipe(endpoint: string): boolean {
	return process.platform === "win32" && endpoint.startsWith("\\\\.\\pipe\\");
}

function requestFingerprint(request: ControlRequestEnvelope): string {
	return JSON.stringify({
		source: request.source,
		generation: request.generation,
		sessionId: request.sessionId,
		command: request.command,
	});
}

/**
 * Minimal external control listener. It exposes only the shared reload
 * command to the Worker shim; it has no file-write, shell, model, thinking,
 * or shutdown operation. Request ids are idempotent for this process.
 */
export class ControlServer {
	private readonly options: ControlServerOptions;
	private readonly maxFrameBytes: number;
	private readonly maxRememberedRequests: number;
	private server: Server | undefined;
	private readonly sockets = new Set<Socket>();
	private readonly remembered = new Map<string, RememberedRequest>();

	constructor(options: ControlServerOptions) {
		this.options = options;
		this.maxFrameBytes = options.maxFrameBytes ?? CONTROL_MAX_FRAME_BYTES;
		this.maxRememberedRequests = options.maxRememberedRequests ?? 128;
		if (
			typeof options.endpoint !== "string" ||
			options.endpoint.length === 0 ||
			options.endpoint.includes("\u0000")
		) {
			throw new RsiError("CONFIG_INVALID", "Control endpoint is invalid.");
		}
		if (options.endpointRoot !== undefined && !isWindowsPipe(options.endpoint)) {
			if (!isPathWithin(options.endpointRoot, options.endpoint)) {
				throw new RsiError("PATH_OUTSIDE_ROOT", "Control endpoint must be below the protected state directory.");
			}
		}
	}

	get endpoint(): string {
		return this.options.endpoint;
	}

	async listen(): Promise<void> {
		if (this.server) return;
		if (!isWindowsPipe(this.options.endpoint)) {
			await mkdir(dirname(this.options.endpoint), { recursive: true, mode: 0o700 });
			try {
				const existing = await lstat(this.options.endpoint);
				if (existing.isSymbolicLink()) {
					throw new RsiError("PATH_SYMLINK_FORBIDDEN", "Control endpoint must not be a symlink.");
				}
				if (!existing.isSocket()) {
					throw new RsiError("CONFIG_INVALID", "Control endpoint exists and is not a socket.");
				}
				await unlink(this.options.endpoint);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					if (error instanceof RsiError) throw error;
					throw error;
				}
			}
		}
		const server = createServer((socket) => this.accept(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen({ path: this.options.endpoint });
		});
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (!isWindowsPipe(this.options.endpoint)) {
			await unlink(this.options.endpoint).catch(() => undefined);
		}
		this.remembered.clear();
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		let buffer = Buffer.alloc(0);
		let handled = false;
		socket.on("close", () => this.sockets.delete(socket));
		socket.on("error", () => this.sockets.delete(socket));
		socket.on("data", (chunk: Buffer) => {
			if (handled) return;
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > this.maxFrameBytes) {
				handled = true;
				socket.destroy();
				return;
			}
			const newline = buffer.indexOf(0x0a);
			if (newline === -1) return;
			handled = true;
			const line = buffer
				.subarray(0, newline)
				.toString("utf8")
				.replace(/\r$/u, "");
			buffer = Buffer.alloc(0);
			void this.handleLine(line).then((response) => {
				if (socket.destroyed) return;
				socket.end(`${JSON.stringify(response)}\n`);
			});
		});
	}

	private async handleLine(line: string): Promise<ControlResponseEnvelope> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			return createControlFailure("invalid-request", error);
		}
		let request: ControlRequestEnvelope;
		try {
			request = assertControlRequest(parsed);
		} catch (error) {
			const candidateId =
				typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
					? (parsed as { requestId?: unknown }).requestId
					: undefined;
			return createControlFailure(typeof candidateId === "string" ? candidateId : "invalid-request", error);
		}
		if (this.options.token !== undefined && !controlTokensEqual(this.options.token, request.token)) {
			return createControlFailure(request.requestId, new RsiError("AGENT_COMMAND_FORBIDDEN", "Control token is invalid."));
		}
		const fingerprint = requestFingerprint(request);
		const existing = this.remembered.get(request.requestId);
		if (existing) {
			if (existing.fingerprint !== fingerprint) {
				return createControlFailure(
					request.requestId,
					new RsiError("IPC_REQUEST_ID_INVALID", "requestId was reused with a different control payload."),
				);
			}
			return existing.response;
		}
		const response = this.process(request);
		this.remembered.set(request.requestId, { fingerprint, response });
		if (this.remembered.size > this.maxRememberedRequests) {
			const oldest = this.remembered.keys().next().value;
			if (oldest !== undefined) this.remembered.delete(oldest);
		}
		return response;
	}

	private async process(request: ControlRequestEnvelope): Promise<ControlResponseEnvelope> {
		try {
			if (this.options.dispatch) {
				const result = await this.options.dispatch(request);
				return createControlSuccess(request.requestId, {
					detail: result.detail,
					generation: result.generation === undefined ? this.options.currentGeneration() : result.generation,
					...(result.attemptId === undefined ? {} : { attemptId: result.attemptId }),
				});
			}
			if (request.source !== "worker-shim") {
				throw new RsiError("AGENT_COMMAND_FORBIDDEN", "External control listener accepts only the Worker shim.");
			}
			if (request.command.kind !== "reload") {
				throw new RsiError(
					"AGENT_COMMAND_FORBIDDEN",
					"External control supports only reload; shutdown, sleep cancellation, and model/thinking changes are not exposed.",
				);
			}
			if (this.options.reload === undefined) {
				throw new RsiError("INTERNAL", "No reload authority is configured.");
			}
			const currentGeneration = this.options.currentGeneration();
			// The in-sandbox shim may omit generation when it cannot observe the
			// external counter. An explicit numeric generation is still checked and a
			// stale value is rejected; omission is not allowed to skip preflight.
			if (request.generation !== null && request.generation !== currentGeneration) {
				throw new RsiError("RELOAD_FAILED", "Control request generation is stale.", {
					retryable: true,
					details: { requested: request.generation, current: currentGeneration },
				});
			}
			const currentSession = this.options.currentSessionId?.() ?? null;
			if (
				request.sessionId !== null &&
				currentSession !== null &&
				request.sessionId !== currentSession
			) {
				throw new RsiError("RELOAD_FAILED", "Control request session does not match the active session.", {
					retryable: true,
				});
			}
			const outcome = await this.options.reload.request({
				requestId: request.requestId,
				reason: request.command.reason,
				...(request.command.candidateId === undefined
					? {}
					: { candidateId: request.command.candidateId }),
				source: request.source,
				generation: request.generation,
				sessionId: request.sessionId,
			});
			return createControlSuccess(request.requestId, {
				detail: outcome.detail,
				generation: outcome.generation,
				...(outcome.attemptId === undefined ? {} : { attemptId: outcome.attemptId }),
			});
		} catch (error) {
			return createControlFailure(request.requestId, error);
		}
	}
}
