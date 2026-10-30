import { RsiError } from "../errors.ts";
import type {
	IpcDirection,
	IpcEventName,
	IpcMethod,
	SupervisorToWorkerEvent,
	SupervisorToWorkerEvents,
	SupervisorToWorkerMethod,
	SupervisorToWorkerRequests,
	WorkerToSupervisorEvent,
	WorkerToSupervisorEvents,
	WorkerToSupervisorMethod,
	WorkerToSupervisorRequests,
} from "./protocol.ts";
import { methodDirection } from "./protocol.ts";

export interface IpcRequestOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface IpcRequestContext {
	readonly requestId: string;
	readonly receivedAtMs: number;
	readonly signal: AbortSignal;
}

export interface WorkerIpcClient {
	request<M extends WorkerToSupervisorMethod>(
		method: M,
		payload: WorkerToSupervisorRequests[M]["request"],
		options?: IpcRequestOptions,
	): Promise<WorkerToSupervisorRequests[M]["response"]>;
	sendEvent<E extends WorkerToSupervisorEvent>(
		event: E,
		payload: WorkerToSupervisorEvents[E],
	): void;
	onEvent<E extends SupervisorToWorkerEvent>(
		event: E,
		handler: (payload: SupervisorToWorkerEvents[E]) => void | Promise<void>,
	): () => void;
	close(): void;
	readonly closed: Promise<void>;
}

export interface SupervisorIpcClient {
	request<M extends SupervisorToWorkerMethod>(
		method: M,
		payload: SupervisorToWorkerRequests[M]["request"],
		options?: IpcRequestOptions,
	): Promise<SupervisorToWorkerRequests[M]["response"]>;
	sendEvent<E extends SupervisorToWorkerEvent>(
		event: E,
		payload: SupervisorToWorkerEvents[E],
	): void;
	onEvent<E extends WorkerToSupervisorEvent>(
		event: E,
		handler: (payload: WorkerToSupervisorEvents[E]) => void | Promise<void>,
	): () => void;
	close(): void;
	readonly closed: Promise<void>;
}

export interface WorkerIpcServer {
	handle<M extends SupervisorToWorkerMethod>(
		method: M,
		handler: (
			payload: SupervisorToWorkerRequests[M]["request"],
			context: IpcRequestContext,
		) => Promise<SupervisorToWorkerRequests[M]["response"]> | SupervisorToWorkerRequests[M]["response"],
	): () => void;
	onEvent<E extends WorkerToSupervisorEvent>(
		event: E,
		handler: (payload: WorkerToSupervisorEvents[E], context: IpcRequestContext) => void | Promise<void>,
	): () => void;
	close(): Promise<void>;
}

export interface SupervisorIpcServer {
	handle<M extends WorkerToSupervisorMethod>(
		method: M,
		handler: (
			payload: WorkerToSupervisorRequests[M]["request"],
			context: IpcRequestContext,
		) => Promise<WorkerToSupervisorRequests[M]["response"]> | WorkerToSupervisorRequests[M]["response"],
	): () => void;
	onEvent<E extends SupervisorToWorkerEvent>(
		event: E,
		handler: (payload: SupervisorToWorkerEvents[E], context: IpcRequestContext) => void | Promise<void>,
	): () => void;
	close(): Promise<void>;
}

/** Enforce that a method only enters the process allowed to handle it. */
export function assertIpcDirection(method: IpcMethod, expected: IpcDirection): void {
	const actual = methodDirection(method);
	if (actual !== expected) {
		throw new RsiError("IPC_DIRECTION_FORBIDDEN", `IPC method ${method} is ${actual}, not ${expected}.`, {
			details: { method, expected, actual },
		});
	}
}

export function isWorkerEvent(event: IpcEventName): event is WorkerToSupervisorEvent {
	return (
		event === "worker.ready" ||
		event === "worker.stopping" ||
		event === "sleep.entered" ||
		event === "sleep.woke" ||
		event === "agent.end" ||
		event === "agent.settled" ||
		event === "worker.exception" ||
		event === "reload.completed"
	);
}
