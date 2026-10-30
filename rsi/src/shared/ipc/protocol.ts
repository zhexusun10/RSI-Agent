import { randomUUID } from "node:crypto";
import type { DocumentCommitRequest, DocumentMutationResult, IndexConsistency, ManagedDocumentStat } from "../documents.ts";
import type { RsiErrorPayload } from "../errors.ts";
import { isRsiErrorPayload, RsiError } from "../errors.ts";
import type { ContentRevision } from "../hash.ts";
import type { MemorySnapshot } from "../memory.ts";
import type { PluginCandidate } from "../plugins.ts";
import type { HealthTurnObservation, PreflightReport } from "../preflight.ts";
import type { SleepState } from "../sleep.ts";
import type { RsiJsonObject, RsiJsonValue } from "../json.ts";
import type {
	WorkerAuthenticationRequest,
	WorkerAuthenticationResult,
} from "./bootstrap.ts";

export const IPC_PROTOCOL = "rsi-ipc";
export const IPC_VERSION = 1;
export const WORKER_AUTHENTICATE_METHOD = "worker.authenticate";
export const IPC_FRAME_DELIMITER = 0x0a;
export const IPC_MAX_REQUEST_ID_LENGTH = 128;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MAX_IPC_METHOD_NAME_LENGTH = 80;

export type IpcDirection = "worker-to-supervisor" | "supervisor-to-worker";

export interface ManagedDocumentSummary {
	readonly name: string;
	readonly words: number;
	readonly revision: ContentRevision;
	readonly mtimeMs: number;
}

export interface ManagedDocumentSnapshot extends ManagedDocumentSummary {
	readonly content: string;
	/** Request-time read view (for example annotated index rows). Never persisted. */
	readonly viewContent?: string;
}

export interface IndexReadReport {
	readonly generatedAtMs: number;
	readonly stats: readonly ManagedDocumentStat[];
	readonly consistency: IndexConsistency;
	readonly reportText: string;
}

export interface ToolResultDecorationRequest {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly isError: boolean;
	/** Present only after a successful read of a managed Markdown file. */
	readonly readName?: string | null;
	/** True when readName is index.md. */
	readonly indexRead: boolean;
	/** Present only after a successful Memory.md broker commit. */
	readonly memoryUsage?: string;
}

export interface ToolResultDecorationResult {
	readonly appendText: string;
	readonly currentTime: string;
	readonly warnings: readonly string[];
	readonly indexReport: string | null;
}

export interface HeartbeatReport {
	readonly sequence: number;
	readonly workerPid: number;
	readonly generation: number | null;
	readonly state: "starting" | "idle" | "busy" | "sleeping" | "reloading" | "stopping";
	readonly healthTurns: number;
	readonly memoryRevision: ContentRevision | null;
	readonly sessionId?: string | null;
	readonly sentAtMs: number;
}

export interface HeartbeatAck {
	readonly accepted: true;
	readonly serverTimeMs: number;
	readonly leaseExpiresAtMs: number;
	readonly directive: "none" | "reload" | "shutdown" | "rollback";
}

export interface SleepGrant {
	readonly accepted: true;
	readonly sleepId: string;
	readonly deadlineMs: number;
	readonly deadlineLocal: string;
	readonly timeZone: string;
	readonly state: SleepState;
}

export interface HealthTurnResult {
	readonly consecutiveHealthyTurns: number;
	readonly required: number;
	readonly promoted: boolean;
	readonly lkgGeneration: number | null;
	readonly failed: boolean;
}

export interface ReloadStartResult {
	readonly attemptId: string;
	readonly requiredHealthTurns: number;
}

export interface WorkerStatus {
	readonly state: "starting" | "idle" | "busy" | "sleeping" | "reloading" | "stopping";
	readonly generation: number | null;
	readonly healthTurns: number;
	readonly memoryRevision: ContentRevision | null;
	readonly sessionId?: string | null;
	readonly extensionPaths?: readonly string[];
	readonly skillCount?: number;
	readonly mcpServerCount?: number;
}

export type EmptyRequest = Record<string, never>;

