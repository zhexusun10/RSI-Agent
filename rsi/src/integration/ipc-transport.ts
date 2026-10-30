import { createServer, connect, type Server, type Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
	isValidWorkerBootstrapToken,
	isValidWorkerGeneration,
	isValidWorkerLaunchId,
	type WorkerAuthenticationRequest,
	type WorkerAuthenticationResult,
} from "../shared/ipc/bootstrap.ts";
import { RsiError, rsiErrorFromPayload, toRsiErrorPayload } from "../shared/errors.ts";
import {
	decodeIpcLine,
	encodeIpcFrame,
	IpcFrameDecoder,
} from "../shared/ipc/codec.ts";
import type { IpcRequestContext } from "../shared/ipc/port.ts";
import {
	eventFrame,
	errorResponseFrame,
	isIpcEvent,
	isIpcRequest,
	isIpcResponse,
	isSupervisorToWorkerMethod,
	isWorkerToSupervisorMethod,
	requestFrame,
	WORKER_AUTHENTICATE_METHOD,
	responseFrame,
	type IpcFrame,
	type IpcMethod,
	type IpcRequest,
	type SupervisorToWorkerEvent,
	type SupervisorToWorkerEvents,
	type SupervisorToWorkerMethod,
	type SupervisorToWorkerRequests,
	type WorkerToSupervisorEvent,
	type WorkerToSupervisorEvents,
	type WorkerToSupervisorMethod,
	type WorkerToSupervisorRequests,
} from "../shared/ipc/protocol.ts";
import { assertIpcDirection } from "../shared/ipc/port.ts";

export const WORKER_IPC_ENDPOINT_ENV = "RSI_WORKER_IPC_ENDPOINT";
export const DEFAULT_IPC_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_WORKER_HANDSHAKE_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_PENDING_IPC_PEERS = 8;
export const DEFAULT_WORKER_EXPECTATION_TIMEOUT_MS = 60_000;
const MAX_QUEUED_INBOUND_FRAMES = 256;

type AnyHandler = (
	payload: unknown,
	context: IpcRequestContext,
) => Promise<unknown> | unknown;
type AnyEventListener = (payload: unknown) => void | Promise<void>;

interface PendingRequest {
	readonly method: IpcMethod;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
	readonly timer: NodeJS.Timeout;
}

interface SocketPeerAuthentication {
	readonly handler: (payload: unknown) => Promise<unknown>;
	readonly onAuthenticated: () => void;
}

export interface WorkerConnectionIdentity {
	readonly launchId: string;
	readonly generation: number | null;
}

export interface ExpectedWorkerConnection extends WorkerConnectionIdentity {
	readonly token: string;
}

function safeTokenEqual(left: string, right: string): boolean {
	if (!isValidWorkerBootstrapToken(left) || !isValidWorkerBootstrapToken(right)) return false;
	const leftBytes = Buffer.from(left, "utf8");
	const rightBytes = Buffer.from(right, "utf8");
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseAuthenticationRequest(payload: unknown): WorkerAuthenticationRequest {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new RsiError("IPC_AUTH_FAILED", "Worker authentication payload is invalid.");
	}
	const record = payload as Record<string, unknown>;
	if (
		!isValidWorkerLaunchId(record.launchId) ||
		!isValidWorkerBootstrapToken(record.token) ||
		!isValidWorkerGeneration(record.generation)
	) {
		throw new RsiError("IPC_AUTH_FAILED", "Worker authentication credentials are invalid.");
	}
	return {
		launchId: record.launchId,
		token: record.token,
		generation: record.generation,
	};
}

function assertEndpoint(endpoint: string): void {
	if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.includes("\u0000")) {
		throw new RsiError("CONFIG_INVALID", "IPC endpoint must be a non-empty string without NUL.");
	}
}

function isTcpEndpoint(endpoint: string): boolean {
	return endpoint.startsWith("tcp://");
}

export function tcpEndpointPort(endpoint: string): number {
	const parsed = /^tcp:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(endpoint);
	const port = parsed?.[1] === undefined ? NaN : Number(parsed[1]);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new RsiError("CONFIG_INVALID", `Invalid loopback test IPC endpoint: ${endpoint}`);
	}
	return port;
}

