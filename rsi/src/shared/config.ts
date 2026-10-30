import { readFile } from "node:fs/promises";
import { RsiError } from "./errors.ts";
import {
	assertRuntimePathPolicy,
	deriveRuntimePaths,
	requireAbsolutePath,
	type RuntimePathInput,
	type RuntimePaths,
} from "./paths.ts";
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	DEFAULT_HEARTBEAT_TIMEOUT_MS,
	DEFAULT_IPC_MAX_FRAME_BYTES,
	DEFAULT_IPC_REQUEST_TIMEOUT_MS,
	MAX_IPC_MAX_FRAME_BYTES,
	MIN_IPC_MAX_FRAME_BYTES,
	PREFLIGHT_MOCK_LOAD_TIMEOUT_MS,
} from "./policy.ts";
import { assertValidTimeZone, DEFAULT_TIME_ZONE } from "./time.ts";

export const RSI_CONFIG_VERSION = 1;
export const RSI_CONFIG_ENV = "RSI_CONFIG_PATH";

export interface RsiIpcConfig {
	readonly maxFrameBytes: number;
	readonly requestTimeoutMs: number;
	readonly heartbeatIntervalMs: number;
	readonly heartbeatTimeoutMs: number;
	readonly preflightTimeoutMs: number;
}

export interface RsiSandboxConfig {
	readonly bwrapPath: string;
	readonly network: "unrestricted";
	readonly workerUid?: number;
	readonly workerGid?: number;
}

export interface RsiConfigInput {
	readonly version?: number;
	readonly timeZone?: string;
	readonly paths: RuntimePathInput;
	readonly ipc?: {
		readonly maxFrameBytes?: number;
		readonly requestTimeoutMs?: number;
		readonly heartbeatIntervalMs?: number;
		readonly heartbeatTimeoutMs?: number;
		readonly preflightTimeoutMs?: number;
	};
	readonly sandbox?: {
		readonly bwrapPath?: string;
		readonly network?: string;
		readonly workerUid?: number;
		readonly workerGid?: number;
	};
}

export interface RsiConfig {
	readonly version: 1;
	readonly timeZone: string;
	readonly paths: RuntimePaths;
	readonly ipc: RsiIpcConfig;
	readonly sandbox: RsiSandboxConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) {
			throw new RsiError("CONFIG_INVALID", `Unknown ${label} key: ${key}`);
		}
	}
}

function positiveInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new RsiError("CONFIG_INVALID", `${label} must be an integer between ${minimum} and ${maximum}.`);
	}
	return value;
}

function parsePathInput(value: unknown): RuntimePathInput {
	if (!isRecord(value)) {
		throw new RsiError("CONFIG_INVALID", "paths must be an object.");
	}
	assertKnownKeys(
		value,
		[
			"workspaceDir",
			"dataDir",
			"stateDir",
			"piSourceDir",
			"rsiSourceDir",
			"systemPromptFile",
			"markdownsDir",
			"pluginSourceDir",
			"hostIpcSocketPath",
		],
		"paths",
	);
	const read = (key: string): string => {
		const raw = value[key];
		if (typeof raw !== "string") {
			throw new RsiError("CONFIG_INVALID", `paths.${key} must be a string.`);
		}
		return requireAbsolutePath(raw, `paths.${key}`);
	};
	return {
		workspaceDir: read("workspaceDir"),
		dataDir: read("dataDir"),
		stateDir: read("stateDir"),
		piSourceDir: read("piSourceDir"),
		rsiSourceDir: read("rsiSourceDir"),
		systemPromptFile: read("systemPromptFile"),
		...(value.markdownsDir === undefined ? {} : { markdownsDir: read("markdownsDir") }),
		...(value.pluginSourceDir === undefined ? {} : { pluginSourceDir: read("pluginSourceDir") }),
		...(value.hostIpcSocketPath === undefined ? {} : { hostIpcSocketPath: read("hostIpcSocketPath") }),
	};
}

