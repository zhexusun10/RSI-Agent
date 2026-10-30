import type {
	InlineExtension,
	ModelRuntime,
	SessionManager,
	SessionStartEvent,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { HeartbeatAck, HeartbeatReport, HealthTurnResult } from "../shared/ipc/protocol.ts";
import type {
	DocumentStorePort,
	MemoryPort,
	PreflightPort,
	SleepGatePort,
	ToolMiddlewarePort,
	ToolResultDecorationPort,
} from "../shared/ports.ts";
import type { RsiConfig } from "../shared/config.ts";
import type { HealthTurnObservation, PreflightReport } from "../shared/preflight.ts";
import type { ManualSystemPrompt } from "../shared/prompt.ts";
import type { ReloadStartResult } from "../shared/ipc/protocol.ts";
import type { SleepState } from "../shared/sleep.ts";
import type { WorkerIpcClient } from "../shared/ipc/port.ts";
import type { WorkerToSupervisorEvent, WorkerToSupervisorEvents } from "../shared/ipc/protocol.ts";

/** A request/response service that the trusted Supervisor exposes to the Worker. */
export interface HeartbeatPort {
	beat(report: HeartbeatReport): Promise<HeartbeatAck>;
}

/** External reload lifecycle. Preflight must complete before the real session.reload(). */
export interface WorkerReloadPort {
	preflight(candidateId?: string): Promise<PreflightReport>;
	started(report: PreflightReport): Promise<ReloadStartResult>;
	failed(attemptId: string, reason: string): Promise<void>;
}

export type WorkerTelemetryEvent =
	| { readonly type: "agent_end"; readonly willRetry: boolean; readonly atMs: number }
	| {
			readonly type: "agent_settled";
			readonly runId: string;
			readonly generation: number | null;
			readonly sessionId: string | null;
			readonly aborted: boolean;
			readonly stopReason: string;
			readonly assistantMessages: number;
			readonly atMs: number;
	  }
	| {
			readonly type: "exception";
			readonly scope: string;
			readonly message: string;
			readonly atMs: number;
	  }
	| {
			readonly type: "health_turn";
			readonly observation: HealthTurnObservation;
			readonly result: HealthTurnResult;
			readonly atMs: number;
	  }
	| {
			readonly type: "reload";
			readonly phase: "preflight" | "started" | "completed" | "failed";
			readonly detail?: string;
			readonly atMs: number;
	  }
	| { readonly type: "sleep"; readonly state: SleepState; readonly atMs: number };

/** Optional observability sink. The Supervisor contract needs explicit methods for these edges. */
export interface WorkerTelemetryPort {
	emit(event: WorkerTelemetryEvent): void | Promise<void>;
}

export interface WorkerEventSink {
	sendEvent<E extends WorkerToSupervisorEvent>(
		event: E,
		payload: WorkerToSupervisorEvents[E],
	): void;
}

/** The public service surface consumed by the Pi Worker. None of these read RSI source directly. */
export interface PiWorkerServices {
	readonly memory: MemoryPort;
	readonly documents: DocumentStorePort;
	readonly decoration: ToolResultDecorationPort;
	readonly sleep: SleepGatePort;
	readonly preflight: PreflightPort;
	readonly reload: WorkerReloadPort;
	readonly health: {
		record(observation: HealthTurnObservation): Promise<HealthTurnResult>;
	};
	readonly heartbeat: HeartbeatPort;
	readonly telemetry?: WorkerTelemetryPort;
}

export interface PiWorkerOptions {
	readonly config: RsiConfig;
	readonly manualPrompt: ManualSystemPrompt;
	readonly cwd: string;
	readonly agentDir: string;
	readonly model: Model<any>;
	readonly modelRuntime: ModelRuntime;
	readonly settingsManager: SettingsManager;
	readonly thinkingLevel?: ThinkingLevel;
	readonly sessionManager?: SessionManager;
	readonly services: PiWorkerServices;
	readonly events?: WorkerEventSink;
	readonly toolMiddleware?: ToolMiddlewarePort;
	/**
	 * The externally preflight-approved immutable extension entry points. The mandatory
	 * pi-continuity and pi-better-web-search entries are appended automatically unless
	 * already present.
	 */
	readonly approvedExtensionPaths?: readonly string[];
	/** Extra native/built-in extension factories (for example an integration-owned MCP wrapper). */
	readonly extensionFactories?: readonly InlineExtension[];
	readonly sessionStartEvent?: SessionStartEvent;
	readonly generation?: number | null;
	/** Fired once the final provider context has been assembled for a request. */
	readonly onProviderRequest?: () => void;
}

/** Build the service surface backed by the shared Worker IPC client. */
export function createIpcWorkerServices(ipc: WorkerIpcClient): PiWorkerServices {
	return {
		memory: {
			async readCurrentMemory(signal) {
				return await ipc.request("memory.current", {}, { signal });
			},
			async commitMemory(input, signal) {
				const result = await ipc.request(
					"docs.commit",
					{
						name: "Memory.md",
						content: input.content,
						expectedRevision: input.expectedRevision,
						operation: "memory",
					},
					{ signal },
				);
				const snapshot = await ipc.request("memory.current", {}, { signal });
				return {
					snapshot,
					usage: result.memoryUsage ?? `[System Meta: Current Memory Usage: ${result.words} / 500 words]`,
				};
			},
		},
		documents: {
			async list() {
				return await ipc.request("docs.list", {});
			},
			async read(name) {
				return await ipc.request("docs.read", { name });
			},
			async readForTool(name, now) {
				return await ipc.request("docs.readView", { name, atMs: now.getTime() });
			},
			async commit(request) {
				return await ipc.request("docs.commit", request);
			},
			async indexReport(now) {
				return await ipc.request("docs.indexReport", { nowMs: now.getTime() });
			},
			async consistency() {
				return await ipc.request("docs.consistency", {});
			},
			async recordRead(name, at) {
				const result = await ipc.request("reads.record", { name, atMs: at.getTime() });
				return result.readsLast24h;
			},
		},
		decoration: {
			async decorate(request, _now, signal) {
				return await ipc.request("tools.decorateResult", request, {
					...(signal === undefined ? {} : { signal }),
					timeoutMs: 15_000,
				});
			},
		},
		sleep: {
			async request(input, _now, toolCallId) {
				const duration = typeof input.duration === "string" ? input.duration : undefined;
				const until = typeof input.until === "string" ? input.until : undefined;
				return await ipc.request("sleep.request", {
					...(duration === undefined ? {} : { duration }),
					...(until === undefined ? {} : { until }),
					...(toolCallId === undefined ? {} : { toolCallId }),
				});
			},
			async status() {
				return await ipc.request("sleep.status", {});
			},
			async cancel(_reason) {
				// Cancellation is a Supervisor->Worker request in the shared contract.
				// Returning false here avoids inventing a Worker->Supervisor method.
				return false;
			},
		},
		preflight: {
			async preflight(candidateId, signal) {
				return await ipc.request(
					"reload.preflight",
					{
						reason: "worker",
						requestedBy: "worker",
						...(candidateId === undefined ? {} : { candidateId }),
					},
					{ signal, timeoutMs: 60_000 },
				);
			},
		},
		reload: {
			async preflight(candidateId) {
				return await ipc.request(
					"reload.preflight",
					{
						reason: "worker",
						requestedBy: "worker",
						...(candidateId === undefined ? {} : { candidateId }),
					},
					{ timeoutMs: 60_000 },
				);
			},
			async started(report) {
				return await ipc.request("reload.started", {
					preflightId: report.candidateId,
					candidateId: report.candidateId,
					digest: report.digest,
				});
			},
			async failed(attemptId, reason) {
				await ipc.request("reload.failed", { attemptId, reason });
			},
		},
		health: {
			async record(observation) {
				return await ipc.request("health.turn", observation);
			},
		},
		heartbeat: {
			async beat(report) {
				return await ipc.request("heartbeat", report);
			},
		},
	};
}