/** One full-duplex, LF-NDJSON IPC peer. stdout/stderr are never used for protocol. */
class SocketPeer {
	readonly side: "supervisor" | "worker";
	readonly socket: Socket;
	readonly maxFrameBytes: number;
	readonly requestTimeoutMs: number;
	private readonly decoder: IpcFrameDecoder;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly handlers = new Map<string, AnyHandler>();
	private readonly events = new Map<string, Set<AnyEventListener>>();
	private readonly authentication: SocketPeerAuthentication | undefined;
	private authenticatedValue = false;
	private inboundChain: Promise<void> = Promise.resolve();
	private inboundPending = 0;
	private writeChain: Promise<void> = Promise.resolve();
	private closedValue = false;
	private readonly closedResolve: () => void;
	private readonly closedPromise: Promise<void>;
	private writeError: unknown;

	constructor(
		socket: Socket,
		options: {
			readonly side: "supervisor" | "worker";
			readonly maxFrameBytes: number;
			readonly requestTimeoutMs: number;
			readonly authentication?: SocketPeerAuthentication;
		},
	) {
		this.socket = socket;
		this.side = options.side;
		this.maxFrameBytes = options.maxFrameBytes;
		this.requestTimeoutMs = options.requestTimeoutMs;
		this.authentication = options.authentication;
		this.decoder = new IpcFrameDecoder({ maxFrameBytes: this.maxFrameBytes });
		let resolveClosed: () => void = () => undefined;
		this.closedPromise = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});
		this.closedResolve = resolveClosed;
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		socket.on("error", () => this.onClose());
		socket.on("close", () => this.onClose());
	}

	get closed(): Promise<void> {
		return this.closedPromise;
	}

	get isClosed(): boolean {
		return this.closedValue;
	}

	get authenticated(): boolean {
		return this.authenticatedValue;
	}

	handle(method: string, handler: AnyHandler): () => void {
		if (this.side === "supervisor") {
			if (!isWorkerToSupervisorMethod(method)) {
				throw new RsiError("IPC_DIRECTION_FORBIDDEN", `Supervisor cannot handle ${method}.`);
			}
		} else if (!isSupervisorToWorkerMethod(method)) {
			throw new RsiError("IPC_DIRECTION_FORBIDDEN", `Worker cannot handle ${method}.`);
		}
		this.handlers.set(method, handler);
		return () => {
			if (this.handlers.get(method) === handler) this.handlers.delete(method);
		};
	}

	onEvent(event: string, handler: AnyEventListener): () => void {
		const set = this.events.get(event) ?? new Set<AnyEventListener>();
		set.add(handler);
		this.events.set(event, set);
		return () => set.delete(handler);
	}

	request(method: IpcMethod, payload: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
		if (this.closedValue) return Promise.reject(new RsiError("IPC_CLOSED", "IPC peer is closed."));
		assertIpcDirection(method, this.side === "supervisor" ? "supervisor-to-worker" : "worker-to-supervisor");
		if (options.signal?.aborted) {
			return Promise.reject(options.signal.reason ?? new RsiError("IPC_CLOSED", "IPC request aborted."));
		}
		const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
		const frame = requestFrame(
			method as WorkerToSupervisorMethod,
			payload as WorkerToSupervisorRequests[WorkerToSupervisorMethod]["request"],
			{ timeoutMs },
		);
		return new Promise<unknown>((resolve, reject) => {
			const onAbort = (): void => {
				const pending = this.pending.get(frame.requestId);
				if (pending === undefined) return;
				clearTimeout(pending.timer);
				this.pending.delete(frame.requestId);
				reject(options.signal?.reason ?? new RsiError("IPC_CLOSED", "IPC request aborted."));
			};
			const timer = setTimeout(() => {
				const pending = this.pending.get(frame.requestId);
				if (pending === undefined) return;
				this.pending.delete(frame.requestId);
				options.signal?.removeEventListener("abort", onAbort);
				reject(new RsiError("IPC_TIMEOUT", `IPC request ${method} timed out.`, { retryable: true }));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(frame.requestId, {
				method,
				resolve: (value) => {
					options.signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				reject: (error) => {
					options.signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
				timer,
			});
			options.signal?.addEventListener("abort", onAbort, { once: true });
			void this.send(frame).catch((error) => {
				const pending = this.pending.get(frame.requestId);
				if (pending === undefined) return;
				clearTimeout(pending.timer);
				this.pending.delete(frame.requestId);
				pending.reject(error);
			});
		});
	}

	sendEvent(event: string, payload: unknown): void {
		if (this.closedValue) return;
		const actual = this.side === "supervisor" ? "supervisor-to-worker" : "worker-to-supervisor";
		void this.send(eventFrame(event as never, payload as never)).catch(() => undefined);
		void actual;
	}

	async close(): Promise<void> {
		if (this.closedValue) return;
		this.socket.destroy();
		this.onClose();
		await this.writeChain.catch(() => undefined);
	}

	private async send(frame: IpcFrame): Promise<void> {
		if (this.closedValue) throw new RsiError("IPC_CLOSED", "IPC peer is closed.");
		const bytes = encodeIpcFrame(frame, { maxFrameBytes: this.maxFrameBytes });
		this.writeChain = this.writeChain.then(
			() =>
				new Promise<void>((resolve, reject) => {
					if (this.closedValue) {
						reject(new RsiError("IPC_CLOSED", "IPC peer closed before write."));
						return;
					}
					if (this.socket.writableLength + bytes.length > this.maxFrameBytes * 4) {
						reject(
							new RsiError("IPC_BACKPRESSURE", "IPC transport write queue is full.", {
								retryable: true,
							}),
						);
						return;
					}
					this.socket.write(bytes, (error?: Error | null) => {
						if (error) reject(new RsiError("IPC_CLOSED", `IPC write failed: ${error.message}`, { cause: error }));
						else resolve();
					});
				}),
			(error) => {
				this.writeError = error;
				throw error;
			},
		);
		await this.writeChain;
	}

	private onData(chunk: Buffer): void {
		if (this.closedValue) return;
		let frames: IpcFrame[];
		try {
			frames = this.decoder.push(chunk);
		} catch (error) {
			this.fail(error);
			return;
		}
		for (const frame of frames) {
			if (this.authentication !== undefined && !this.authenticatedValue) {
				if (this.inboundPending >= MAX_QUEUED_INBOUND_FRAMES) {
					this.fail(new RsiError("IPC_BACKPRESSURE", "IPC inbound frame queue is full."));
					return;
				}
				this.inboundPending += 1;
				this.inboundChain = this.inboundChain.then(async () => {
					try {
						await this.processUnauthenticatedFrame(frame);
					} catch (error) {
						this.fail(error);
					} finally {
						this.inboundPending -= 1;
					}
				});
			} else {
				this.dispatchFrame(frame);
			}
		}
	}

	/**
	 * Only the pre-authentication phase is serialized. Normal request handlers
	 * may issue nested requests over this same connection (for example the Worker
	 * calling reload.preflight while handling control.reload), so awaiting a
	 * handler here would deadlock the response path.
	 */
	private async processUnauthenticatedFrame(frame: IpcFrame): Promise<void> {
		if (this.closedValue) return;
		if (this.authenticatedValue) {
			this.dispatchFrame(frame);
			return;
		}
		if (!isIpcRequest(frame) || frame.method !== WORKER_AUTHENTICATE_METHOD) {
			if (isIpcRequest(frame)) {
				await this.send(
					errorResponseFrame(
						frame,
						new RsiError("IPC_AUTH_FAILED", "Worker authentication must be the first request.").toPayload(),
					),
				).catch(() => undefined);
			}
			this.fail(new RsiError("IPC_AUTH_FAILED", "Unauthenticated IPC peer did not authenticate first."));
			return;
		}
		await this.authenticate(frame);
	}

	private dispatchFrame(frame: IpcFrame): void {
		if (this.closedValue) return;
		if (this.authentication !== undefined && isIpcRequest(frame) && frame.method === WORKER_AUTHENTICATE_METHOD) {
			this.fail(new RsiError("IPC_AUTH_FAILED", "An authenticated IPC peer cannot authenticate again."));
			return;
		}
		if (isIpcResponse(frame)) this.onResponse(frame);
		else if (isIpcRequest(frame)) {
			void this.onRequest(frame).catch((error) => this.fail(error));
		} else if (isIpcEvent(frame)) this.onEventFrame(frame);
	}

	private async authenticate(frame: IpcRequest): Promise<void> {
		const authentication = this.authentication;
		if (authentication === undefined) return;
		try {
			const result = await authentication.handler(frame.payload);
			if (this.closedValue) return;
			this.authenticatedValue = true;
			authentication.onAuthenticated();
			await this.send(responseFrame(frame as never, result as never));
		} catch (error) {
			const failure = error instanceof RsiError
				? error
				: new RsiError("IPC_AUTH_FAILED", "Worker authentication failed.", { cause: error });
			await this.send(errorResponseFrame(frame as never, failure.toPayload())).catch(() => undefined);
			this.fail(failure);
		}
	}

	private onResponse(frame: IpcFrame): void {
		if (!isIpcResponse(frame)) return;
		const pending = this.pending.get(frame.requestId);
		if (pending === undefined || pending.method !== frame.method) return;
		clearTimeout(pending.timer);
		this.pending.delete(frame.requestId);
		if (frame.ok) pending.resolve(frame.result);
		else pending.reject(rsiErrorFromPayload(frame.error));
	}

	private async onRequest(frame: IpcRequest): Promise<void> {
		const expected = this.side === "supervisor" ? "worker-to-supervisor" : "supervisor-to-worker";
		if (this.side === "supervisor" ? !isWorkerToSupervisorMethod(frame.method) : !isSupervisorToWorkerMethod(frame.method)) {
			await this.send(errorResponseFrame(frame, new RsiError("IPC_DIRECTION_FORBIDDEN", `Method ${frame.method} is not accepted by this peer.`).toPayload()));
			return;
		}
		assertIpcDirection(frame.method, expected);
		const handler = this.handlers.get(frame.method);
		if (handler === undefined) {
			await this.send(
				errorResponseFrame(
					frame,
					new RsiError("IPC_METHOD_UNKNOWN", `No handler registered for ${frame.method}.`).toPayload(),
				),
			);
			return;
		}
		const timeoutMs = Math.min(frame.timeoutMs ?? this.requestTimeoutMs, 120_000);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new RsiError("IPC_TIMEOUT", `IPC handler ${frame.method} timed out.`, { retryable: true })), timeoutMs);
		timer.unref?.();
		try {
			const result = await handler(frame.payload, {
				requestId: frame.requestId,
				receivedAtMs: Date.now(),
				signal: controller.signal,
			});
			await this.send(responseFrame(frame as never, result as never));
		} catch (error) {
			await this.send(errorResponseFrame(frame, toRsiErrorPayload(error, "INTERNAL", frame.requestId)));
		} finally {
			clearTimeout(timer);
		}
	}

	private onEventFrame(frame: Extract<IpcFrame, { type: "event" }>): void {
		const set = this.events.get(frame.event);
		if (set === undefined) return;
		for (const handler of set) {
			Promise.resolve()
				.then(() => handler(frame.payload))
				.catch(() => undefined);
		}
	}

	private fail(error: unknown): void {
		this.writeError = error;
		this.socket.destroy();
		this.onClose();
	}

	private onClose(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		for (const [requestId, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(
				this.writeError ?? new RsiError("IPC_CLOSED", `IPC peer closed while ${pending.method} was pending.`, { cause: this.writeError }),
			);
			this.pending.delete(requestId);
		}
		this.closedResolve();
	}
}

export interface SupervisorIpcHostOptions {
	readonly endpoint: string;
	readonly endpointRoot?: string;
	readonly maxFrameBytes: number;
	readonly requestTimeoutMs: number;
	readonly allowTcpForTests?: boolean;
	readonly socketGroupId?: number;
	/** Bound between TCP accept and the one-time Worker authentication request. */
	readonly handshakeTimeoutMs?: number;
	/** Maximum unauthenticated sockets held concurrently. Authenticated peers are separate. */
	readonly maxPendingConnections?: number;
	/** How long a Supervisor-issued one-time launch credential remains valid. */
	readonly workerExpectationTimeoutMs?: number;
	readonly onPeer?: (peer: SupervisorPeer | null) => void;
	readonly onDiagnostic?: (message: string) => void;
}

export class SupervisorPeer {
	readonly peer: SocketPeer;
	readonly maxFrameBytes: number;

	constructor(peer: SocketPeer) {
		this.peer = peer;
		this.maxFrameBytes = peer.maxFrameBytes;
	}

	request<M extends SupervisorToWorkerMethod>(
		method: M,
		payload: SupervisorToWorkerRequests[M]["request"],
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<SupervisorToWorkerRequests[M]["response"]> {
		return this.peer.request(method, payload, options) as Promise<SupervisorToWorkerRequests[M]["response"]>;
	}

	sendEvent<E extends SupervisorToWorkerEvent>(event: E, payload: SupervisorToWorkerEvents[E]): void {
		this.peer.sendEvent(event, payload);
	}

	onEvent<E extends WorkerToSupervisorEvent>(
		event: E,
		handler: (payload: WorkerToSupervisorEvents[E]) => void | Promise<void>,
	): () => void {
		return this.peer.onEvent(event, handler as AnyEventListener);
	}

	handle<M extends WorkerToSupervisorMethod>(
		method: M,
		handler: (
			payload: WorkerToSupervisorRequests[M]["request"],
			context: IpcRequestContext,
		) => Promise<WorkerToSupervisorRequests[M]["response"]> | WorkerToSupervisorRequests[M]["response"],
	): () => void {
		return this.peer.handle(method, handler as AnyHandler);
	}

	async close(): Promise<void> {
		await this.peer.close();
	}

	get closed(): Promise<void> {
		return this.peer.closed;
	}
}

/** Listening Supervisor endpoint. It keeps registrations across Worker reconnects. */
export class SupervisorIpcHost {
	readonly options: SupervisorIpcHostOptions;
	private server: Server | undefined;
	private peerValue: SupervisorPeer | null = null;
	private expectedWorker: (ExpectedWorkerConnection & { readonly expiresAtMs: number }) | null = null;
	private expectationTimer: NodeJS.Timeout | undefined;
	private readonly pendingPeers = new Set<SocketPeer>();
	private readonly pendingTimers = new Map<SocketPeer, NodeJS.Timeout>();
	private readonly peerIdentities = new WeakMap<SupervisorPeer, WorkerConnectionIdentity>();
	private readonly candidateIdentities = new WeakMap<SocketPeer, WorkerConnectionIdentity>();
	private readonly handlers = new Map<string, AnyHandler>();
	private readonly events = new Map<string, Set<AnyEventListener>>();
	private readonly peerWaiters = new Set<(peer: SupervisorPeer) => void>();
	private closedValue = false;
	private readonly closedResolve: () => void;
	readonly closed: Promise<void>;

	constructor(options: SupervisorIpcHostOptions) {
		this.options = options;
		let resolveClosed: () => void = () => undefined;
		this.closed = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});
		this.closedResolve = resolveClosed;
	}

	get endpoint(): string {
		return this.options.endpoint;
	}

	get connected(): boolean {
		return this.peerValue !== null;
	}

	/** Identity of the currently authenticated Worker connection, if any. */
	get currentIdentity(): WorkerConnectionIdentity | null {
		return this.peerValue === null ? null : this.peerIdentities.get(this.peerValue) ?? null;
	}

	/**
	 * Issue exactly one one-time credential for the Worker process the Supervisor
	 * is about to spawn. A new launch revokes the previous connection before the
	 * new process can connect, so a late old peer cannot update state.
	 */
	expectWorker(input: ExpectedWorkerConnection): void {
		if (this.closedValue) throw new RsiError("IPC_CLOSED", "IPC host is closed.");
		if (!isValidWorkerLaunchId(input.launchId)) {
			throw new RsiError("CONFIG_INVALID", "Worker launchId is invalid.");
		}
		if (!isValidWorkerBootstrapToken(input.token)) {
			throw new RsiError("CONFIG_INVALID", "Worker bootstrap token is invalid.");
		}
		if (!isValidWorkerGeneration(input.generation)) {
			throw new RsiError("CONFIG_INVALID", "Worker expected generation is invalid.");
		}
		this.clearExpectedWorker();
		if (this.peerValue !== null) this.revokeCurrentPeer("new Worker launch issued a fresh identity");
		const timeoutMs = this.options.workerExpectationTimeoutMs ?? DEFAULT_WORKER_EXPECTATION_TIMEOUT_MS;
		const expected = {
			launchId: input.launchId,
			token: input.token,
			generation: input.generation,
			expiresAtMs: Date.now() + timeoutMs,
		};
		this.expectedWorker = expected;
		this.expectationTimer = setTimeout(() => {
			if (this.expectedWorker === expected) this.clearExpectedWorker();
		}, timeoutMs);
		this.expectationTimer.unref?.();
	}

	cancelExpectedWorker(launchId: string): void {
		if (this.expectedWorker?.launchId === launchId) this.clearExpectedWorker();
	}

	revokeWorkerLaunch(launchId: string): void {
		if (this.expectedWorker?.launchId === launchId) this.clearExpectedWorker();
		const peer = this.peerValue;
		if (peer !== null && this.peerIdentities.get(peer)?.launchId === launchId) {
			this.revokeCurrentPeer("Worker launch was rejected or failed");
		}
	}

	private clearExpectedWorker(): void {
		this.expectedWorker = null;
		if (this.expectationTimer !== undefined) clearTimeout(this.expectationTimer);
		this.expectationTimer = undefined;
	}

	private authenticateExpected(payload: unknown): WorkerConnectionIdentity {
		const request = parseAuthenticationRequest(payload);
		const expected = this.expectedWorker;
		const valid =
			expected !== null &&
			Date.now() <= expected.expiresAtMs &&
			expected.launchId === request.launchId &&
			expected.generation === request.generation &&
			safeTokenEqual(expected.token, request.token);
		if (!valid) {
			throw new RsiError("IPC_AUTH_FAILED", "Worker launch credential is unknown, expired, or already used.");
		}
		// Consume before the response is written: the credential can never be
		// replayed by a second connection, even if the first peer later closes.
		this.clearExpectedWorker();
		return { launchId: expected.launchId, generation: expected.generation };
	}

	private clearPendingPeer(raw: SocketPeer): void {
		this.pendingPeers.delete(raw);
		const timer = this.pendingTimers.get(raw);
		if (timer !== undefined) clearTimeout(timer);
		this.pendingTimers.delete(raw);
	}

	private promotePeer(raw: SocketPeer, peer: SupervisorPeer): void {
		if (this.closedValue || raw.isClosed) {
			void raw.close();
			return;
		}
		const identity = this.candidateIdentities.get(raw);
		if (identity === undefined) {
			void raw.close();
			return;
		}
		this.clearPendingPeer(raw);
		const previous = this.peerValue;
		if (previous !== null) {
			const previousIdentity = this.peerIdentities.get(previous);
			if (previousIdentity?.launchId !== identity.launchId) {
				this.revokeCurrentPeer("an authenticated replacement Worker connected");
			} else {
				void raw.close();
				return;
			}
		}
		for (const [method, handler] of this.handlers) raw.handle(method, handler);
		for (const [event, listeners] of this.events) {
			for (const listener of listeners) raw.onEvent(event, listener);
		}
		this.peerIdentities.set(peer, identity);
		this.peerValue = peer;
		for (const waiter of this.peerWaiters) waiter(peer);
		this.peerWaiters.clear();
		this.options.onPeer?.(peer);
	}

	private revokeCurrentPeer(reason: string): void {
		const peer = this.peerValue;
		if (peer === null) return;
		const identity = this.peerIdentities.get(peer);
		this.peerValue = null;
		this.peerIdentities.delete(peer);
		if (identity !== undefined) {
			this.options.onDiagnostic?.(`revoked Worker launch ${identity.launchId}: ${reason}`);
		}
		this.options.onPeer?.(null);
		void peer.close().catch(() => undefined);
	}

	async listen(): Promise<void> {
		if (this.server) return;
		const endpoint = this.options.endpoint;
		assertEndpoint(endpoint);
		const tcp = isTcpEndpoint(endpoint);
		if (tcp && this.options.allowTcpForTests !== true) {
			throw new RsiError("CONFIG_INVALID", "TCP IPC is available only in explicit loopback test mode.");
		}
		if (!tcp) {
			if (this.options.endpointRoot !== undefined) {
				const root = this.options.endpointRoot;
				if (!endpoint.startsWith(root) || endpoint === root) {
					throw new RsiError("PATH_OUTSIDE_ROOT", "IPC endpoint must be below the protected state directory.");
				}
			}
			await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
			try {
				const existing = await lstat(endpoint);
				if (existing.isSymbolicLink() || !existing.isSocket()) {
					throw new RsiError("CONFIG_INVALID", "IPC endpoint exists and is not a socket.");
				}
				await unlink(endpoint);
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
				reject(new RsiError("IPC_CLOSED", `IPC listen failed: ${error.message}`, { cause: error }));
			};
			const onListening = (): void => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			if (tcp) server.listen(tcpEndpointPort(endpoint), "127.0.0.1");
			else server.listen(endpoint);
		});
		if (!tcp) {
			if (this.options.socketGroupId !== undefined) {
				await chmod(endpoint, 0o660).catch(() => undefined);
				try {
					const { chown } = await import("node:fs/promises");
					await chown(endpoint, process.getuid?.() ?? 0, this.options.socketGroupId);
				} catch {
					// The runtime wrapper may set the group; connection still needs mode 0660.
				}
			} else {
				await chmod(endpoint, 0o660).catch(() => undefined);
			}
		}
	}

	private accept(socket: Socket): void {
		socket.setNoDelay?.(true);
		if (this.closedValue) {
			socket.destroy();
			return;
		}
		const maxPending = this.options.maxPendingConnections ?? DEFAULT_MAX_PENDING_IPC_PEERS;
		if (this.pendingPeers.size >= maxPending) {
			socket.destroy();
			return;
		}
		let peer: SupervisorPeer | undefined;
		const raw = new SocketPeer(socket, {
			side: "supervisor",
			maxFrameBytes: this.options.maxFrameBytes,
			requestTimeoutMs: this.options.requestTimeoutMs,
			authentication: {
				handler: async (payload) => {
					const identity = this.authenticateExpected(payload);
					this.candidateIdentities.set(raw, identity);
					return {
						accepted: true as const,
						launchId: identity.launchId,
						generation: identity.generation,
						serverTimeMs: Date.now(),
					} satisfies WorkerAuthenticationResult;
				},
				onAuthenticated: () => {
					if (peer !== undefined) this.promotePeer(raw, peer);
				},
			},
		});
		peer = new SupervisorPeer(raw);
		this.pendingPeers.add(raw);
		const handshakeTimeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_WORKER_HANDSHAKE_TIMEOUT_MS;
		const timer = setTimeout(() => {
			if (!raw.authenticated && !raw.isClosed) {
				this.options.onDiagnostic?.("closing IPC peer that did not authenticate before the deadline");
				void raw.close();
			}
		}, handshakeTimeoutMs);
		timer.unref?.();
		this.pendingTimers.set(raw, timer);
		void raw.closed.then(() => {
			this.clearPendingPeer(raw);
			if (this.peerValue === peer) {
				this.peerValue = null;
				if (peer !== undefined) this.peerIdentities.delete(peer);
				this.options.onPeer?.(null);
			}
		});
	}

	async waitForPeer(timeoutMs = 10_000): Promise<SupervisorPeer> {
		if (this.peerValue !== null) return this.peerValue;
		return new Promise<SupervisorPeer>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.peerWaiters.delete(waiter);
				reject(new RsiError("IPC_TIMEOUT", "Worker IPC connection did not arrive.", { retryable: true }));
			}, timeoutMs);
			timer.unref?.();
			const waiter = (peer: SupervisorPeer): void => {
				clearTimeout(timer);
				resolve(peer);
			};
			this.peerWaiters.add(waiter);
		});
	}

	request<M extends SupervisorToWorkerMethod>(
		method: M,
		payload: SupervisorToWorkerRequests[M]["request"],
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<SupervisorToWorkerRequests[M]["response"]> {
		if (this.peerValue === null) {
			return Promise.reject(new RsiError("IPC_CLOSED", "Worker IPC peer is not connected.", { retryable: true }));
		}
		return this.peerValue.request(method, payload, options);
	}

	sendEvent<E extends SupervisorToWorkerEvent>(event: E, payload: SupervisorToWorkerEvents[E]): void {
		this.peerValue?.sendEvent(event, payload);
	}

	onEvent<E extends WorkerToSupervisorEvent>(
		event: E,
		handler: (payload: WorkerToSupervisorEvents[E]) => void | Promise<void>,
	): () => void {
		const set = this.events.get(event) ?? new Set<AnyEventListener>();
		const listener = handler as AnyEventListener;
		set.add(listener);
		this.events.set(event, set);
		this.peerValue?.peer.onEvent(event, listener);
		return () => {
			set.delete(listener);
		};
	}

	handle<M extends WorkerToSupervisorMethod>(
		method: M,
		handler: (
			payload: WorkerToSupervisorRequests[M]["request"],
			context: IpcRequestContext,
		) => Promise<WorkerToSupervisorRequests[M]["response"]> | WorkerToSupervisorRequests[M]["response"],
	): () => void {
		const wrapped = handler as AnyHandler;
		this.handlers.set(method, wrapped);
		this.peerValue?.peer.handle(method, wrapped);
		return () => {
			if (this.handlers.get(method) === wrapped) this.handlers.delete(method);
		};
	}

	async close(): Promise<void> {
		if (this.closedValue) return;
		this.closedValue = true;
		this.clearExpectedWorker();
		const current = this.peerValue;
		this.peerValue = null;
		if (current !== null) this.peerIdentities.delete(current);
		const pending = [...this.pendingPeers];
		this.pendingPeers.clear();
		for (const timer of this.pendingTimers.values()) clearTimeout(timer);
		this.pendingTimers.clear();
		await Promise.all([
			...(current === null ? [] : [current.close().catch(() => undefined)]),
			...pending.map((raw) => raw.close().catch(() => undefined)),
		]);
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (!isTcpEndpoint(this.options.endpoint)) await unlink(this.options.endpoint).catch(() => undefined);
		this.closedResolve();
	}
}

