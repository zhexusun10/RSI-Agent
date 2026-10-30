import type { LkgSnapshot } from "../shared/plugins.ts";
import type { HeartbeatReport } from "../shared/ipc/protocol.ts";
import { RsiError } from "../shared/errors.ts";

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_BUSY_LEASE_MULTIPLIER = 2;
export const DEFAULT_WATCHDOG_TICK_MS = 5_000;
export const DEFAULT_RESTART_BASE_MS = 1_000;
export const DEFAULT_RESTART_MAX_MS = 60_000;
export const DEFAULT_MAX_RESTARTS = 5;
export const DEFAULT_STABLE_RESET_MS = 120_000;
export const MAX_INCIDENT_HISTORY = 20;
export const MAX_NOTICE_LOG_BYTES = 8_192;
export const MAX_WATCHDOG_LOG_BYTES = 256 * 1024;

export type WatchdogPhase =
	| "idle"
	| "starting"
	| "healthy"
	| "suspect"
	| "recovering"
	| "rollback"
	| "stopped"
	| "unrecoverable";

export type ExpectedExitKind = "operator" | "reload" | "watchdog";

export interface WatchdogReloadLease {
	readonly attemptId: string;
	readonly candidateId: string;
	readonly generation: number;
	readonly digest: string;
	readonly startedAtMs: number;
	readonly deadlineMs: number;
}

export interface WatchdogExpectedExit {
	readonly pid: number;
	readonly kind: ExpectedExitKind;
	readonly reason: string;
	readonly atMs: number;
}

export interface WatchdogIncidentRecord {
	readonly incidentId: string;
	readonly reason: string;
	readonly atMs: number;
	readonly generation: number | null;
	readonly candidateId: string | null;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly stderrTail: string;
}

export interface WatchdogRecoveryState {
	readonly incidentId: string;
	readonly reason: string;
	readonly attempts: number;
	readonly mode: "waiting" | "restarting" | "unrecoverable";
	readonly nextAttemptAtMs: number | null;
	readonly lastError: string | null;
}

export interface WatchdogPersistentState {
	readonly version: 1;
	readonly phase: WatchdogPhase;
	/** Host process id used for kill/monitor (bwrap in production). */
	readonly workerPid: number | null;
	/** Worker-reported PID-namespace id, diagnostic only; never used for kill. */
	readonly reportedWorkerPid: number | null;
	/** Whether workerPid came from the Supervisor launch handle, not a legacy/ambiguous start. */
	readonly workerPidExplicit: boolean;
	/** Previous host ids whose late exits must not be treated as the current Worker. */
	readonly retiredWorkerPids: readonly number[];
	readonly generation: number | null;
	readonly lastHeartbeatAtMs: number | null;
	readonly leaseExpiresAtMs: number | null;
	readonly missedHeartbeats: number;
	readonly lastSequence: number;
	readonly activeCandidateId: string | null;
	readonly workerHeartbeatState: HeartbeatReport["state"] | null;
	readonly sleepSuspended: boolean;
	readonly reload: WatchdogReloadLease | null;
	readonly expectedExit: WatchdogExpectedExit | null;
	readonly recovery: WatchdogRecoveryState | null;
	readonly restartAttempts: number;
	readonly lastWorkerStartedAtMs: number | null;
	readonly lastIncident: WatchdogIncidentRecord | null;
	readonly incidents: readonly WatchdogIncidentRecord[];
	readonly operatorStopReason: string | null;
	readonly updatedAtMs: number;
}

