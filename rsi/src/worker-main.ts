import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { parseRsiConfig, type RsiConfig } from "./shared/config.ts";
import { RsiError } from "./shared/errors.ts";
import { readImmutableSystemPrompt } from "./shared/prompt.ts";
import { createIpcWorkerServices, type PiWorkerServices, type WorkerEventSink } from "./pi/worker-types.ts";
import { bindWorkerControlIpc } from "./pi/control-ipc.ts";
import { createPiWorker, type PiWorker } from "./pi/worker.ts";
import {
	WORKER_IPC_ENDPOINT_ENV,
	WorkerIpcConnection,
} from "./integration/ipc-transport.ts";
import {
	MAX_WORKER_BOOTSTRAP_BYTES,
	parseWorkerBootstrapLine,
	type WorkerBootstrap,
} from "./shared/ipc/bootstrap.ts";
import type {
	WorkerToSupervisorEvent,
	WorkerToSupervisorEvents,
} from "./shared/ipc/protocol.ts";

export const WORKER_CONFIG_ENV = "RSI_WORKER_CONFIG_JSON";
export const WORKER_EXTENSION_PATHS_ENV = "RSI_WORKER_EXTENSION_PATHS_JSON";
export const WORKER_GENERATION_ENV = "RSI_WORKER_GENERATION";
export const WORKER_TEST_MODEL_MODULE_ENV = "RSI_WORKER_TEST_MODEL_MODULE";
export const WORKER_TEST_MODE_ENV = "RSI_WORKER_TEST_MODE";

const WORKER_BOOTSTRAP_TIMEOUT_MS = 15_000;

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface WorkerModelSelection {
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<any>;
	readonly settingsManager?: SettingsManager;
}

export interface WorkerModelModule {
	createWorkerModel(input: {
		readonly cwd: string;
		readonly agentDir: string;
		readonly env: NodeJS.ProcessEnv;
	}): Promise<WorkerModelSelection>;
}