/** Worker-side peer connected to the Supervisor. */
export class WorkerIpcConnection {
	readonly peer: SocketPeer;
	readonly pid: number;

	constructor(peer: SocketPeer) {
		this.peer = peer;
		this.pid = process.pid;
	}

	static async connect(input: {
		readonly endpoint: string;
		readonly maxFrameBytes: number;
		readonly requestTimeoutMs: number;
		/** Present for a real Worker: proves the one-time Supervisor-issued launch credential. */
		readonly authentication?: WorkerAuthenticationRequest;
		readonly handshakeTimeoutMs?: number;
	}): Promise<WorkerIpcConnection> {
		assertEndpoint(input.endpoint);
		const tcp = isTcpEndpoint(input.endpoint);
		const socket = await new Promise<Socket>((resolve, reject) => {
			const next = tcp
				? connect({ host: "127.0.0.1", port: tcpEndpointPort(input.endpoint) })
				: connect({ path: input.endpoint });
			next.once("connect", () => resolve(next));
			next.once("error", (error) => reject(new RsiError("IPC_CLOSED", `Worker IPC connect failed: ${error.message}`, { cause: error })));
		});
		const connection = new WorkerIpcConnection(
			new SocketPeer(socket, {
				side: "worker",
				maxFrameBytes: input.maxFrameBytes,
				requestTimeoutMs: input.requestTimeoutMs,
			}),
		);
		if (input.authentication !== undefined) {
			try {
				const result = await connection.peer.request(
					WORKER_AUTHENTICATE_METHOD,
					input.authentication,
					{ timeoutMs: input.handshakeTimeoutMs ?? DEFAULT_WORKER_HANDSHAKE_TIMEOUT_MS },
				) as WorkerAuthenticationResult;
				if (
					result?.accepted !== true ||
					result.launchId !== input.authentication.launchId ||
					result.generation !== input.authentication.generation
				) {
					throw new RsiError("IPC_AUTH_FAILED", "Supervisor did not confirm the Worker launch identity.");
				}
			} catch (error) {
				await connection.close().catch(() => undefined);
				throw error instanceof RsiError
					? error
					: new RsiError("IPC_AUTH_FAILED", "Worker IPC authentication failed.", { cause: error });
			}
		}
		return connection;
	}