export function initialWatchdogState(now: Date): WatchdogPersistentState {
	return {
		version: 1,
		phase: "idle",
		workerPid: null,
		reportedWorkerPid: null,
		workerPidExplicit: false,
		retiredWorkerPids: [],
		generation: null,
		lastHeartbeatAtMs: null,
		leaseExpiresAtMs: null,
		missedHeartbeats: 0,
		lastSequence: 0,
		activeCandidateId: null,
		workerHeartbeatState: null,
		sleepSuspended: false,
		reload: null,
		expectedExit: null,
		recovery: null,
		restartAttempts: 0,
		lastWorkerStartedAtMs: null,
		lastIncident: null,
		incidents: [],
		operatorStopReason: null,
		updatedAtMs: now.getTime(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PHASES: readonly WatchdogPhase[] = [
	"idle",
	"starting",
	"healthy",
	"suspect",
	"recovering",
	"rollback",
	"stopped",
	"unrecoverable",
];

const HEARTBEAT_STATES: readonly HeartbeatReport["state"][] = [
	"starting",
	"idle",
	"busy",
	"sleeping",
	"reloading",
	"stopping",
];

function validateIncident(value: unknown): WatchdogIncidentRecord {
	if (!isRecord(value)) throw new RsiError("INTERNAL", "Invalid watchdog incident.");
	if (
		typeof value.incidentId !== "string" ||
		typeof value.reason !== "string" ||
		typeof value.atMs !== "number" ||
		(value.generation !== null && !Number.isInteger(value.generation)) ||
		(value.candidateId !== null && typeof value.candidateId !== "string") ||
		(value.exitCode !== null && !Number.isInteger(value.exitCode)) ||
		(value.signal !== null && typeof value.signal !== "string") ||
		typeof value.stderrTail !== "string"
	) {
		throw new RsiError("INTERNAL", "Invalid watchdog incident fields.");
	}
	return {
		incidentId: value.incidentId,
		reason: value.reason,
		atMs: value.atMs,
		generation: value.generation as number | null,
		candidateId: value.candidateId as string | null,
		exitCode: value.exitCode as number | null,
		signal: value.signal as string | null,
		stderrTail: value.stderrTail,
	};
}

export function validateWatchdogPersistentState(value: unknown): WatchdogPersistentState {
	if (!isRecord(value) || value.version !== 1 || typeof value.updatedAtMs !== "number") {
		throw new RsiError("INTERNAL", "Invalid watchdog persistent state.");
	}
	if (typeof value.phase !== "string" || !PHASES.includes(value.phase as WatchdogPhase)) {
		throw new RsiError("INTERNAL", "Invalid watchdog phase.");
	}
	if (
		(value.workerPid !== null && !Number.isInteger(value.workerPid)) ||
		(value.generation !== null && !Number.isInteger(value.generation)) ||
		(value.lastHeartbeatAtMs !== null && typeof value.lastHeartbeatAtMs !== "number") ||
		(value.leaseExpiresAtMs !== null && typeof value.leaseExpiresAtMs !== "number") ||
		!Number.isInteger(value.missedHeartbeats) ||
		!Number.isInteger(value.lastSequence) ||
		(value.activeCandidateId !== null && typeof value.activeCandidateId !== "string") ||
		(value.workerHeartbeatState !== null &&
			(typeof value.workerHeartbeatState !== "string" ||
				!HEARTBEAT_STATES.includes(value.workerHeartbeatState as HeartbeatReport["state"]))) ||
		typeof value.sleepSuspended !== "boolean" ||
		!Number.isInteger(value.restartAttempts) ||
		(value.lastWorkerStartedAtMs !== null && typeof value.lastWorkerStartedAtMs !== "number") ||
		(value.operatorStopReason !== null && typeof value.operatorStopReason !== "string")
	) {
		throw new RsiError("INTERNAL", "Invalid watchdog state fields.");
	}
	let reload: WatchdogReloadLease | null = null;
	if (value.reload !== null) {
		const item = value.reload;
		if (
			!isRecord(item) ||
			typeof item.attemptId !== "string" ||
			typeof item.candidateId !== "string" ||
			!Number.isInteger(item.generation) ||
			typeof item.digest !== "string" ||
			typeof item.startedAtMs !== "number" ||
			typeof item.deadlineMs !== "number"
		) {
			throw new RsiError("INTERNAL", "Invalid watchdog reload lease.");
		}
		reload = {
			attemptId: item.attemptId,
			candidateId: item.candidateId,
			generation: item.generation as number,
			digest: item.digest,
			startedAtMs: item.startedAtMs,
			deadlineMs: item.deadlineMs,
		};
	}
	let expectedExit: WatchdogExpectedExit | null = null;
	if (value.expectedExit !== null) {
		const item = value.expectedExit;
		if (
			!isRecord(item) ||
			!Number.isInteger(item.pid) ||
			(item.kind !== "operator" && item.kind !== "reload" && item.kind !== "watchdog") ||
			typeof item.reason !== "string" ||
			typeof item.atMs !== "number"
		) {
			throw new RsiError("INTERNAL", "Invalid watchdog expected exit.");
		}
		expectedExit = {
			pid: item.pid as number,
			kind: item.kind,
			reason: item.reason,
			atMs: item.atMs,
		};
	}
	let recovery: WatchdogRecoveryState | null = null;
	if (value.recovery !== null) {
		const item = value.recovery;
		if (
			!isRecord(item) ||
			typeof item.incidentId !== "string" ||
			typeof item.reason !== "string" ||
			!Number.isInteger(item.attempts) ||
			(item.mode !== "waiting" && item.mode !== "restarting" && item.mode !== "unrecoverable") ||
			(item.nextAttemptAtMs !== null && typeof item.nextAttemptAtMs !== "number") ||
			(item.lastError !== null && typeof item.lastError !== "string")
		) {
			throw new RsiError("INTERNAL", "Invalid watchdog recovery state.");
		}
		recovery = {
			incidentId: item.incidentId,
			reason: item.reason,
			attempts: item.attempts as number,
			mode: item.mode,
			nextAttemptAtMs: item.nextAttemptAtMs as number | null,
			lastError: item.lastError as string | null,
		};
	}
	const incidents = Array.isArray(value.incidents) ? value.incidents.map(validateIncident).slice(-MAX_INCIDENT_HISTORY) : [];
	const retiredWorkerPids = Array.isArray(value.retiredWorkerPids)
		? value.retiredWorkerPids
				.filter((pid): pid is number => Number.isInteger(pid) && (pid as number) > 1)
				.slice(-32)
		: [];
	return {
		version: 1,
		phase: value.phase as WatchdogPhase,
		workerPid: value.workerPid as number | null,
		reportedWorkerPid:
			value.reportedWorkerPid === undefined
				? null
				: value.reportedWorkerPid === null || Number.isInteger(value.reportedWorkerPid)
					? (value.reportedWorkerPid as number | null)
					: null,
		workerPidExplicit: value.workerPidExplicit === true,
		retiredWorkerPids,
		generation: value.generation as number | null,
		lastHeartbeatAtMs: value.lastHeartbeatAtMs as number | null,
		leaseExpiresAtMs: value.leaseExpiresAtMs as number | null,
		missedHeartbeats: value.missedHeartbeats as number,
		lastSequence: value.lastSequence as number,
		activeCandidateId: value.activeCandidateId as string | null,
		workerHeartbeatState: value.workerHeartbeatState as HeartbeatReport["state"] | null,
		sleepSuspended: value.sleepSuspended,
		reload,
		expectedExit,
		recovery,
		restartAttempts: value.restartAttempts as number,
		lastWorkerStartedAtMs: value.lastWorkerStartedAtMs as number | null,
		lastIncident: value.lastIncident === null ? null : validateIncident(value.lastIncident),
		incidents,
		operatorStopReason: value.operatorStopReason as string | null,
		updatedAtMs: value.updatedAtMs,
	};
}

export interface RecoveryNotice {
	readonly version: 1;
	readonly notificationId: string;
	readonly incidentId: string;
	readonly kind: "crash-rollback" | "crash-no-lkg" | "rollback-failed" | "restart-failed";
	readonly createdAtMs: number;
	readonly reason: string;
	readonly generation: number | null;
	readonly candidateId: string | null;
	readonly lkgGeneration: number | null;
	readonly lkgCandidateId: string | null;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly log: string;
	readonly deliveryAttempts: number;
	readonly lastDeliveryAttemptAtMs: number | null;
}

export interface RecoveryNoticeState {
	readonly version: 1;
	readonly pending: readonly RecoveryNotice[];
	readonly delivered: readonly {
		readonly notificationId: string;
		readonly incidentId: string;
		readonly deliveredAtMs: number;
	}[];
	readonly updatedAtMs: number;
}

export function initialRecoveryNoticeState(now: Date): RecoveryNoticeState {
	return { version: 1, pending: [], delivered: [], updatedAtMs: now.getTime() };
}

/** The first-turn text required by the recovery contract. */
export function formatRecoveryNotice(notice: RecoveryNotice): string {
	if (notice.kind === "crash-rollback") {
		return [
			"检测到 Pi Worker 崩溃，已回滚到上一个已知安全快照。",
			`回滚目标: generation ${notice.lkgGeneration ?? "?"} (${notice.lkgCandidateId ?? "unknown"})`,
			`崩溃原因: ${notice.reason}`,
			`退出: code=${notice.exitCode === null ? "null" : String(notice.exitCode)} signal=${notice.signal ?? "null"}`,
			"崩溃日志如下：",
			notice.log.trim().length === 0 ? "(日志为空)" : notice.log,
		].join("\n");
	}
	if (notice.kind === "crash-no-lkg") {
		return [
			"检测到 Pi Worker 崩溃，但没有可用的 LKG 快照，未执行虚假回滚。",
			`崩溃原因: ${notice.reason}`,
			"崩溃日志如下：",
			notice.log.trim().length === 0 ? "(日志为空)" : notice.log,
		].join("\n");
	}
	if (notice.kind === "rollback-failed") {
		return [
			"检测到 Pi Worker 崩溃，但 LKG 文件恢复失败，未声称已完成回滚。",
			`崩溃原因: ${notice.reason}`,
			"诊断日志如下：",
			notice.log.trim().length === 0 ? "(日志为空)" : notice.log,
		].join("\n");
	}
	return [
		"系统多次尝试恢复失败，已停止自动重启以避免高频崩溃循环。",
		`最近原因: ${notice.reason}`,
		"诊断日志如下：",
		notice.log.trim().length === 0 ? "(日志为空)" : notice.log,
	].join("\n");
}

export interface RecoveryNoticeReadResult {
	readonly notice: RecoveryNotice | null;
	readonly recoveredFromBackup: boolean;
	readonly diagnostics: readonly string[];
}

export type WorkerRestartInfo = {
	/** Host process id owned by the launch handle. */
	readonly pid: number;
	/** Worker-reported namespace id, diagnostic only. */
	readonly reportedPid?: number;
	readonly startedAtMs: number;
	readonly generation?: number | null;
};

export interface WatchdogRecoveryPort {
	getLkg(): Promise<LkgSnapshot | null>;
	/** Atomically restore source bytes and make the LKG snapshot the active load path. */
	restoreLkg(snapshot: LkgSnapshot): Promise<void>;
	/** Notify the reload journal that the active generation is now the LKG. */
	recordRollback?(snapshot: LkgSnapshot, reason: string): Promise<void>;
	/** Relaunch Pi from the exact read-only LKG snapshot, not auto-discovery. */
	startFromSnapshot(snapshot: LkgSnapshot, reason: string): Promise<WorkerRestartInfo>;
	recoverInterruptedRestore?(): Promise<void>;
	onReloadTimeout?(input: { readonly attemptId: string; readonly reason: string }): Promise<void>;
	onUnrecoverable?(reason: string): Promise<void>;
}

export interface WatchdogProcessPort {
	killTree(pid: number, signal?: NodeJS.Signals): Promise<void>;
	isAlive(pid: number): boolean;
}

export interface WatchdogTimers {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	setInterval(handler: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

export const systemWatchdogTimers: WatchdogTimers = {
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
	setInterval: (handler, ms) => setInterval(handler, ms),
	clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};