/** Requests the Worker may send to the trusted Supervisor. */
export interface WorkerToSupervisorRequests {
	"worker.authenticate": {
		request: WorkerAuthenticationRequest;
		response: WorkerAuthenticationResult;
	};
	"memory.current": { request: EmptyRequest; response: MemorySnapshot };
	"docs.list": { request: EmptyRequest; response: readonly ManagedDocumentSummary[] };
	"docs.read": { request: { readonly name: string }; response: ManagedDocumentSnapshot };
	"docs.readView": {
		request: { readonly name: string; readonly atMs: number };
		response: ManagedDocumentSnapshot;
	};
	"docs.commit": { request: DocumentCommitRequest; response: DocumentMutationResult };
	"docs.indexReport": { request: { readonly nowMs?: number }; response: IndexReadReport };
	"docs.consistency": { request: EmptyRequest; response: IndexConsistency };
	"reads.record": {
		request: { readonly name: string; readonly atMs: number };
		response: { readonly recorded: true; readonly readsLast24h: number };
	};
	"tools.decorateResult": { request: ToolResultDecorationRequest; response: ToolResultDecorationResult };
	"sleep.request": {
		request: { readonly duration?: string; readonly until?: string; readonly toolCallId?: string };
		response: SleepGrant;
	};
	"sleep.status": { request: EmptyRequest; response: SleepState | null };
	"health.turn": {
		request: HealthTurnObservation & { readonly sessionId?: string | null };
		response: HealthTurnResult;
	};
	"heartbeat": { request: HeartbeatReport; response: HeartbeatAck };
	"reload.preflight": {
		request: {
			readonly reason: string;
			readonly requestedBy: "worker" | "control";
			readonly candidateId?: string;
		};
		response: PreflightReport;
	};
	"reload.started": {
		request: { readonly preflightId: string; readonly candidateId: string; readonly digest: ContentRevision };
		response: ReloadStartResult;
	};
	"reload.failed": {
		request: { readonly attemptId: string; readonly reason: string };
		response: { readonly recorded: true };
	};
	"control.request": {
		request: {
			readonly command: "reload" | "shutdown" | "cancelSleep" | "status";
			readonly args?: string;
		};
		response: {
			readonly ok: boolean;
			readonly detail?: string;
			readonly error?: string;
			readonly code?: string;
			readonly stack?: string;
		};
	};
}

/** Requests only the trusted Supervisor may send to the Worker. */
export interface SupervisorToWorkerRequests {
	"control.reload": {
		request: {
			readonly preflightId: string;
			readonly candidate: PluginCandidate;
		};
		response: ReloadStartResult;
	};
	"control.shutdown": {
		request: { readonly reason: string };
		response: { readonly accepted: true };
	};
	"control.cancelSleep": {
		request: { readonly reason: string };
		response: { readonly cancelled: boolean };
	};
	"worker.status": { request: EmptyRequest; response: WorkerStatus };
	"worker.previewResources": {
		request: EmptyRequest;
		response: { readonly changed: boolean; readonly skillsChanged: boolean; readonly mcpChanged: boolean };
	};
	"worker.ping": {
		request: { readonly nonce: string };
		response: { readonly nonce: string; readonly serverTimeMs: number };
	};
	"runtime.turn": {
		request: {
			readonly continuationId: string;
			readonly kind: string;
			readonly message: string;
			/** Recovery notice embedded in message; acknowledged after the run settles. */
			readonly noticeId?: string;
		};
		response: {
			readonly accepted: boolean;
			readonly runId?: string;
			readonly queued?: boolean;
			readonly detail?: string;
		};
	};
	"worker.abort": {
		request: { readonly reason: string };
		response: { readonly aborted: true };
	};
}

export type WorkerToSupervisorMethod = keyof WorkerToSupervisorRequests;
export type SupervisorToWorkerMethod = keyof SupervisorToWorkerRequests;
export type IpcMethod = WorkerToSupervisorMethod | SupervisorToWorkerMethod;

export const WORKER_TO_SUPERVISOR_METHODS = [
	"worker.authenticate",
	"memory.current",
	"docs.list",
	"docs.read",
	"docs.readView",
	"docs.commit",
	"docs.indexReport",
	"docs.consistency",
	"reads.record",
	"tools.decorateResult",
	"sleep.request",
	"sleep.status",
	"health.turn",
	"heartbeat",
	"reload.preflight",
	"reload.started",
	"reload.failed",
	"control.request",
] as const satisfies readonly WorkerToSupervisorMethod[];

