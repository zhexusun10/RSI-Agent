import { RsiError, type RsiErrorPayload } from "../shared/errors.ts";
import { isValidRequestId } from "../shared/ipc/protocol.ts";
import {
	CONTROL_MAX_FRAME_BYTES,
	type ControlCommand,
} from "./types.ts";

export const CONTROL_PROTOCOL = "rsi-control";
export const CONTROL_VERSION = 1;
export const CONTROL_FRAME_DELIMITER = 0x0a;
export { CONTROL_MAX_FRAME_BYTES };

export type ControlSource = "supervisor" | "worker-shim";

export interface ControlRequestEnvelope {
	readonly protocol: typeof CONTROL_PROTOCOL;
	readonly version: typeof CONTROL_VERSION;
	readonly type: "request";
	readonly requestId: string;
	readonly source: ControlSource;
	readonly generation: number | null;
	readonly sessionId: string | null;
	readonly token?: string;
	readonly command: ControlCommand;
}

export interface ControlSuccessResult {
	readonly detail: string;
	readonly generation: number | null;
	readonly attemptId?: string;
}

export type ControlErrorPayload = RsiErrorPayload & { readonly stack?: string };

export type ControlResponseEnvelope =
	| {
			readonly protocol: typeof CONTROL_PROTOCOL;
			readonly version: typeof CONTROL_VERSION;
			readonly type: "response";
			readonly requestId: string;
			readonly ok: true;
			readonly result: ControlSuccessResult;
	  }
	| {
			readonly protocol: typeof CONTROL_PROTOCOL;
			readonly version: typeof CONTROL_VERSION;
			readonly type: "response";
			readonly requestId: string;
			readonly ok: false;
			readonly error: ControlErrorPayload;
	  };

const REASON_MAX_LENGTH = 1_000;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TOKEN_MAX_LENGTH = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(record).every((key) => allowed.includes(key));
}

export function assertControlReason(value: unknown, label = "reason"): string {
	if (typeof value !== "string") throw new RsiError("AGENT_COMMAND_FORBIDDEN", `${label} must be a string.`);
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > REASON_MAX_LENGTH || value.includes("\u0000")) {
		throw new RsiError(
			"AGENT_COMMAND_FORBIDDEN",
			`${label} must be a non-empty string of at most ${REASON_MAX_LENGTH} characters without NUL.`,
		);
	}
	return value;
}

/** Candidate ids are opaque names. Paths, drive letters, separators, and traversal are rejected. */
export function assertCandidateId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!CANDIDATE_ID_PATTERN.test(value) ||
		value.includes("..") ||
		value.includes("/") ||
		value.includes("\\")
	) {
		throw new RsiError("AGENT_COMMAND_FORBIDDEN", "candidateId must be an opaque id, not a path.");
	}
	return value;
}

function assertSessionId(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value) || value.includes("..")) {
		throw new RsiError("AGENT_COMMAND_FORBIDDEN", "sessionId is invalid.");
	}
	return value;
}

function assertGeneration(value: unknown): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new RsiError("AGENT_COMMAND_FORBIDDEN", "generation must be a non-negative safe integer or null.");
	}
	return value;
}

export function assertControlCommand(value: unknown): ControlCommand {
	if (!isRecord(value)) {
		throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Control command must be an object.");
	}
	if (typeof value.kind !== "string") {
		throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Control command kind is required.");
	}
	switch (value.kind) {
		case "reload": {
			if (!hasOnlyKeys(value, ["kind", "reason", "candidateId"])) {
				throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Reload command has unknown fields.");
			}
			const reason = assertControlReason(value.reason);
			const candidateId =
				value.candidateId === undefined ? undefined : assertCandidateId(value.candidateId);
			return { kind: "reload", reason, ...(candidateId === undefined ? {} : { candidateId }) };
		}
		case "shutdown":
			if (!hasOnlyKeys(value, ["kind", "reason"])) {
				throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Shutdown command has unknown fields.");
			}
			return { kind: "shutdown", reason: assertControlReason(value.reason) };
		case "cancelSleep":
			if (!hasOnlyKeys(value, ["kind", "reason"])) {
				throw new RsiError("AGENT_COMMAND_FORBIDDEN", "cancelSleep command has unknown fields.");
			}
			return { kind: "cancelSleep", reason: assertControlReason(value.reason) };
		default:
			throw new RsiError("AGENT_COMMAND_FORBIDDEN", `Unsupported control command: ${value.kind}`);
	}
}

