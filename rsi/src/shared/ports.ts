import type { EditOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	DocumentCommitRequest,
	DocumentMutationResult,
	IndexConsistency,
} from "./documents.ts";
import type { RsiConfig } from "./config.ts";
import type { RuntimeEventPublisher } from "./events.ts";
import type { ContentRevision } from "./hash.ts";
import type {
	HeartbeatReport,
	IndexReadReport,
	ManagedDocumentSnapshot,
	ManagedDocumentSummary,
	SleepGrant,
	ToolResultDecorationRequest,
	ToolResultDecorationResult,
} from "./ipc/protocol.ts";
import type {
	SupervisorIpcClient,
	SupervisorIpcServer,
	WorkerIpcClient,
	WorkerIpcServer,
} from "./ipc/port.ts";
import type { ManualSystemPrompt } from "./prompt.ts";
import type { RuntimePaths } from "./paths.ts";
import type { MemorySnapshot } from "./memory.ts";
import type { PluginCandidate, LkgSnapshot } from "./plugins.ts";
import type { HealthTurnObservation, PluginGenerationState, PreflightReport } from "./preflight.ts";
import type { SandboxLauncher, SandboxPolicy } from "./sandbox.ts";
import type { SleepRequestInput, SleepState } from "./sleep.ts";
import type { Clock } from "./time.ts";

export interface MemoryPort {
	readCurrentMemory(signal?: AbortSignal): Promise<MemorySnapshot>;
	commitMemory(input: {
		readonly content: string;
		readonly expectedRevision: ContentRevision;
	}, signal?: AbortSignal): Promise<{ readonly snapshot: MemorySnapshot; readonly usage: string }>;
}

export interface DocumentStorePort {
	list(): Promise<readonly ManagedDocumentSummary[]>;
	read(name: string): Promise<ManagedDocumentSnapshot>;
	/** Request-time tool view, used by read(index.md) without changing the source file. */
	readForTool?(name: string, now: Date): Promise<ManagedDocumentSnapshot>;
	commit(request: DocumentCommitRequest): Promise<DocumentMutationResult>;
	indexReport(now: Date): Promise<IndexReadReport>;
	consistency(): Promise<IndexConsistency>;
	recordRead(name: string, at: Date): Promise<number>;
}

/**
 * Native Pi read/write/edit factories accept these operation objects. The
 * Worker must route managed absolute paths to the external broker here while
 * leaving all other paths on the normal local filesystem implementation.
 */
export interface NativeToolOperationsPort {
	readonly read: ReadOperations;
	readonly write: WriteOperations;
	readonly edit: EditOperations;
}

export interface ToolCallDescriptor {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly cwd: string;
}

export type ToolCallDecision =
	| { readonly action: "allow" }
	| { readonly action: "block"; readonly reason: string; readonly terminate?: boolean };

export interface ToolResultDescriptor {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly content: readonly (TextContent | ImageContent)[];
	readonly isError: boolean;
	readonly details?: unknown;
}

export interface ToolResultPatch {
	readonly content?: readonly (TextContent | ImageContent)[];
	readonly details?: unknown;
	readonly structuredContent?: unknown;
	readonly isError?: boolean;
}

export interface ToolMiddlewarePort {
	beforeToolCall(input: ToolCallDescriptor, signal?: AbortSignal): Promise<ToolCallDecision>;
	afterToolResult(input: ToolResultDescriptor, signal?: AbortSignal): Promise<ToolResultPatch>;
}

export interface ToolResultDecorationPort {
	decorate(request: ToolResultDecorationRequest, now: Date, signal?: AbortSignal): Promise<ToolResultDecorationResult>;
}

export interface PreflightPort {
	preflight(candidateId?: string, signal?: AbortSignal): Promise<PreflightReport>;
}

export interface SnapshotStorePort {
	loadState(): Promise<PluginGenerationState>;
	saveState(state: PluginGenerationState): Promise<void>;
	createLkg(candidate: PluginCandidate, now: Date): Promise<LkgSnapshot>;
	restoreLkg(snapshot: LkgSnapshot): Promise<void>;
}