export const SUPERVISOR_TO_WORKER_METHODS = [
	"control.reload",
	"control.shutdown",
	"control.cancelSleep",
	"worker.status",
	"worker.previewResources",
	"worker.ping",
	"runtime.turn",
	"worker.abort",
] as const satisfies readonly SupervisorToWorkerMethod[];

export const IPC_METHODS = [...WORKER_TO_SUPERVISOR_METHODS, ...SUPERVISOR_TO_WORKER_METHODS] as const;

export type IpcRequest<M extends IpcMethod = IpcMethod> = M extends WorkerToSupervisorMethod
	? {
			readonly protocol: typeof IPC_PROTOCOL;
			readonly version: typeof IPC_VERSION;
			readonly type: "request";
			readonly requestId: string;
			readonly method: M;
			readonly payload: WorkerToSupervisorRequests[M]["request"];
			readonly timeoutMs?: number;
		}
	: M extends SupervisorToWorkerMethod
		? {
				readonly protocol: typeof IPC_PROTOCOL;
				readonly version: typeof IPC_VERSION;
				readonly type: "request";
				readonly requestId: string;
				readonly method: M;
				readonly payload: SupervisorToWorkerRequests[M]["request"];
				readonly timeoutMs?: number;
			}
		: never;

export type IpcResponse<M extends IpcMethod = IpcMethod> = M extends WorkerToSupervisorMethod
	?
			| {
					readonly protocol: typeof IPC_PROTOCOL;
					readonly version: typeof IPC_VERSION;
					readonly type: "response";
					readonly requestId: string;
					readonly method: M;
					readonly ok: true;
					readonly result: WorkerToSupervisorRequests[M]["response"];
			  }
			| {
					readonly protocol: typeof IPC_PROTOCOL;
					readonly version: typeof IPC_VERSION;
					readonly type: "response";
					readonly requestId: string;
					readonly method: M;
					readonly ok: false;
					readonly error: RsiErrorPayload;
			  }
	: M extends SupervisorToWorkerMethod
		?
				| {
						readonly protocol: typeof IPC_PROTOCOL;
						readonly version: typeof IPC_VERSION;
						readonly type: "response";
						readonly requestId: string;
						readonly method: M;
						readonly ok: true;
						readonly result: SupervisorToWorkerRequests[M]["response"];
				  }
				| {
						readonly protocol: typeof IPC_PROTOCOL;
						readonly version: typeof IPC_VERSION;
						readonly type: "response";
						readonly requestId: string;
						readonly method: M;
						readonly ok: false;
						readonly error: RsiErrorPayload;
				  }
		: never;

export interface WorkerToSupervisorEvents {
	"worker.ready": {
		readonly pid: number;
		readonly generation: number | null;
		readonly startedAtMs: number;
		readonly sessionId?: string | null;
		readonly extensionPaths?: readonly string[];
		readonly skillCount?: number;
		readonly mcpServerCount?: number;
	};
	"worker.stopping": { readonly reason: string; readonly atMs: number };
	"sleep.entered": { readonly sleepId: string; readonly deadlineMs: number; readonly atMs: number };
	"sleep.woke": { readonly sleepId: string; readonly atMs: number };
	"agent.end": { readonly willRetry: boolean; readonly atMs: number };
	"agent.settled": {
		readonly runId: string;
		readonly generation: number | null;
		readonly sessionId: string | null;
		readonly aborted: boolean;
		readonly stopReason: string;
		readonly assistantMessages: number;
		readonly atMs: number;
	};
	"worker.exception": {
		readonly scope: string;
		readonly message: string;
		readonly stack?: string;
		readonly atMs: number;
	};
	"reload.completed": { readonly attemptId: string; readonly generation: number; readonly atMs: number };
	"recovery.noticeDelivered": { readonly notificationId: string; readonly atMs: number };
}

export interface SupervisorToWorkerEvents {
	"memory.changed": { readonly revision: ContentRevision; readonly words: number };
	"docs.changed": { readonly name: string; readonly revision: ContentRevision };
	"sleep.wake": { readonly sleepId: string; readonly atMs: number };
	"watchdog.rollback": { readonly lkgGeneration: number; readonly reason: string };
}

export type WorkerToSupervisorEvent = keyof WorkerToSupervisorEvents;
export type SupervisorToWorkerEvent = keyof SupervisorToWorkerEvents;
export type IpcEventName = WorkerToSupervisorEvent | SupervisorToWorkerEvent;