/** Parse and validate an external control request. Unknown fields fail closed. */
export function assertControlRequest(value: unknown): ControlRequestEnvelope {
	if (!isRecord(value)) {
		throw new RsiError("IPC_INVALID_FRAME", "Control request must be a JSON object.");
	}
	if (value.protocol !== CONTROL_PROTOCOL || value.version !== CONTROL_VERSION) {
		throw new RsiError("IPC_INVALID_FRAME", "Unsupported control protocol or version.");
	}
	if (value.type !== "request") {
		throw new RsiError("IPC_INVALID_FRAME", "Control frame type must be request.");
	}
	if (!isValidRequestId(value.requestId)) {
		throw new RsiError("IPC_REQUEST_ID_INVALID", "Control requestId is invalid.");
	}
	if (value.source !== "supervisor" && value.source !== "worker-shim") {
		throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Control source is not allowed.");
	}
	const allowed = [
		"protocol",
		"version",
		"type",
		"requestId",
		"source",
		"generation",
		"sessionId",
		"token",
		"command",
	];
	if (!hasOnlyKeys(value, allowed)) {
		throw new RsiError("IPC_INVALID_FRAME", "Control request has unknown fields.");
	}
	let token: string | undefined;
	if (value.token !== undefined) {
		if (typeof value.token !== "string" || value.token.length === 0 || value.token.length > TOKEN_MAX_LENGTH) {
			throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Control token is invalid.");
		}
		token = value.token;
	}
	return {
		protocol: CONTROL_PROTOCOL,
		version: CONTROL_VERSION,
		type: "request",
		requestId: value.requestId,
		source: value.source,
		generation: assertGeneration(value.generation),
		sessionId: assertSessionId(value.sessionId),
		...(token === undefined ? {} : { token }),
		command: assertControlCommand(value.command),
	};
}

export function createControlRequest(input: {
	readonly requestId: string;
	readonly source: ControlSource;
	readonly generation: number | null;
	readonly sessionId: string | null;
	readonly command: ControlCommand;
	readonly token?: string;
}): ControlRequestEnvelope {
	return assertControlRequest({
		protocol: CONTROL_PROTOCOL,
		version: CONTROL_VERSION,
		type: "request",
		requestId: input.requestId,
		source: input.source,
		generation: input.generation,
		sessionId: input.sessionId,
		...(input.token === undefined ? {} : { token: input.token }),
		command: input.command,
	});
}

export function createControlSuccess(
	requestId: string,
	result: ControlSuccessResult,
): ControlResponseEnvelope {
	return {
		protocol: CONTROL_PROTOCOL,
		version: CONTROL_VERSION,
		type: "response",
		requestId,
		ok: true,
		result,
	};
}

export function createControlFailure(
	requestId: string,
	error: unknown,
): ControlResponseEnvelope {
	const stack = error instanceof Error && error.stack ? error.stack : undefined;
	const base: RsiErrorPayload =
		error instanceof RsiError
			? error.toPayload()
			: {
					name: "RsiError",
					code: "INTERNAL",
					message: error instanceof Error ? error.message : String(error),
					retryable: false,
				};
	return {
		protocol: CONTROL_PROTOCOL,
		version: CONTROL_VERSION,
		type: "response",
		requestId,
		ok: false,
		error: { ...base, requestId, ...(stack === undefined ? {} : { stack }) },
	};
}

export function assertControlResponse(value: unknown, expectedRequestId?: string): ControlResponseEnvelope {
	if (!isRecord(value)) {
		throw new RsiError("IPC_INVALID_FRAME", "Control response must be a JSON object.");
	}
	if (value.protocol !== CONTROL_PROTOCOL || value.version !== CONTROL_VERSION) {
		throw new RsiError("IPC_INVALID_FRAME", "Unsupported control response protocol or version.");
	}
	if (value.type !== "response" || !isValidRequestId(value.requestId)) {
		throw new RsiError("IPC_INVALID_FRAME", "Control response framing is invalid.");
	}
	if (expectedRequestId !== undefined && value.requestId !== expectedRequestId) {
		throw new RsiError("IPC_INVALID_FRAME", "Control response requestId does not match.");
	}
	if (typeof value.ok !== "boolean") {
		throw new RsiError("IPC_INVALID_FRAME", "Control response ok must be boolean.");
	}
	if (value.ok) {
		if (!isRecord(value.result) || typeof value.result.detail !== "string") {
			throw new RsiError("IPC_INVALID_FRAME", "Control success result is invalid.");
		}
		const generation = value.result.generation;
		if (generation !== null && (typeof generation !== "number" || !Number.isSafeInteger(generation))) {
			throw new RsiError("IPC_INVALID_FRAME", "Control success generation is invalid.");
		}
		return value as unknown as ControlResponseEnvelope;
	}
	if (!isRecord(value.error) || typeof value.error.message !== "string" || typeof value.error.code !== "string") {
		throw new RsiError("IPC_INVALID_FRAME", "Control error response is invalid.");
	}
	if (value.error.stack !== undefined && typeof value.error.stack !== "string") {
		throw new RsiError("IPC_INVALID_FRAME", "Control error stack is invalid.");
	}
	return value as unknown as ControlResponseEnvelope;
}

/** Constant-time comparison for the optional control token. */
export function controlTokensEqual(left: string | undefined, right: string | undefined): boolean {
	if (left === undefined && right === undefined) return true;
	if (left === undefined || right === undefined) return false;
	const leftBytes = Buffer.from(left, "utf8");
	const rightBytes = Buffer.from(right, "utf8");
	let diff = leftBytes.length ^ rightBytes.length;
	const length = Math.max(leftBytes.length, rightBytes.length);
	for (let index = 0; index < length; index++) {
		diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return diff === 0;
}