export interface WorkerLaunchSpec {
	readonly generation: number;
	readonly candidate?: PluginCandidate;
	readonly sandbox: SandboxPolicy;
	readonly config: RsiConfig;
}

export interface WorkerProcessInfo {
	/** Host process id owned by the Supervisor launch handle (bwrap in production). */
	readonly pid: number;
	/** Explicit host id when pid is a Worker-reported namespace identity. */
	readonly hostPid?: number;
	/** Worker-reported PID-namespace identity, for diagnostics only. */
	readonly reportedPid?: number;
	readonly startedAtMs: number;
}

export interface WorkerLifecyclePort {
	start(spec: WorkerLaunchSpec, signal?: AbortSignal): Promise<WorkerProcessInfo>;
	stop(reason: string): Promise<void>;
}

export interface WatchdogPort {
	start(): void;
	stop(): Promise<void>;
	recordHeartbeat(report: HeartbeatReport, now: Date): Promise<void>;
	recordWorkerExit(exitCode: number | null, signal: string | null, now: Date): Promise<void>;
}

export interface LoopPauseState {
	readonly state: "running" | "sleeping" | "stopped";
	readonly reason?: "explicit-sleep";
	readonly sleepId?: string;
	readonly deadlineMs?: number;
}

/** The autonomous loop has no generic pause API: only an explicit validated sleep may pause it. */
export interface AutonomousLoopPort {
	start(): Promise<void>;
	stop(reason: string): Promise<void>;
	pauseForSleep(state: SleepState): Promise<void>;
	resumeFromSleep(state: SleepState): Promise<void>;
	status(): LoopPauseState;
}

export interface SleepGatePort {
	request(input: SleepRequestInput, now: Date, toolCallId?: string): Promise<SleepGrant>;
	status(): Promise<SleepState | null>;
	cancel(reason: string, now: Date): Promise<boolean>;
}

/** Commands can only originate from the trusted Supervisor process, never from an agent tool. */
export type ControlCommand =
	| { readonly kind: "reload"; readonly reason: string; readonly candidateId?: string }
	| { readonly kind: "shutdown"; readonly reason: string }
	| { readonly kind: "cancelSleep"; readonly reason: string };

export type ControlCommandResult =
	| { readonly ok: true; readonly detail?: string }
	| { readonly ok: false; readonly error: string };

export interface CommandControlPort {
	dispatch(
		command: ControlCommand,
		context: { readonly source: "supervisor"; readonly atMs: number },
	): Promise<ControlCommandResult>;
}

export interface HealthTurnPort {
	record(observation: HealthTurnObservation): Promise<{
		readonly count: number;
		readonly required: number;
		readonly promoted: boolean;
	}>;
}

export interface WorkerStatusPort {
	status(): Promise<{
		readonly generation: number | null;
		readonly healthTurns: number;
		readonly memoryRevision: ContentRevision | null;
	}>;
}

export interface SupervisorDependencies {
	readonly config: RsiConfig;
	readonly paths: RuntimePaths;
	readonly clock: Clock;
	readonly ipcServer: SupervisorIpcServer;
	readonly workerIpc: SupervisorIpcClient;
	readonly sandbox: SandboxLauncher;
	readonly memory: MemoryPort;
	readonly documents: DocumentStorePort;
	readonly preflight: PreflightPort;
	readonly snapshots: SnapshotStorePort;
	readonly watchdog: WatchdogPort;
	readonly health: HealthTurnPort;
	readonly worker: WorkerLifecyclePort;
	readonly loop: AutonomousLoopPort;
	readonly sleep: SleepGatePort;
	readonly commands: CommandControlPort;
	readonly events: RuntimeEventPublisher;
}

export interface WorkerBootstrapDependencies {
	readonly config: RsiConfig;
	readonly paths: RuntimePaths;
	readonly clock: Clock;
	readonly manualPrompt: ManualSystemPrompt;
	readonly ipc: WorkerIpcClient;
	readonly ipcServer: WorkerIpcServer;
	readonly toolOperations: NativeToolOperationsPort;
	readonly toolMiddleware: ToolMiddlewarePort;
	readonly toolDecoration: ToolResultDecorationPort;
	readonly pluginExtensionPaths: readonly string[];
}