export const WORKER_TO_SUPERVISOR_EVENTS = [
	"worker.ready",
	"worker.stopping",
	"sleep.entered",
	"sleep.woke",
	"agent.end",
	"agent.settled",
	"worker.exception",
	"reload.completed",
	"recovery.noticeDelivered",
] as const satisfies readonly WorkerToSupervisorEvent[];

export const SUPERVISOR_TO_WORKER_EVENTS = [
	"memory.changed",
	"docs.changed",
	"sleep.wake",
	"watchdog.rollback",
] as const satisfies readonly SupervisorToWorkerEvent[];

export const IPC_EVENTS = [...WORKER_TO_SUPERVISOR_EVENTS, ...SUPERVISOR_TO_WORKER_EVENTS] as const;

export type IpcEvent<E extends IpcEventName = IpcEventName> = E extends WorkerToSupervisorEvent
	? {
			readonly protocol: typeof IPC_PROTOCOL;
			readonly version: typeof IPC_VERSION;
			readonly type: "event";
			readonly eventId: string;
			readonly event: E;
			readonly payload: WorkerToSupervisorEvents[E];
			readonly emittedAtMs: number;
		}
	: E extends SupervisorToWorkerEvent
		? {
				readonly protocol: typeof IPC_PROTOCOL;
				readonly version: typeof IPC_VERSION;
				readonly type: "event";
				readonly eventId: string;
				readonly event: E;
				readonly payload: SupervisorToWorkerEvents[E];
				readonly emittedAtMs: number;
			}
		: never;

export type IpcFrame = IpcRequest | IpcResponse | IpcEvent;

const workerMethodSet = new Set<string>(WORKER_TO_SUPERVISOR_METHODS);
const supervisorMethodSet = new Set<string>(SUPERVISOR_TO_WORKER_METHODS);
const methodSet = new Set<string>(IPC_METHODS);
const eventSet = new Set<string>(IPC_EVENTS);

export function isWorkerToSupervisorMethod(method: string): method is WorkerToSupervisorMethod {
	return workerMethodSet.has(method);
}

export function isSupervisorToWorkerMethod(method: string): method is SupervisorToWorkerMethod {
	return supervisorMethodSet.has(method);
}

export function isIpcMethod(method: string): method is IpcMethod {
	return methodSet.has(method);
}

export function isIpcEventName(event: string): event is IpcEventName {
	return eventSet.has(event);
}

export function methodDirection(method: IpcMethod): IpcDirection {
	return isWorkerToSupervisorMethod(method) ? "worker-to-supervisor" : "supervisor-to-worker";
}

export function createRequestId(): string {
	return randomUUID();
}

export function createEventId(): string {
	return randomUUID();
}