	request<M extends WorkerToSupervisorMethod>(
		method: M,
		payload: WorkerToSupervisorRequests[M]["request"],
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<WorkerToSupervisorRequests[M]["response"]> {
		return this.peer.request(method, payload, options) as Promise<WorkerToSupervisorRequests[M]["response"]>;
	}

	sendEvent<E extends WorkerToSupervisorEvent>(event: E, payload: WorkerToSupervisorEvents[E]): void {
		this.peer.sendEvent(event, payload);
	}

	onEvent<E extends SupervisorToWorkerEvent>(
		event: E,
		handler: (payload: SupervisorToWorkerEvents[E]) => void | Promise<void>,
	): () => void {
		return this.peer.onEvent(event, handler as AnyEventListener);
	}

	handle<M extends SupervisorToWorkerMethod>(
		method: M,
		handler: (
			payload: SupervisorToWorkerRequests[M]["request"],
			context: IpcRequestContext,
		) => Promise<SupervisorToWorkerRequests[M]["response"]> | SupervisorToWorkerRequests[M]["response"],
	): () => void {
		return this.peer.handle(method, handler as AnyHandler);
	}

	async close(): Promise<void> {
		await this.peer.close();
	}

	get closed(): Promise<void> {
		return this.peer.closed;
	}
}

export { decodeIpcLine };
