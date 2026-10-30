import type { DocumentMutationResult, IndexConsistency } from "./documents.ts";
import type { HeartbeatReport } from "./ipc/protocol.ts";
import type { MemorySnapshot } from "./memory.ts";
import type { HealthTurnObservation, PreflightReport } from "./preflight.ts";
import type { LkgSnapshot } from "./plugins.ts";
import type { SleepState } from "./sleep.ts";
import type { ToolResultDecorationResult } from "./ipc/protocol.ts";

export interface RuntimeEventMap {
	"runtime.started": { readonly pid: number; readonly startedAtMs: number };
	"runtime.stopping": { readonly reason: string; readonly atMs: number };
	"worker.ready": { readonly pid: number; readonly generation: number | null; readonly atMs: number };
	"worker.exit": { readonly exitCode: number | null; readonly signal: string | null; readonly atMs: number };
	"worker.heartbeat": HeartbeatReport;
	"worker.heartbeat.missed": { readonly missed: number; readonly lastHeartbeatAtMs: number; readonly atMs: number };
	"memory.changed": MemorySnapshot;
	"docs.changed": DocumentMutationResult;
	"docs.index.inconsistent": IndexConsistency;
	"tool.result.decorated": ToolResultDecorationResult & {
		readonly toolCallId: string;
		readonly atMs: number;
	};
	"sleep.requested": SleepState;
	"sleep.entered": SleepState;
	"sleep.woke": SleepState;
	"loop.paused": { readonly reason: "explicit-sleep"; readonly sleepId: string; readonly atMs: number };
	"loop.resumed": { readonly reason: "sleep-complete"; readonly sleepId: string; readonly atMs: number };
	"reload.preflight": PreflightReport;
	"reload.started": {
		readonly attemptId: string;
		readonly generation: number;
		readonly candidateDigest: string;
		readonly atMs: number;
	};
	"reload.health": {
		readonly observation: HealthTurnObservation;
		readonly consecutiveHealthyTurns: number;
		readonly required: 3;
		readonly atMs: number;
	};
	"reload.promoted": LkgSnapshot;
	"reload.rollback": {
		readonly lkg: LkgSnapshot;
		readonly reason: string;
		readonly atMs: number;
	};
	"watchdog.suspect": { readonly missedHeartbeats: number; readonly atMs: number };
	"command.received": {
		readonly kind: "reload" | "shutdown" | "cancelSleep";
		readonly source: "supervisor";
		readonly atMs: number;
	};
}

export type RuntimeEventName = keyof RuntimeEventMap;

export interface RuntimeEventEnvelope<K extends RuntimeEventName = RuntimeEventName> {
	readonly eventId: string;
	readonly event: K;
	readonly payload: RuntimeEventMap[K];
	readonly atMs: number;
}

export interface RuntimeEventPublisher {
	emit<K extends RuntimeEventName>(event: K, payload: RuntimeEventMap[K]): void;
}

export interface RuntimeEventSubscriber {
	on<K extends RuntimeEventName>(event: K, handler: (payload: RuntimeEventMap[K]) => void): () => void;
}

export interface RuntimeEventBus extends RuntimeEventPublisher, RuntimeEventSubscriber {}
