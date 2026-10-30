import { randomBytes, randomUUID } from "node:crypto";
import { RsiError } from "../errors.ts";

/**
 * One-launch Worker bootstrap credential. It is delivered over the Worker's
 * inherited stdin pipe, consumed before extension/model code is loaded, and is
 * never placed in argv, the environment, logs, or persisted state.
 */
export const WORKER_BOOTSTRAP_VERSION = 1;
export const MAX_WORKER_BOOTSTRAP_BYTES = 2_048;
export const WORKER_BOOTSTRAP_TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LAUNCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface WorkerBootstrap {
	readonly version: typeof WORKER_BOOTSTRAP_VERSION;
	readonly launchId: string;
	readonly token: string;
	readonly generation: number | null;
}

export interface WorkerAuthenticationRequest {
	readonly launchId: string;
	readonly token: string;
	readonly generation: number | null;
}

export interface WorkerAuthenticationResult {
	readonly accepted: true;
	readonly launchId: string;
	readonly generation: number | null;
	readonly serverTimeMs: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidWorkerLaunchId(value: unknown): value is string {
	return typeof value === "string" && LAUNCH_ID_PATTERN.test(value);
}

export function isValidWorkerBootstrapToken(value: unknown): value is string {
	return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function isValidWorkerGeneration(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

export function createWorkerBootstrap(generation: number | null): WorkerBootstrap {
	if (!isValidWorkerGeneration(generation)) {
		throw new RsiError("CONFIG_INVALID", "Worker bootstrap generation must be null or a positive safe integer.");
	}
	return {
		version: WORKER_BOOTSTRAP_VERSION,
		launchId: randomUUID(),
		token: randomBytes(WORKER_BOOTSTRAP_TOKEN_BYTES).toString("base64url"),
		generation,
	};
}

export function validateWorkerBootstrap(value: unknown): WorkerBootstrap {
	if (!isPlainRecord(value)) {
		throw new RsiError("CONFIG_INVALID", "Worker bootstrap must be an object.");
	}
	if (value.version !== WORKER_BOOTSTRAP_VERSION) {
		throw new RsiError("CONFIG_INVALID", "Worker bootstrap version is not supported.");
	}
	if (!isValidWorkerLaunchId(value.launchId)) {
		throw new RsiError("CONFIG_INVALID", "Worker bootstrap launchId is invalid.");
	}
	if (!isValidWorkerBootstrapToken(value.token)) {
		throw new RsiError("CONFIG_INVALID", "Worker bootstrap token is invalid.");
	}
	if (!isValidWorkerGeneration(value.generation)) {
		throw new RsiError("CONFIG_INVALID", "Worker bootstrap generation is invalid.");
	}
	return {
		version: WORKER_BOOTSTRAP_VERSION,
		launchId: value.launchId,
		token: value.token,
		generation: value.generation,
	};
}

/** Encode exactly one bounded LF-terminated bootstrap record. */
export function encodeWorkerBootstrap(value: WorkerBootstrap): string {
	const bootstrap = validateWorkerBootstrap(value);
	const line = `${JSON.stringify(bootstrap)}\n`;
	if (Buffer.byteLength(line, "utf8") > MAX_WORKER_BOOTSTRAP_BYTES) {
		throw new RsiError("CONFIG_INVALID", "Worker bootstrap record exceeds its byte limit.");
	}
	return line;
}

export function parseWorkerBootstrapLine(line: string): WorkerBootstrap {
	const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (trimmed.length === 0 || Buffer.byteLength(trimmed, "utf8") > MAX_WORKER_BOOTSTRAP_BYTES) {
		throw new RsiError("CONFIG_INVALID", "Worker bootstrap record is empty or too large.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new RsiError("CONFIG_INVALID", "Worker bootstrap is not valid JSON.", { cause: error });
	}
	return validateWorkerBootstrap(parsed);
}