function parseIpc(input: unknown): RsiIpcConfig {
	if (input === undefined) {
		return {
			maxFrameBytes: DEFAULT_IPC_MAX_FRAME_BYTES,
			requestTimeoutMs: DEFAULT_IPC_REQUEST_TIMEOUT_MS,
			heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
			heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
			preflightTimeoutMs: PREFLIGHT_MOCK_LOAD_TIMEOUT_MS + 12_000,
		};
	}
	if (!isRecord(input)) throw new RsiError("CONFIG_INVALID", "ipc must be an object.");
	assertKnownKeys(
		input,
		["maxFrameBytes", "requestTimeoutMs", "heartbeatIntervalMs", "heartbeatTimeoutMs", "preflightTimeoutMs"],
		"ipc",
	);
	const maxFrameBytes = positiveInteger(
		input.maxFrameBytes ?? DEFAULT_IPC_MAX_FRAME_BYTES,
		"ipc.maxFrameBytes",
		MIN_IPC_MAX_FRAME_BYTES,
		MAX_IPC_MAX_FRAME_BYTES,
	);
	const requestTimeoutMs = positiveInteger(
		input.requestTimeoutMs ?? DEFAULT_IPC_REQUEST_TIMEOUT_MS,
		"ipc.requestTimeoutMs",
		1_000,
		120_000,
	);
	const heartbeatIntervalMs = positiveInteger(
		input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
		"ipc.heartbeatIntervalMs",
		1_000,
		300_000,
	);
	const heartbeatTimeoutMs = positiveInteger(
		input.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
		"ipc.heartbeatTimeoutMs",
		2_000,
		900_000,
	);
	if (heartbeatTimeoutMs <= heartbeatIntervalMs) {
		throw new RsiError("CONFIG_INVALID", "ipc.heartbeatTimeoutMs must be greater than heartbeatIntervalMs.");
	}
	const preflightTimeoutMs = positiveInteger(
		input.preflightTimeoutMs ?? PREFLIGHT_MOCK_LOAD_TIMEOUT_MS + 12_000,
		"ipc.preflightTimeoutMs",
		PREFLIGHT_MOCK_LOAD_TIMEOUT_MS,
		120_000,
	);
	return { maxFrameBytes, requestTimeoutMs, heartbeatIntervalMs, heartbeatTimeoutMs, preflightTimeoutMs };
}

function parseSandbox(input: unknown): RsiSandboxConfig {
	if (input === undefined) return { bwrapPath: "bwrap", network: "unrestricted" };
	if (!isRecord(input)) throw new RsiError("CONFIG_INVALID", "sandbox must be an object.");
	assertKnownKeys(input, ["bwrapPath", "network", "workerUid", "workerGid"], "sandbox");
	const bwrapPath = input.bwrapPath ?? "bwrap";
	if (typeof bwrapPath !== "string" || bwrapPath.trim().length === 0 || bwrapPath.includes("\u0000")) {
		throw new RsiError("CONFIG_INVALID", "sandbox.bwrapPath must be a non-empty executable name or absolute path.");
	}
	const network = input.network ?? "unrestricted";
	if (network !== "unrestricted") {
		throw new RsiError("CONFIG_INVALID", "sandbox.network may only be 'unrestricted'; no extra network allowlist is defined.");
	}
	const workerUid =
		input.workerUid === undefined ? undefined : positiveInteger(input.workerUid, "sandbox.workerUid", 1, 4_294_967_294);
	const workerGid =
		input.workerGid === undefined ? undefined : positiveInteger(input.workerGid, "sandbox.workerGid", 1, 4_294_967_294);
	if ((workerUid === undefined) !== (workerGid === undefined)) {
		throw new RsiError("CONFIG_INVALID", "sandbox.workerUid and sandbox.workerGid must be provided together.");
	}
	return {
		bwrapPath,
		network,
		...(workerUid === undefined ? {} : { workerUid }),
		...(workerGid === undefined ? {} : { workerGid }),
	};
}

/** Validate and normalize the complete runtime configuration without touching the filesystem. */
export function parseRsiConfig(input: unknown): RsiConfig {
	if (!isRecord(input)) throw new RsiError("CONFIG_INVALID", "Configuration must be a JSON object.");
	assertKnownKeys(input, ["version", "timeZone", "paths", "ipc", "sandbox"], "configuration");
	const version = input.version ?? RSI_CONFIG_VERSION;
	if (version !== RSI_CONFIG_VERSION) {
		throw new RsiError("CONFIG_INVALID", `Unsupported configuration version: ${String(version)}`);
	}
	if (input.timeZone !== undefined && typeof input.timeZone !== "string") {
		throw new RsiError("CONFIG_INVALID", "timeZone must be a string.");
	}
	const timeZone = assertValidTimeZone(input.timeZone === undefined ? DEFAULT_TIME_ZONE : input.timeZone);
	const paths = deriveRuntimePaths(parsePathInput(input.paths));
	assertRuntimePathPolicy(paths);
	return {
		version: RSI_CONFIG_VERSION,
		timeZone,
		paths,
		ipc: parseIpc(input.ipc),
		sandbox: parseSandbox(input.sandbox),
	};
}

/** Load a JSON configuration file. File reading is separated from pure validation. */
export async function loadRsiConfigFile(path: string): Promise<RsiConfig> {
	const absolutePath = requireAbsolutePath(path, "configPath");
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(absolutePath, "utf8"));
	} catch (error) {
		throw new RsiError("CONFIG_INVALID", `Could not read configuration file: ${absolutePath}`, { cause: error });
	}
	return parseRsiConfig(parsed);
}

/** Load the configuration named by RSI_CONFIG_PATH. */
export async function loadRsiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<RsiConfig> {
	const path = env[RSI_CONFIG_ENV];
	if (!path) {
		throw new RsiError("CONFIG_INVALID", `${RSI_CONFIG_ENV} is not set.`);
	}
	return loadRsiConfigFile(path);
}