export function isValidRequestId(value: unknown): value is string {
	return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

export function isValidEventId(value: unknown): value is string {
	return isValidRequestId(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a decoded frame's framing and identifiers. Payload semantics are method-handler-owned. */
export function validateIpcFrame(value: unknown): IpcFrame {
	if (!isPlainRecord(value)) {
		throw new RsiError("IPC_INVALID_FRAME", "IPC frame must be a JSON object.");
	}
	if (value.protocol !== IPC_PROTOCOL || value.version !== IPC_VERSION) {
		throw new RsiError("IPC_INVALID_FRAME", "Unsupported IPC protocol or version.");
	}
	if (value.type === "request") {
		if (!isValidRequestId(value.requestId)) {
			throw new RsiError("IPC_REQUEST_ID_INVALID", "IPC requestId is invalid.");
		}
		if (typeof value.method !== "string" || !isIpcMethod(value.method)) {
			throw new RsiError("IPC_METHOD_UNKNOWN", `Unknown IPC method: ${String(value.method)}`);
		}
		if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== "number" || !Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0)) {
			throw new RsiError("IPC_INVALID_FRAME", "IPC timeoutMs must be a positive number.");
		}
		if (!isPlainRecord(value.payload)) {
			throw new RsiError("IPC_INVALID_FRAME", "IPC request payload must be an object.");
		}
		return value as unknown as IpcRequest;
	}
	if (value.type === "response") {
		if (!isValidRequestId(value.requestId)) {
			throw new RsiError("IPC_REQUEST_ID_INVALID", "IPC response requestId is invalid.");
		}
		if (typeof value.method !== "string" || !isIpcMethod(value.method)) {
			throw new RsiError("IPC_METHOD_UNKNOWN", `Unknown IPC response method: ${String(value.method)}`);
		}
		if (typeof value.ok !== "boolean") {
			throw new RsiError("IPC_INVALID_FRAME", "IPC response ok must be boolean.");
		}
		if (!value.ok) {
			if (!isRsiErrorPayload(value.error)) {
				throw new RsiError("IPC_INVALID_FRAME", "IPC error response has an invalid error payload.");
			}
		}
		return value as unknown as IpcResponse;
	}
	if (value.type === "event") {
		if (!isValidEventId(value.eventId)) {
			throw new RsiError("IPC_REQUEST_ID_INVALID", "IPC eventId is invalid.");
		}
		if (typeof value.event !== "string" || !isIpcEventName(value.event)) {
			throw new RsiError("IPC_INVALID_FRAME", `Unknown IPC event: ${String(value.event)}`);
		}
		if (!isPlainRecord(value.payload)) {
			throw new RsiError("IPC_INVALID_FRAME", "IPC event payload must be an object.");
		}
		if (typeof value.emittedAtMs !== "number" || !Number.isFinite(value.emittedAtMs)) {
			throw new RsiError("IPC_INVALID_FRAME", "IPC event emittedAtMs must be finite.");
		}
		return value as unknown as IpcEvent;
	}
	throw new RsiError("IPC_INVALID_FRAME", "IPC frame type must be request, response, or event.");
}

/** Type-safe helper for a request frame. It does not validate payload fields. */
export function requestFrame<M extends IpcMethod>(
	method: M,
	payload: M extends WorkerToSupervisorMethod
		? WorkerToSupervisorRequests[M]["request"]
		: M extends SupervisorToWorkerMethod
			? SupervisorToWorkerRequests[M]["request"]
			: never,
	options: { requestId?: string; timeoutMs?: number } = {},
): IpcRequest<M> {
	return {
		protocol: IPC_PROTOCOL,
		version: IPC_VERSION,
		type: "request",
		requestId: options.requestId ?? createRequestId(),
		method,
		payload,
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	} as IpcRequest<M>;
}

export function responseFrame<M extends IpcMethod>(
	request: IpcRequest<M>,
	result: M extends WorkerToSupervisorMethod
		? WorkerToSupervisorRequests[M]["response"]
		: M extends SupervisorToWorkerMethod
			? SupervisorToWorkerRequests[M]["response"]
			: never,
): IpcResponse<M> {
	return {
		protocol: IPC_PROTOCOL,
		version: IPC_VERSION,
		type: "response",
		requestId: request.requestId,
		method: request.method,
		ok: true,
		result,
	} as IpcResponse<M>;
}

export function errorResponseFrame<M extends IpcMethod>(
	request: Pick<IpcRequest<M>, "requestId" | "method">,
	error: RsiErrorPayload,
): IpcResponse<M> {
	return {
		protocol: IPC_PROTOCOL,
		version: IPC_VERSION,
		type: "response",
		requestId: request.requestId,
		method: request.method,
		ok: false,
		error: { ...error, requestId: request.requestId },
	} as IpcResponse<M>;
}

export function eventFrame<E extends IpcEventName>(
	event: E,
	payload: E extends WorkerToSupervisorEvent
		? WorkerToSupervisorEvents[E]
		: E extends SupervisorToWorkerEvent
			? SupervisorToWorkerEvents[E]
			: never,
	options: { eventId?: string; emittedAtMs?: number } = {},
): IpcEvent<E> {
	return {
		protocol: IPC_PROTOCOL,
		version: IPC_VERSION,
		type: "event",
		eventId: options.eventId ?? createEventId(),
		event,
		payload,
		emittedAtMs: options.emittedAtMs ?? Date.now(),
	} as IpcEvent<E>;
}

export function isIpcResponse(value: IpcFrame): value is IpcResponse {
	return value.type === "response";
}

export function isIpcRequest(value: IpcFrame): value is IpcRequest {
	return value.type === "request";
}

export function isIpcEvent(value: IpcFrame): value is IpcEvent {
	return value.type === "event";
}

/** Helpers for strongly typed JSON payload values when extending methods. */
export type IpcJson = RsiJsonValue | RsiJsonObject;
