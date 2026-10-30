import type { RsiJsonValue } from "./json.ts";

/** Stable, machine-readable error codes used across the Supervisor and Worker. */
export type RsiErrorCode =
	| "CONFIG_INVALID"
	| "PATH_INVALID"
	| "PATH_OUTSIDE_ROOT"
	| "PATH_SYMLINK_FORBIDDEN"
	| "PATH_HARDLINK_FORBIDDEN"
	| "PATH_NOT_FILE"
	| "PROMPT_MISSING"
	| "PROMPT_INVALID"
	| "MEMORY_WORD_LIMIT"
	| "MEMORY_REVISION_CONFLICT"
	| "DOCUMENT_WORD_LIMIT"
	| "DOCUMENT_COUNT_LIMIT"
	| "DOCUMENT_NAME_INVALID"
	| "DOCUMENT_NOT_FOUND"
	| "DOCUMENT_REVISION_CONFLICT"
	| "INDEX_INVALID"
	| "SLEEP_INVALID"
	| "SLEEP_BOTH_FORMS"
	| "SLEEP_DEADLINE_PAST"
	| "TIME_INVALID"
	| "TIME_NONEXISTENT"
	| "TIME_AMBIGUOUS"
	| "IPC_INVALID_FRAME"
	| "IPC_FRAME_TOO_LARGE"
	| "IPC_BACKPRESSURE"
	| "IPC_TIMEOUT"
	| "IPC_CLOSED"
	| "IPC_METHOD_UNKNOWN"
	| "IPC_REQUEST_ID_INVALID"
	| "IPC_DIRECTION_FORBIDDEN"
	| "IPC_AUTH_FAILED"
	| "SANDBOX_INVALID"
	| "SANDBOX_ALIAS_RISK"
	| "PREFLIGHT_FAILED"
	| "PREFLIGHT_TIMEOUT"
	| "CANDIDATE_CHANGED"
	| "RELOAD_FAILED"
	| "WATCHDOG_ROLLBACK"
	| "PLUGIN_MANIFEST_MISMATCH"
	| "RESOURCE_CAP_EXCEEDED"
	| "AGENT_COMMAND_FORBIDDEN"
	| "HEALTH_TURN_INVALID"
	| "INTERNAL";

/** Serializable error shape returned by IPC and written to control state. */
export interface RsiErrorPayload {
	readonly name: "RsiError";
	readonly code: RsiErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly details?: RsiJsonValue;
	readonly requestId?: string;
}

export interface RsiErrorOptions {
	readonly retryable?: boolean;
	readonly details?: RsiJsonValue;
	readonly requestId?: string;
	readonly cause?: unknown;
}

/** Error type that preserves its code and request id across process boundaries. */
export class RsiError extends Error {
	readonly code: RsiErrorCode;
	readonly retryable: boolean;
	readonly details: RsiJsonValue | undefined;
	readonly requestId: string | undefined;

	constructor(code: RsiErrorCode, message: string, options: RsiErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "RsiError";
		this.code = code;
		this.retryable = options.retryable ?? false;
		this.details = options.details;
		this.requestId = options.requestId;
	}

	toPayload(): RsiErrorPayload {
		return {
			name: "RsiError",
			code: this.code,
			message: this.message,
			retryable: this.retryable,
			...(this.details === undefined ? {} : { details: this.details }),
			...(this.requestId === undefined ? {} : { requestId: this.requestId }),
		};
	}
}

export function isRsiError(value: unknown): value is RsiError {
	return value instanceof RsiError;
}

export function hasErrorCode(value: unknown, code: RsiErrorCode): boolean {
	return isRsiError(value) && value.code === code;
}

/** Convert arbitrary thrown values to an RsiError while preserving known errors. */
export function asRsiError(
	error: unknown,
	fallbackCode: RsiErrorCode = "INTERNAL",
	fallbackMessage = "Unexpected runtime error",
): RsiError {
	if (isRsiError(error)) return error;
	const message = error instanceof Error && error.message.length > 0 ? error.message : fallbackMessage;
	return new RsiError(fallbackCode, message, { cause: error });
}

/** Build an error payload from an arbitrary thrown value. */
export function toRsiErrorPayload(
	error: unknown,
	fallbackCode: RsiErrorCode = "INTERNAL",
	requestId?: string,
): RsiErrorPayload {
	const rsiError = asRsiError(error, fallbackCode);
	const payload = rsiError.toPayload();
	return requestId === undefined ? payload : { ...payload, requestId };
}

/** Reconstruct an RsiError from a validated payload. */
export function rsiErrorFromPayload(payload: RsiErrorPayload): RsiError {
	return new RsiError(payload.code, payload.message, {
		retryable: payload.retryable,
		...(payload.details === undefined ? {} : { details: payload.details }),
		...(payload.requestId === undefined ? {} : { requestId: payload.requestId }),
	});
}

/** Validate an unknown value as an RsiErrorPayload. */
export function isRsiErrorPayload(value: unknown): value is RsiErrorPayload {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.name === "RsiError" &&
		typeof record.code === "string" &&
		typeof record.message === "string" &&
		typeof record.retryable === "boolean"
	);
}