function parseConfigFromEnv(env: NodeJS.ProcessEnv): RsiConfig {
	const raw = env[WORKER_CONFIG_ENV];
	if (raw === undefined || raw.trim().length === 0) {
		throw new RsiError("CONFIG_INVALID", `${WORKER_CONFIG_ENV} is required inside the Worker.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new RsiError("CONFIG_INVALID", `${WORKER_CONFIG_ENV} is not valid JSON.`, { cause: error });
	}
	return parseRsiConfig(parsed);
}

function parseGeneration(env: NodeJS.ProcessEnv): number | null {
	const raw = env[WORKER_GENERATION_ENV];
	if (raw === undefined || raw.length === 0) return null;
	if (!/^[1-9][0-9]*$/.test(raw)) {
		throw new RsiError("CONFIG_INVALID", `${WORKER_GENERATION_ENV} must be a positive integer.`);
	}
	const generation = Number(raw);
	if (!Number.isSafeInteger(generation)) {
		throw new RsiError("CONFIG_INVALID", `${WORKER_GENERATION_ENV} is too large.`);
	}
	return generation;
}

function parseExtensionPaths(env: NodeJS.ProcessEnv): readonly string[] {
	const raw = env[WORKER_EXTENSION_PATHS_ENV];
	if (raw === undefined || raw.trim().length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new RsiError("CONFIG_INVALID", `${WORKER_EXTENSION_PATHS_ENV} is not valid JSON.`, { cause: error });
	}
	if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string" && entry.length > 0)) {
		throw new RsiError("CONFIG_INVALID", `${WORKER_EXTENSION_PATHS_ENV} must be an array of paths.`);
	}
	return parsed.map((entry) => resolve(entry));
}

/** Read one bounded bootstrap record from the inherited stdin pipe, then close it. */
async function readWorkerBootstrap(stream: NodeJS.ReadableStream = process.stdin): Promise<WorkerBootstrap> {
	return await new Promise<WorkerBootstrap>((resolve, reject) => {
		let text = "";
		let bytes = 0;
		let settled = false;
		const cleanup = (): void => {
			clearTimeout(timer);
			stream.off("data", onData);
			stream.off("end", onEnd);
			stream.off("error", onError);
			if (typeof (stream as { pause?: () => void }).pause === "function") {
				(stream as { pause: () => void }).pause();
			}
			if (typeof (stream as unknown as { destroy?: () => void }).destroy === "function") {
				(stream as unknown as { destroy: () => void }).destroy();
			}
		};
		const finish = (error?: unknown, value?: WorkerBootstrap): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error !== undefined) reject(error);
			else if (value !== undefined) resolve(value);
			else reject(new RsiError("CONFIG_INVALID", "Worker bootstrap record is missing."));
		};
		const parse = (line: string): void => {
			try {
				finish(undefined, parseWorkerBootstrapLine(line));
			} catch (error) {
				finish(error);
			}
		};
		const onData = (chunk: Buffer | string): void => {
			const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			bytes += Buffer.byteLength(value, "utf8");
			if (bytes > MAX_WORKER_BOOTSTRAP_BYTES) {
				finish(new RsiError("CONFIG_INVALID", "Worker bootstrap record exceeds its byte limit."));
				return;
			}
			text += value;
			const newline = text.indexOf("\n");
			if (newline >= 0) parse(text.slice(0, newline));
		};
		const onEnd = (): void => parse(text);
		const onError = (error: Error): void => finish(
			new RsiError("CONFIG_INVALID", "Worker bootstrap stdin failed.", { cause: error }),
		);
		const timer = setTimeout(() => {
			finish(new RsiError("IPC_TIMEOUT", "Worker bootstrap credential did not arrive before the deadline."));
		}, WORKER_BOOTSTRAP_TIMEOUT_MS);
		timer.unref?.();
		stream.on("data", onData);
		stream.once("end", onEnd);
		stream.once("error", onError);
		if (typeof (stream as { resume?: () => void }).resume === "function") {
			(stream as { resume: () => void }).resume();
		}
	});
}

function parseThinkingLevel(env: NodeJS.ProcessEnv): ThinkingLevel | undefined {
	const raw = env.RSI_THINKING_LEVEL;
	if (raw === undefined || raw.trim().length === 0) return undefined;
	const level = raw.trim() as ThinkingLevel;
	if (!THINKING_LEVELS.has(level)) {
		throw new RsiError("CONFIG_INVALID", `RSI_THINKING_LEVEL must be one of ${[...THINKING_LEVELS].join(", ")}.`);
	}
	return level;
}

export async function createProductionModel(input: {
	readonly cwd: string;
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
}): Promise<WorkerModelSelection> {
	const settingsManager = SettingsManager.create(input.cwd, input.agentDir);
	const modelRuntime = await ModelRuntime.create({
		authPath: resolve(input.agentDir, "auth.json"),
		modelsPath: resolve(input.agentDir, "models.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const provider = input.env.RSI_PROVIDER?.trim();
	const modelId = input.env.RSI_MODEL?.trim();
	let model: Model<any> | undefined;
	if (provider !== undefined && provider.length > 0) {
		if (modelId === undefined || modelId.length === 0) {
			throw new RsiError("CONFIG_INVALID", "RSI_MODEL is required when RSI_PROVIDER is set.");
		}
		model = modelRuntime.getModel(provider, modelId) as Model<any> | undefined;
		if (model === undefined) {
			throw new RsiError(
				"CONFIG_INVALID",
				`Configured Pi model ${provider}/${modelId} was not found; refusing to fall back to a different model.`,
			);
		}
	} else {
		const defaultProvider = settingsManager.getDefaultProvider();
		const defaultModel = settingsManager.getDefaultModel();
		if (defaultProvider !== undefined && defaultModel !== undefined) {
			model = modelRuntime.getModel(defaultProvider, defaultModel) as Model<any> | undefined;
		}
	}
	if (model === undefined) {
		const available = await modelRuntime.getAvailable();
		model = available[0] as Model<any> | undefined;
	}
	if (model === undefined) {
		throw new RsiError(
			"CONFIG_INVALID",
			"No Pi model is available. Set RSI_PROVIDER and RSI_MODEL, or configure /data/pi-agent/settings.json and credentials.",
		);
	}
	return { modelRuntime, model, settingsManager };
}

async function createModel(input: {
	readonly cwd: string;
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
}): Promise<WorkerModelSelection> {
	const testModule = input.env[WORKER_TEST_MODEL_MODULE_ENV];
	if (testModule === undefined || testModule.length === 0) {
		return await createProductionModel(input);
	}
	if (input.env[WORKER_TEST_MODE_ENV] !== "1") {
		throw new RsiError(
			"CONFIG_INVALID",
			`${WORKER_TEST_MODEL_MODULE_ENV} is allowed only with ${WORKER_TEST_MODE_ENV}=1.`,
		);
	}
	const module = (await import(pathToFileURL(resolve(testModule)).href)) as WorkerModelModule;
	if (typeof module.createWorkerModel !== "function") {
		throw new RsiError("CONFIG_INVALID", "Test model module must export createWorkerModel().");
	}
	return await module.createWorkerModel(input);
}

function telemetryNoop(): PiWorkerServices["telemetry"] {
	return {
		emit() {
			// Agent lifecycle and exception diagnostics travel through the typed
			// Worker event sink, not a duplicate telemetry path.
		},
	};
}

export interface RunningWorker {
	readonly worker: PiWorker;
	readonly ipc: WorkerIpcConnection;
	stop(reason: string): Promise<void>;
}

/** Start the Pi Worker against an already-listening Supervisor IPC endpoint. */
export async function startWorkerProcess(env: NodeJS.ProcessEnv = process.env): Promise<RunningWorker> {
	const config = parseConfigFromEnv(env);
	const endpoint = env[WORKER_IPC_ENDPOINT_ENV];
	if (endpoint === undefined || endpoint.length === 0) {
		throw new RsiError("CONFIG_INVALID", `${WORKER_IPC_ENDPOINT_ENV} is required inside the Worker.`);
	}
	const generation = parseGeneration(env);
	// Consume the one-time launch credential before loading any model/extension
	// code, then close the inherited pipe. It is never exposed via process.env.
	const bootstrap = await readWorkerBootstrap();
	if (bootstrap.generation !== generation) {
		throw new RsiError("CONFIG_INVALID", "Worker bootstrap generation does not match RSI_WORKER_GENERATION.");
	}
	// Authenticate immediately after consuming the credential, before any model
	// or extension code can run. This minimizes the unauthenticated connection
	// window and makes the launch identity authoritative for all later messages.
	const ipc = await WorkerIpcConnection.connect({
		endpoint,
		maxFrameBytes: config.ipc.maxFrameBytes,
		requestTimeoutMs: config.ipc.requestTimeoutMs,
		authentication: {
			launchId: bootstrap.launchId,
			token: bootstrap.token,
			generation: bootstrap.generation,
		},
	});
	const manualPrompt = await readImmutableSystemPrompt(config.paths.systemPromptFile);
	const agentDir = config.paths.piAgentDir;
	const cwd = config.paths.workspaceDir;
	const selected = await createModel({ cwd, agentDir, env });
	const settingsManager = selected.settingsManager ?? SettingsManager.create(cwd, agentDir);
	let workerRef: PiWorker | undefined;
	let observedSessionId: string | null = null;
	const currentSessionId = (): string | null => {
		try {
			return workerRef?.status().sessionId ?? observedSessionId;
		} catch {
			return observedSessionId;
		}
	};
	const events: WorkerEventSink = {
		sendEvent<E extends WorkerToSupervisorEvent>(
			event: E,
			payload: WorkerToSupervisorEvents[E],
		): void {
			if (event === "worker.ready" || event === "agent.settled") {
				observedSessionId =
					(payload as { readonly sessionId?: string | null }).sessionId ?? null;
			}
			ipc.sendEvent(event, payload);
		},
	};
	const baseServices = createIpcWorkerServices(ipc);
	const services: PiWorkerServices = {
		...baseServices,
		health: {
			record: async (observation) =>
				await ipc.request("health.turn", {
					...observation,
					sessionId: currentSessionId(),
				}),
		},
		heartbeat: {
			beat: async (report) =>
				await baseServices.heartbeat.beat({
					...report,
					sessionId: currentSessionId(),
				}),
		},
		telemetry: telemetryNoop(),
	};
	let pendingRecoveryNoticeId: string | undefined;
	let recoveryNoticeProviderRequested = false;
	const worker = await createPiWorker({
		config,
		manualPrompt,
		cwd,
		agentDir,
		model: selected.model,
		modelRuntime: selected.modelRuntime,
		settingsManager,
		services,
		events,
		approvedExtensionPaths: parseExtensionPaths(env),
		generation,
		thinkingLevel: parseThinkingLevel(env),
		onProviderRequest: () => {
			// Mark delivery, but do not acknowledge yet: the Supervisor-owned notice
			// must survive a crash between request construction and run settlement.
			if (pendingRecoveryNoticeId !== undefined) recoveryNoticeProviderRequested = true;
		},
	});
	workerRef = worker;
	const unbind = bindWorkerControlIpc(worker, ipc);
	const accepted = new Map<string, string>();
	ipc.handle("runtime.turn", async (payload) => {
		const existing = accepted.get(payload.continuationId);
		if (existing !== undefined) return { accepted: true, runId: existing };
		if (worker.status().state !== "idle") {
			return {
				accepted: false,
				queued: true,
				detail: `Worker is ${worker.status().state}; the runtime turn was not started.`,
			};
		}
		const runId = payload.continuationId;
		accepted.set(payload.continuationId, runId);
		pendingRecoveryNoticeId = payload.noticeId;
		recoveryNoticeProviderRequested = false;
		if (accepted.size > 500) {
			const first = accepted.keys().next().value;
			if (first !== undefined) accepted.delete(first);
		}
		void worker
			.run(payload.message, undefined, { runId })
			.then(() => {
				if (pendingRecoveryNoticeId === undefined || !recoveryNoticeProviderRequested) return;
				const notificationId = pendingRecoveryNoticeId;
				pendingRecoveryNoticeId = undefined;
				recoveryNoticeProviderRequested = false;
				ipc.sendEvent("recovery.noticeDelivered", { notificationId, atMs: Date.now() });
			})
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				ipc.sendEvent("worker.exception", {
					scope: "runtime.turn",
					message,
					...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
					atMs: Date.now(),
				});
			});
		return { accepted: true, runId };
	});
	ipc.handle("worker.abort", async () => {
		await worker.session.abort();
		return { aborted: true as const };
	});
	ipc.onEvent("sleep.wake", () => {
		// The explicit-sleep gate polls the authoritative external state before each
		// provider request, so a wake event does not need to inject a message.
	});
	const stop = async (reason: string): Promise<void> => {
		unbind();
		await worker.stop(reason).catch(() => undefined);
		await ipc.close().catch(() => undefined);
	};
	return { worker, ipc, stop };
}

async function main(): Promise<void> {
	const running = await startWorkerProcess(process.env);
	let stopping = false;
	const shutdown = (reason: string): void => {
		if (stopping) return;
		stopping = true;
		void running
			.stop(reason)
			.catch((error) => {
				console.error(`[rsi-worker] shutdown failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
			})
			.finally(() => process.exit(0));
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("uncaughtException", (error) => {
		const message = error instanceof Error ? error.message : String(error);
		running.ipc.sendEvent("worker.exception", {
			scope: "uncaughtException",
			message,
			stack: error instanceof Error ? error.stack : undefined,
			atMs: Date.now(),
		});
		console.error(`[rsi-worker] uncaught exception: ${error instanceof Error ? error.stack ?? message : message}`);
		// Exit so the external Watchdog observes a real process failure instead of
		// leaving a half-broken Worker silently alive.
		setTimeout(() => process.exit(70), 100);
	});
	process.on("unhandledRejection", (reason) => {
		const error = reason instanceof Error ? reason : new Error(String(reason));
		running.ipc.sendEvent("worker.exception", {
			scope: "unhandledRejection",
			message: error.message,
			stack: error.stack,
			atMs: Date.now(),
		});
		console.error(`[rsi-worker] unhandled rejection: ${error.stack ?? error.message}`);
		setTimeout(() => process.exit(70), 100);
	});
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(
			`[rsi-worker] startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
		);
		process.exit(78);
	}
}
