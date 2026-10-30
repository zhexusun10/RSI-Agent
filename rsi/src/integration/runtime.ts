import { chmod, chown, lstat, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RsiConfig } from "../shared/config.ts";
import type { RuntimeEventBus, RuntimeEventMap, RuntimeEventName } from "../shared/events.ts";
import { RsiError, asRsiError } from "../shared/errors.ts";
import { formatLogTimestamp, SystemClock, type Clock } from "../shared/time.ts";
import type { VerifiedRuntimeLayout } from "../shared/layout-verify.ts";
import type { RuntimePaths } from "../shared/paths.ts";
import { classifyHealthyTurn } from "../shared/preflight.ts";
import type { LkgSnapshot } from "../shared/plugins.ts";
import type { SandboxHandle, SandboxLauncher, SandboxPolicy } from "../shared/sandbox.ts";
import { createSandboxPolicy } from "../shared/sandbox.ts";
import { assertOperatorPiConfigUnchanged, ensureOperatorPiConfigBaseline } from "../shared/operator-config.ts";
import type { HealthTurnResult, HeartbeatReport } from "../shared/ipc/protocol.ts";
import { KnowledgeService } from "../knowledge/service.ts";
import { KnowledgeToolResultService } from "../knowledge/tool-result.ts";
import { AtomicLoopStateStore } from "../loop/state.ts";
import { NodeLoopTimer } from "../loop/timer.ts";
import { SleepScheduler } from "../loop/sleep.ts";
import {
	AutonomousLoop,
	defaultRuntimeWakeMessage,
	type LoopWorkerPort,
	type LoopWorkerRunRequest,
	type LoopWorkerRunResult,
} from "../loop/autonomous-loop.ts";
import { ImmutableCandidateStore } from "../reload/candidate-store.ts";
import { ReloadPreflight } from "../reload/preflight-runner.ts";
import { ReloadStateStore } from "../reload/state-store.ts";
import { ReloadCoordinator } from "../reload/reload-coordinator.ts";
import { ReloadSnapshotStore } from "../reload/snapshot-port.ts";
import { appendBoundedLog } from "../reload/atomic-file.ts";
import { redactStderrText, stderrRedactionValues } from "../shared/stderr-log.ts";
import type {
	PiSdkReloadPort,
	ReloadCandidate,
	ReloadObserverPort,
	SdkReloadOutcome,
	SdkReloadRequest,
} from "../reload/types.ts";
import { RecoveryNoticeStore } from "../watchdog/notifications.ts";
import { Watchdog } from "../watchdog/watchdog.ts";
import type { RecoveryNotice } from "../watchdog/types.ts";
import { formatRecoveryNotice } from "../watchdog/types.ts";
import type {
	WatchdogRecoveryPort,
	WatchdogProcessPort,
	WorkerRestartInfo,
} from "../watchdog/types.ts";
import { ControlServer } from "../control/server.ts";
import type { ControlRequestEnvelope } from "../control/protocol.ts";
import { SupervisorIpcHost } from "./ipc-transport.ts";
import { createWorkerBootstrap, encodeWorkerBootstrap } from "../shared/ipc/bootstrap.ts";
import { MappedPreflightLauncher, ReloadService } from "./reload-service.ts";
import {
	WORKER_TEST_MODE_ENV,
	WORKER_TEST_MODEL_MODULE_ENV,
} from "../worker-main.ts";
import type { SandboxExecutionRequest } from "../sandbox/types.ts";

export const SANDBOX_WORKER_IPC_ENDPOINT = "/run/rsi/worker.sock";
export const SANDBOX_CONTROL_ENDPOINT = "/run/rsi/control.sock";

export interface SupervisorRuntimeOptions {
	readonly config: RsiConfig;
	readonly verified: VerifiedRuntimeLayout;
	readonly launcher: SandboxLauncher;
	readonly policy?: SandboxPolicy;
	/** False only for explicit functional tests; production always uses bwrap. */
	readonly sandboxed: boolean;
	readonly workerMainPath?: string;
	readonly hostIpcEndpoint?: string;
	readonly workerIpcEndpoint?: string;
	readonly controlEndpoint?: string;
	readonly operatorEndpoint?: string;
	readonly healthFile?: string;
	readonly controlToken?: string;
	readonly testModelModule?: string;
	readonly testWorkerEnv?: Readonly<Record<string, string>>;
	readonly candidateHooks?: {
		readonly beforeSourceRecheck?: () => Promise<void>;
		readonly afterBackup?: () => Promise<void> | void;
		readonly afterInstall?: () => Promise<void> | void;
	};
	readonly installSignalHandlers?: boolean;
	readonly onLog?: (line: string) => void;
}

interface WorkerReadyInfo {
	/** Host bwrap/launch handle pid used for lifecycle and Watchdog identity. */
	readonly pid: number;
	/** Worker-reported PID-namespace id, diagnostic only. */
	readonly reportedPid?: number;
	readonly generation: number | null;
	readonly sessionId: string | null;
	readonly extensionPaths: readonly string[];
}

interface WorkerStatusSnapshot {
	readonly state: string;
	readonly generation: number | null;
	readonly sessionId: string | null;
}

class RuntimeBus implements RuntimeEventBus {
	private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

	emit<K extends RuntimeEventName>(event: K, payload: RuntimeEventMap[K]): void {
		for (const handler of this.handlers.get(event) ?? []) {
			try {
				handler(payload);
			} catch {
				// Observability must not break the runtime.
			}
		}
	}

	on<K extends RuntimeEventName>(event: K, handler: (payload: RuntimeEventMap[K]) => void): () => void {
		const set = this.handlers.get(event) ?? new Set<(payload: unknown) => void>();
		const wrapped = handler as (payload: unknown) => void;
		set.add(wrapped);
		this.handlers.set(event, set);
		return () => set.delete(wrapped);
	}
}

function workerMainDefault(): string {
	return fileURLToPath(new URL("../worker-main.ts", import.meta.url));
}

/** Supervisor-owned runtime wiring for the real bwrap Worker and all external state. */
export class SupervisorRuntime {
	readonly config: RsiConfig;
	readonly paths: RuntimePaths;
	readonly verified: VerifiedRuntimeLayout;
	readonly launcher: SandboxLauncher;
	readonly policy: SandboxPolicy;
	readonly sandboxed: boolean;
	readonly clock: Clock = new SystemClock();
	readonly bus = new RuntimeBus();
	readonly workerMainPath: string;
	readonly hostIpcEndpoint: string;
	readonly workerIpcEndpoint: string;
	readonly controlEndpoint: string;
	readonly operatorEndpoint: string;
	readonly healthFile: string;
	readonly controlToken: string | undefined;
	readonly testModelModule: string | undefined;
	readonly testWorkerEnv: Readonly<Record<string, string>>;
	readonly candidateHooks: SupervisorRuntimeOptions["candidateHooks"];
	readonly installSignalHandlers: boolean;
	readonly onLog: (line: string) => void;

	readonly ipc: SupervisorIpcHost;
	readonly controlServers: ControlServer[] = [];
	private knowledge: KnowledgeService | undefined;
	private decoration: KnowledgeToolResultService | undefined;
	private candidateStoreValue: ImmutableCandidateStore | undefined;
	private stateStoreValue: ReloadStateStore | undefined;
	private coordinatorValue: ReloadCoordinator | undefined;
	private snapshotStoreValue: ReloadSnapshotStore | undefined;
	private noticesValue: RecoveryNoticeStore | undefined;
	private watchdogValue: Watchdog | undefined;
	private reloadServiceValue: ReloadService | undefined;
	private sleepSchedulerValue: SleepScheduler | undefined;
	private loopValue: AutonomousLoop | undefined;
	private workerHandle: SandboxHandle | undefined;
	private workerStderrRedactions: readonly string[] = [];
	private workerGeneration: number | null = null;
	private workerSessionId: string | null = null;
	private workerState = "stopped";
	private stopping = false;
	private started = false;
	private baselineCandidateId: string | null = null;
	private supervisorAttemptId: string | null = null;
	private readyWaiters: Array<(info: WorkerReadyInfo) => void> = [];
	private lastReady: WorkerReadyInfo | null = null;
	private readyLaunchId: string | null = null;
	private healthTimer: NodeJS.Timeout | undefined;
	private shutdownPromise: Promise<void> | undefined;
	private signalHandlersInstalled = false;
	private readonly pendingLogs = new Set<Promise<void>>();
	private resourceNotice: string | null = null;
	private lastResourceFailure: string | null = null;

	constructor(options: SupervisorRuntimeOptions) {
		this.config = options.config;
		this.paths = options.config.paths;
		this.verified = options.verified;
		this.launcher = options.launcher;
		this.sandboxed = options.sandboxed;
		this.policy =
			options.policy ??
			createSandboxPolicy(this.paths, this.config.sandbox.bwrapPath, options.verified);
		this.workerMainPath = options.workerMainPath ?? workerMainDefault();
		this.hostIpcEndpoint = options.hostIpcEndpoint ?? this.paths.ipcSocketPath;
		this.workerIpcEndpoint =
			options.workerIpcEndpoint ??
			(this.sandboxed ? SANDBOX_WORKER_IPC_ENDPOINT : this.hostIpcEndpoint);
		this.controlEndpoint = options.controlEndpoint ?? join(this.paths.runDir, "control.sock");
		this.operatorEndpoint = options.operatorEndpoint ?? join(this.paths.controlDir, "operator.sock");
		this.healthFile = options.healthFile ?? join(this.paths.stateDir, "runtime", "health.json");
		this.controlToken = options.controlToken;
		this.testModelModule = options.testModelModule;
		this.testWorkerEnv = options.testWorkerEnv ?? {};
		this.candidateHooks = options.candidateHooks;
		this.installSignalHandlers = options.installSignalHandlers ?? false;
		this.onLog = options.onLog ?? ((line) => console.log(line));
		this.ipc = new SupervisorIpcHost({
			endpoint: this.hostIpcEndpoint,
			endpointRoot: this.paths.stateDir,
			maxFrameBytes: this.config.ipc.maxFrameBytes,
			requestTimeoutMs: this.config.ipc.requestTimeoutMs,
			allowTcpForTests: !this.sandboxed && this.hostIpcEndpoint.startsWith("tcp://"),
			socketGroupId: this.config.sandbox.workerGid,
			onPeer: () => {
				void this.writeHealth().catch(() => undefined);
			},
			onDiagnostic: (message) => this.log("ipc", message),
		});
	}

	get candidateStore(): ImmutableCandidateStore {
		if (this.candidateStoreValue === undefined) throw new RsiError("INTERNAL", "Runtime is not initialized.");
		return this.candidateStoreValue;
	}

	get stateStore(): ReloadStateStore {
		if (this.stateStoreValue === undefined) throw new RsiError("INTERNAL", "Runtime is not initialized.");
		return this.stateStoreValue;
	}

	get coordinator(): ReloadCoordinator {
		if (this.coordinatorValue === undefined) throw new RsiError("INTERNAL", "Runtime is not initialized.");
		return this.coordinatorValue;
	}

	get watchdog(): Watchdog {
		if (this.watchdogValue === undefined) throw new RsiError("INTERNAL", "Runtime is not initialized.");
		return this.watchdogValue;
	}

	get reloadService(): ReloadService {
		if (this.reloadServiceValue === undefined) throw new RsiError("INTERNAL", "Runtime is not initialized.");
		return this.reloadServiceValue;
	}

	get loop(): AutonomousLoop {
		if (this.loopValue === undefined) throw new RsiError("INTERNAL", "Runtime is not initialized.");
		return this.loopValue;
	}

	get knowledgeService(): KnowledgeService {
		if (this.knowledge === undefined) throw new RsiError("INTERNAL", "Runtime is not initialized.");
		return this.knowledge;
	}

	get workerPid(): number | null {
		return this.workerHandle?.pid ?? null;
	}

	get currentGeneration(): number | null {
		return this.workerGeneration;
	}

	get currentSessionId(): string | null {
		return this.workerSessionId;
	}

	log(scope: string, message: string): void {
		const line = `[rsi ${formatLogTimestamp(this.clock.now(), this.config.timeZone)}] ${scope}: ${message}`;
		this.onLog(line);
	}

	private async logFile(scope: string, message: string): Promise<void> {
		// Worker/plugin exceptions and reload diagnostics may contain environment
		// credentials. Apply the same secret redaction used for Worker stderr
		// before persisting any Supervisor log line.
		const redacted = redactStderrText(message, this.workerStderrRedactions);
		await appendBoundedLog(
			join(this.paths.logsDir, "runtime.log"),
			`${JSON.stringify({ atMs: this.clock.now().getTime(), scope, message: redacted })}\n`,
			512 * 1024,
		).catch(() => undefined);
	}

	private async ensureDirectories(): Promise<void> {
		for (const directory of [
			this.paths.pluginSourceDir,
			this.paths.stateDir,
			this.paths.snapshotDir,
			this.paths.controlDir,
			this.paths.runDir,
			this.paths.readStatsDir,
			this.paths.pluginStateDir,
			this.paths.logsDir,
			join(this.paths.stateDir, "runtime"),
			join(this.paths.stateDir, "plugins", "candidates"),
			join(this.paths.stateDir, "plugins", "lkg"),
			"/tmp/rsi-preflight",
		]) {
			await mkdir(directory, { recursive: true });
		}
		// The Worker runs under a distinct uid and bwrap must traverse /state to
		// reach its read-only snapshot and run mounts. Keep sensitive children at
		// 0700, but make the state root traverse-only and the mounted snapshot
		// roots readable/traversable. /state/run is group-owned by the Worker gid.
		await chmod(this.paths.stateDir, 0o711).catch(() => undefined);
		await chmod(this.paths.snapshotDir, 0o755).catch(() => undefined);
		await chmod(join(this.paths.snapshotDir, "candidates"), 0o755).catch(() => undefined);
		await chmod(join(this.paths.snapshotDir, "lkg"), 0o755).catch(() => undefined);
		if (this.sandboxed && process.platform === "linux" && this.config.sandbox.workerGid !== undefined) {
			await chmod(this.paths.runDir, 0o2770).catch(() => undefined);
			await chown(this.paths.runDir, 0, this.config.sandbox.workerGid).catch(() => undefined);
		}
		await this.repairPluginSourcePermissions();
		await chmod("/tmp/rsi-preflight", 0o777).catch(() => undefined);
	}

	/**
	 * Restoring an LKG replaces the source root with a freshly staged tree owned
	 * by the Supervisor. In the container the Worker has a distinct uid and must
	 * still be able to edit its own extension source; hand the tree back to the
	 * configured Worker uid/gid and keep the root writable for create/rename.
	 */
	private async repairPluginSourcePermissions(): Promise<void> {
		const root = this.paths.pluginSourceDir;
		await chmod(root, 0o777).catch(() => undefined);
		if (!this.sandboxed || process.platform === "win32") return;
		const uid = this.config.sandbox.workerUid;
		const gid = this.config.sandbox.workerGid;
		if (uid === undefined || gid === undefined) return;
		let failed = false;
		const visit = async (path: string): Promise<void> => {
			let info: Awaited<ReturnType<typeof lstat>>;
			try {
				info = await lstat(path);
			} catch {
				return;
			}
			if (info.isSymbolicLink()) return;
			try {
				await chown(path, uid, gid);
			} catch {
				failed = true;
			}
			if (info.isDirectory()) {
				await chmod(path, 0o755).catch(() => undefined);
				let names: string[] = [];
				try {
					names = await readdir(path);
				} catch {
					return;
				}
				for (const name of names) await visit(join(path, name));
			} else if (info.isFile()) {
				await chmod(path, (info.mode & 0o111) === 0 ? 0o644 : 0o755).catch(() => undefined);
			}
		};
		await visit(root);
		// The Worker creates/renames top-level extension files directly.
		await chmod(root, 0o777).catch(() => undefined);
		if (failed) this.log("plugins", `could not hand ${root} to Worker uid ${uid}:${gid}`);
	}

	private async buildServices(): Promise<void> {
		await this.ensureDirectories();
		this.knowledge = await KnowledgeService.openFromRuntimePaths(this.paths, {
			timeZone: this.config.timeZone,
			clock: this.clock,
		});
		this.decoration = new KnowledgeToolResultService({
			service: this.knowledge,
			timeZone: this.config.timeZone,
		});
		this.candidateStoreValue = new ImmutableCandidateStore({
			snapshotDir: this.paths.snapshotDir,
			forbiddenRoots: [
				this.paths.markdownsDir,
				this.paths.workspaceDir,
				this.paths.systemPromptFile,
				this.paths.stateDir,
			],
			trustedDependencyRoots: [join(this.paths.rsiSourceDir, "node_modules")],
			...(this.candidateHooks === undefined ? {} : { hooks: this.candidateHooks }),
		});
		this.stateStoreValue = new ReloadStateStore({
			stateFile: this.paths.pluginStateFile,
			clock: this.clock,
			logPath: join(this.paths.logsDir, "reload.log"),
		});
		let coordinatorRef: ReloadCoordinator | undefined;
		const preflight = new ReloadPreflight({
			candidateStore: this.candidateStoreValue,
			launcher: new MappedPreflightLauncher({
				launcher: this.launcher,
				policy: this.policy,
				snapshotDir: this.paths.snapshotDir,
				sandboxPathMapping: this.sandboxed,
			}),
			clock: this.clock,
			staticTimeoutMs: 10_000,
			mockTimeoutMs: 3_000,
			tempRoot: "/tmp/rsi-preflight",
			candidateResolver: async (candidateId) => await coordinatorRef?.resolveCandidate(candidateId) ?? null,
		});
		const observer: ReloadObserverPort = {
			beginReload: async (input) => {
				// The coordinator holds its serialization queue while this callback
				// runs. Never await the Watchdog queue here: a Worker exit makes the
				// Watchdog wait for coordinator.getLkg(), and a nested Watchdog await
				// would form a queue lock inversion.
				void this.watchdogValue?.beginReload(input).catch((error) =>
					this.log("watchdog", `beginReload failed: ${String(error)}`),
				);
				await this.loopValue?.notifyReloadStarted(`reload ${input.attemptId}`).catch((error) =>
					this.log("loop", `reload start notification failed: ${String(error)}`),
				);
			},
			completeReload: async (input) => {
				void this.watchdogValue?.completeReload(input).catch((error) =>
					this.log("watchdog", `completeReload failed: ${String(error)}`),
				);
				this.workerGeneration = input.generation;
				const status = await this.getWorkerStatus().catch(() => null);
				if (status !== null) {
					this.workerGeneration = status.generation ?? this.workerGeneration;
					this.workerSessionId = status.sessionId ?? this.workerSessionId;
				}
				await this.loopValue
					?.notifyReloadFinished(this.workerGeneration, this.workerSessionId)
					.catch((error) => this.log("loop", `reload finish notification failed: ${String(error)}`));
			},
			failReload: async (input) => {
				void this.watchdogValue?.failReload(input).catch((error) =>
					this.log("watchdog", `failReload failed: ${String(error)}`),
				);
				// A post-load rejection is followed by a Worker exit so the LKG
				// Watchdog restart clears the candidate's tools/session. Do not wait
				// for that asynchronous restart here: the Watchdog updates the loop
				// when the replacement Worker is ready.
				const status = await this.getWorkerStatus().catch(() => null);
				if (status !== null) {
					this.workerGeneration = status.generation ?? this.workerGeneration;
					this.workerSessionId = status.sessionId ?? this.workerSessionId;
				}
				const loop = this.loopValue;
				if (loop !== undefined) {
					await loop
						.notifyReloadFinished(this.workerGeneration, this.workerSessionId, {
							force: true,
							delayMs: 500,
						})
						.catch((error) =>
							this.log("loop", `reload failure notification failed: ${String(error)}`),
						);
				}
			},
			resetProbation: async () => undefined,
		};
		const sdkReload: PiSdkReloadPort = {
			reload: async (request: SdkReloadRequest): Promise<SdkReloadOutcome> =>
				await this.performSdkReload(request),
		};
		const coordinator = new ReloadCoordinator({
			candidateStore: this.candidateStoreValue,
			preflight,
			stateStore: this.stateStoreValue,
			sdkReload,
			clock: this.clock,
			events: this.bus,
			observer,
			reloadTimeoutMs: Math.max(30_000, this.config.ipc.preflightTimeoutMs + 20_000),
			onDiagnostic: (message) => this.log("reload", message),
		});
		coordinatorRef = coordinator;
		this.coordinatorValue = coordinator;
		this.snapshotStoreValue = new ReloadSnapshotStore({
			stateStore: this.stateStoreValue,
			candidateStore: this.candidateStoreValue,
			allowlist: {
				roots: [this.paths.pluginSourceDir],
				forbiddenRoots: [
					this.paths.markdownsDir,
					this.paths.workspaceDir,
					this.paths.systemPromptFile,
					this.paths.stateDir,
					this.paths.piAgentDir,
				],
			},
			clock: this.clock,
		});
		this.noticesValue = new RecoveryNoticeStore({
			path: join(this.paths.controlDir, "recovery-notices.json"),
			clock: this.clock,
		});
		this.reloadServiceValue = new ReloadService({
			paths: this.paths,
			clock: this.clock,
			coordinator,
			candidateStore: this.candidateStoreValue,
			events: this.bus,
			sandboxPathMapping: this.sandboxed,
			...(this.candidateHooks === undefined ? {} : { candidateHooks: this.candidateHooks }),
			onDiagnostic: (message) => this.log("reload", message),
		});
	}

	private async waitForReady(timeoutMs = 30_000): Promise<WorkerReadyInfo> {
		if (this.lastReady !== null) return this.lastReady;
		return await new Promise<WorkerReadyInfo>((resolveReady, reject) => {
			const timer = setTimeout(() => {
				this.readyWaiters = this.readyWaiters.filter((waiter) => waiter !== onReady);
				reject(new RsiError("IPC_TIMEOUT", "Worker did not report ready before the timeout."));
			}, timeoutMs);
			timer.unref?.();
			const onReady = (info: WorkerReadyInfo): void => {
				clearTimeout(timer);
				resolveReady(info);
			};
			this.readyWaiters.push(onReady);
		});
	}

	private resolveReady(info: WorkerReadyInfo): void {
		this.lastReady = info;
		for (const waiter of this.readyWaiters) waiter(info);
		this.readyWaiters = [];
	}

	private workerEnv(candidate: WorkerLaunchCandidate, generation: number): Record<string, string> {
		const providerKeys = [
			"RSI_MODEL",
			"RSI_PROVIDER",
			"RSI_THINKING_LEVEL",
			"CLINE_API_KEY",
			"DEEPSEEK_API_KEY",
			"OLLAMA_API_KEY",
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
			"GEMINI_API_KEY",
			"GOOGLE_GENERATIVE_AI_API_KEY",
			"XAI_API_KEY",
			"OPENROUTER_API_KEY",
			"OPENAI_BASE_URL",
			"DEEPSEEK_BASE_URL",
			"OLLAMA_HOST",
			"ANTHROPIC_BASE_URL",
			"AZURE_OPENAI_API_KEY",
			"AWS_ACCESS_KEY_ID",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_SESSION_TOKEN",
			"AWS_REGION",
			"AWS_DEFAULT_REGION",
			"AWS_PROFILE",
		] as const;
		const passthrough: Record<string, string> = {};
		for (const key of providerKeys) {
			const value = process.env[key];
			if (value !== undefined && value.length > 0) passthrough[key] = value;
		}
		const workerConfig = {
			version: this.config.version,
			timeZone: this.config.timeZone,
			paths: {
				workspaceDir: this.paths.workspaceDir,
				dataDir: this.paths.dataDir,
				stateDir: this.paths.stateDir,
				piSourceDir: this.paths.piSourceDir,
				rsiSourceDir: this.paths.rsiSourceDir,
				systemPromptFile: this.paths.systemPromptFile,
				markdownsDir: this.paths.markdownsDir,
				pluginSourceDir: this.paths.pluginSourceDir,
				hostIpcSocketPath: this.paths.ipcSocketPath,
			},
			ipc: this.config.ipc,
			sandbox: this.config.sandbox,
		};
		return {
			RSI_WORKER_CONFIG_JSON: JSON.stringify(workerConfig),
			RSI_WORKER_EXTENSION_PATHS_JSON: JSON.stringify(candidate.entryPaths ?? []),
			RSI_WORKER_GENERATION: String(generation),
			RSI_WORKER_IPC_ENDPOINT: this.workerIpcEndpoint,
			RSI_CONTROL_SOCKET: this.sandboxed ? SANDBOX_CONTROL_ENDPOINT : this.controlEndpoint,
			RSI_CONTROL_TIMEOUT_MS: String(Math.max(15_000, this.config.ipc.requestTimeoutMs)),
			RSI_PI_REAL_CLI: join(this.paths.rsiSourceDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
			PI_CODING_AGENT_DIR: this.paths.piAgentDir,
			PI_BASE_AGENT_DIR: join(this.paths.rsiSourceDir, "pi-agent-base"),
			PI_BETTER_WEB_SEARCH_CACHE: join(this.paths.piAgentDir, "better-web-search.json"),
			HOME: this.paths.workerHomeDir,
			TMPDIR: "/tmp",
			TZ: this.config.timeZone,
			NODE_ENV: "production",
			NPM_CONFIG_IGNORE_SCRIPTS: "true",
			npm_config_ignore_scripts: "true",
			NPM_CONFIG_AUDIT: "false",
			NPM_CONFIG_FUND: "false",
			NPM_CONFIG_UPDATE_NOTIFIER: "false",
			PATH: `${dirname(process.execPath)}:${join(this.paths.rsiSourceDir, "bin")}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
			...(this.controlToken === undefined ? {} : { RSI_CONTROL_TOKEN: this.controlToken }),
			...(this.testModelModule === undefined
				? {}
				: {
						[WORKER_TEST_MODE_ENV]: "1",
						[WORKER_TEST_MODEL_MODULE_ENV]: this.testModelModule,
					}),
			...this.testWorkerEnv,
			...passthrough,
		};
	}

	private async launchWorker(input: {
		readonly candidate: ReloadCandidate;
		readonly generation: number;
		readonly waitReady?: boolean;
	}): Promise<WorkerReadyInfo> {
		if (this.stopping) throw new RsiError("INTERNAL", "Supervisor is stopping.");
		// Every launch, including Watchdog recovery, revalidates the operator-owned
		// Pi config against the persisted baseline. An Agent-modified settings/
		// models/auth file cannot take effect through a Worker restart.
		await assertOperatorPiConfigUnchanged(
			this.paths.piAgentDir,
			join(this.paths.stateDir, "runtime", "operator-pi-config.json"),
		);
		this.lastReady = null;
		this.readyLaunchId = null;
		const bootstrap = createWorkerBootstrap(input.generation);
		this.ipc.expectWorker({
			launchId: bootstrap.launchId,
			token: bootstrap.token,
			generation: bootstrap.generation,
		});
		let handle: SandboxHandle | undefined;
		try {
			const view = await this.reloadService.workerView(input.candidate);
			const env = this.workerEnv(view, input.generation);
			this.workerStderrRedactions = stderrRedactionValues(env);
			const request: SandboxExecutionRequest = {
				policy: this.policy,
				// Bubblewrap executes argv directly; the local test launcher wraps the
				// entry in process.execPath itself.
				workerEntry: this.sandboxed ? process.execPath : this.workerMainPath,
				args: this.sandboxed ? [this.workerMainPath] : [],
				cwd: this.paths.workspaceDir,
				env,
				bootstrapInput: encodeWorkerBootstrap(bootstrap),
				stderrLogPath: join(this.paths.logsDir, "worker-stderr.log"),
				stderrRedactions: stderrRedactionValues(env),
			};
			this.log(
				"worker",
				`launching generation ${input.generation} launch=${bootstrap.launchId} (${this.sandboxed ? "bubblewrap" : "explicit local test launcher"}) candidate=${input.candidate.candidateId}`,
			);
			handle = await this.launcher.launch(request);
			this.workerHandle = handle;
			this.workerGeneration = input.generation;
			this.workerState = "starting";
			void handle.wait().then(async (exit) => {
				this.log("worker", `exit pid=${handle?.pid} code=${String(exit.exitCode)} signal=${String(exit.signal)}`);
				const current = this.workerHandle === handle;
				const output =
					typeof (handle as unknown as { output?: () => { stderr?: string } }).output === "function"
						? (handle as unknown as { output: () => { stderr?: string } }).output().stderr ?? ""
						: "";
				await this.watchdogValue
					?.recordWorkerExit(exit.exitCode, exit.signal, this.clock.now(), {
						pid: handle?.pid,
						stderrTail: redactStderrText(output.slice(-16_384), this.workerStderrRedactions),
					})
					.catch((error) => this.log("watchdog", `recordWorkerExit failed: ${String(error)}`));
				if (current) this.workerState = exit.exitCode === 0 ? "stopped" : "failed";
				await this.writeHealth().catch(() => undefined);
				await this.logFile("worker.exit", JSON.stringify({ pid: handle?.pid, ...exit }));
			});
			if (input.waitReady === false) {
				return {
					pid: handle.pid,
					reportedPid: undefined,
					generation: input.generation,
					sessionId: null,
					extensionPaths: [],
				};
			}
			const ready = await this.waitForReady().catch((error: unknown) => {
				const output =
					typeof (handle as unknown as { output?: () => { stderr?: string } }).output === "function"
						? (handle as unknown as { output: () => { stderr?: string } }).output().stderr ?? ""
						: "";
				throw new RsiError(
					"IPC_TIMEOUT",
					`Worker did not report ready. stderr tail:
${redactStderrText(output.slice(-16_384), this.workerStderrRedactions)}`,
					{ cause: error },
				);
			});
			if (ready.generation !== input.generation) {
				throw new RsiError(
					"RELOAD_FAILED",
					`Worker reported generation ${String(ready.generation)}, expected ${input.generation}.`,
				);
			}
			this.workerSessionId = ready.sessionId;
			this.workerState = "idle";
			// The authenticated Worker may only describe its namespace pid. The
			// Watchdog and health state always use the Supervisor's actual spawn handle.
			return { ...ready, pid: handle.pid, reportedPid: ready.reportedPid };
		} catch (error) {
			this.ipc.cancelExpectedWorker(bootstrap.launchId);
			this.ipc.revokeWorkerLaunch(bootstrap.launchId);
			if (handle !== undefined) {
				if (this.workerHandle === handle) {
					this.workerHandle = undefined;
					this.workerState = "failed";
				}
				await handle.terminate("SIGKILL").catch(() => undefined);
			}
			throw error;
		}
	}

	private async performSdkReload(request: SdkReloadRequest): Promise<SdkReloadOutcome> {
		if (this.baselineCandidateId === request.candidate.candidateId) {
			const status = await this.getWorkerStatus();
			if (status.generation !== request.generation) {
				throw new RsiError(
					"RELOAD_FAILED",
					`Baseline Worker generation ${String(status.generation)} does not match ${request.generation}.`,
				);
			}
			const loaded = new Set(
				(await this.ipc.request("worker.status", {}, { timeoutMs: 15_000 })).extensionPaths ?? [],
			);
			const expected = (await this.reloadService.workerView(request.candidate)).entryPaths ?? [];
			const missing = expected.filter((path) => !loaded.has(path));
			if (missing.length > 0) {
				throw new RsiError("RELOAD_FAILED", `Baseline Worker did not load candidate entries: ${missing.join(", ")}`);
			}
			return { generation: request.generation, digest: request.digest, loadedEntryPaths: [...loaded] };
		}
		this.supervisorAttemptId = request.attemptId;
		const view = await this.reloadService.workerView(request.candidate);
		this.log("reload", `sdk reload control.reload attempt=${request.attemptId} candidate=${request.candidate.candidateId}`);
		try {
			this.workerState = "reloading";
			const started = await this.ipc.request(
				"control.reload",
				{ preflightId: request.attemptId, candidate: view },
				{
					timeoutMs: Math.max(15_000, Math.min(request.deadlineMs - this.clock.now().getTime(), 120_000)),
				},
			);
			this.log("reload", `control.reload returned attempt=${started.attemptId}`);
			const status = await this.ipc.request("worker.status", {}, { timeoutMs: 15_000 });
			if (status.generation !== request.generation) {
				throw new RsiError(
					"CANDIDATE_CHANGED",
					`Worker loaded generation ${String(status.generation)}, expected ${request.generation} (attempt ${started.attemptId}).`,
				);
			}
			const loaded = new Set(status.extensionPaths ?? []);
			const missing = (view.entryPaths ?? []).filter((path) => !loaded.has(path));
			if (missing.length > 0) {
				throw new RsiError("RELOAD_FAILED", `Worker did not load candidate entries: ${missing.join(", ")}`);
			}
			return {
				generation: status.generation ?? request.generation,
				digest: request.digest,
				loadedEntryPaths: status.extensionPaths ?? [],
			};
		} finally {
			this.supervisorAttemptId = null;
			this.workerState = "idle";
		}
	}

	private async startFromSnapshot(snapshot: LkgSnapshot, _reason: string): Promise<WorkerRestartInfo> {
		const candidate = await this.reloadService.lkgCandidate(snapshot.path);
		const ready = await this.launchWorker({ candidate, generation: snapshot.generation });
		await this.loopValue?.updateRuntime(ready.generation, ready.sessionId).catch((error) =>
			this.log("loop", `runtime update failed: ${String(error)}`),
		);
		return {
			pid: ready.pid,
			...(ready.reportedPid === undefined ? {} : { reportedPid: ready.reportedPid }),
			startedAtMs: this.clock.now().getTime(),
			generation: snapshot.generation,
		};
	}

	private buildWatchdog(): Watchdog {
		const snapshots = this.snapshotStoreValue;
		const notices = this.noticesValue;
		if (snapshots === undefined || notices === undefined) {
			throw new RsiError("INTERNAL", "Recovery stores are not initialized.");
		}
		const recovery: WatchdogRecoveryPort = {
			getLkg: async () => await this.coordinator.getLkg(),
			restoreLkg: async (snapshot) => {
				// Enforce pinned-only policy before any recovery can restore old
				// Agent extension sources, not just before launching the Worker.
				await this.reloadService.lkgCandidate(snapshot.path);
				await snapshots.restoreLkg(snapshot);
				await this.repairPluginSourcePermissions();
			},
			recordRollback: async (snapshot, reason) => {
				await this.coordinator.markRolledBack(snapshot, reason);
			},
			startFromSnapshot: async (snapshot, reason) => await this.startFromSnapshot(snapshot, reason),
			recoverInterruptedRestore: async () => {
				await snapshots.restoreInterrupted();
				await this.repairPluginSourcePermissions();
			},
			onReloadTimeout: async (input) => {
				await this.coordinator.failWorkerReload(input.attemptId, input.reason).catch(() => undefined);
			},
			onUnrecoverable: async (reason) => {
				await this.logFile("unrecoverable", reason);
				// This callback runs while the Watchdog queue is held. Do not await
				// writeHealth(), because it reads watchdog.status() from the same queue
				// and would deadlock the final unrecoverable transition.
				void this.writeHealth().catch(() => undefined);
			},
		};
		const processTree: WatchdogProcessPort = {
			killTree: async (pid, signal = "SIGKILL") => {
				const handle = this.workerHandle;
				if (handle !== undefined && handle.pid === pid) {
					await handle.terminate(signal);
					return;
				}
				try {
					process.kill(-pid, signal);
				} catch {}
				try {
					process.kill(pid, signal);
				} catch {}
			},
			isAlive: (pid) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			},
		};
		return new Watchdog({
			stateFile: this.paths.watchdogStateFile,
			clock: this.clock,
			recovery,
			notifications: notices,
			events: this.bus,
			processTree,
			heartbeatTimeoutMs: this.config.ipc.heartbeatTimeoutMs,
			tickIntervalMs: Math.max(1_000, Math.min(5_000, this.config.ipc.heartbeatIntervalMs)),
			workerStderrPath: join(this.paths.logsDir, "worker-stderr.log"),
			logPath: join(this.paths.logsDir, "watchdog.log"),
			onDiagnostic: (message) => this.log("watchdog", message),
		});
	}

	private buildLoop(): void {
		const loopStore = new AtomicLoopStateStore({
			filePath: this.paths.sleepStateFile,
			stateDir: this.paths.stateDir,
			clock: this.clock,
		});
		let loopRef: AutonomousLoop | undefined;
		const sleep = new SleepScheduler({
			clock: this.clock,
			timeZone: this.config.timeZone,
			store: loopStore,
			timers: new NodeLoopTimer(),
			events: this.bus,
			generation: () => this.workerGeneration,
			sessionId: () => this.workerSessionId,
			onSleepEntered: async (record) => {
				await loopRef?.pauseForSleep(record);
				await this.writeHealth().catch(() => undefined);
			},
			onWake: async (notification) => {
				this.ipc.sendEvent("sleep.wake", {
					sleepId: notification.sleep.sleepId,
					atMs: notification.atMs,
				});
				await loopRef?.handleSleepWake({ sleep: notification.sleep, reason: notification.reason });
				await this.writeHealth().catch(() => undefined);
			},
			onError: (error) => this.log("sleep", asRsiError(error, "INTERNAL").message),
		});
		this.sleepSchedulerValue = sleep;
		const workerPort: LoopWorkerPort = {
			currentGeneration: () => this.workerGeneration,
			currentSessionId: () => this.workerSessionId,
			hasQueuedTasks: async () => {
				try {
					const status = await this.getWorkerStatus();
					this.workerState = status.state;
					return status.state !== "idle";
				} catch {
					return true;
				}
			},
			startRuntimeTurn: async (request: LoopWorkerRunRequest): Promise<LoopWorkerRunResult> => {
				try {
					const notice = await this.pendingRecoveryNotice();
					const resourceNotice = this.resourceNotice;
					const message = [
						...(notice === null ? [] : [formatRecoveryNotice(notice)]),
						...(resourceNotice === null ? [] : [resourceNotice]),
						request.message,
					].join("\n\n");
					const result = await this.ipc.request(
						"runtime.turn",
						{
							continuationId: request.continuationId,
							kind: request.kind,
							message,
							...(notice === null ? {} : { noticeId: notice.notificationId }),
						},
						{ timeoutMs: 15_000 },
					);
					if (result.accepted) {
						this.workerState = "busy";
						if (this.resourceNotice === resourceNotice) this.resourceNotice = null;
					}
					return result;
				} catch (error) {
					return { accepted: false, detail: error instanceof Error ? error.message : String(error) };
				}
			},
			abortActiveRun: async (reason) => {
				await this.ipc.request("worker.abort", { reason }, { timeoutMs: 5_000 }).catch(() => undefined);
			},
		};
		const loop = new AutonomousLoop({
			clock: this.clock,
			timeZone: this.config.timeZone,
			store: loopStore,
			timers: new NodeLoopTimer(),
			worker: workerPort,
			sleep,
			sleepScheduler: sleep,
			baseBackoffMs: 5_000,
			maxBackoffMs: 300_000,
			wakeMessage: (input) => defaultRuntimeWakeMessage(input),
			onError: (error) => this.log("loop", asRsiError(error, "INTERNAL").message),
		});
		loopRef = loop;
		this.loopValue = loop;
	}

	private async pendingRecoveryNotice(): Promise<RecoveryNotice | null> {
		const result = await this.noticesValue?.nextForFirstTurn();
		return result?.notice ?? null;
	}

	private async waitForWorkerIdle(timeoutMs = 15_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const status = await this.getWorkerStatus().catch(() => null);
			if (status?.state === "idle") return true;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
		}
		return false;
	}

	private async getWorkerStatus(): Promise<WorkerStatusSnapshot> {
		const status = await this.ipc.request("worker.status", {}, { timeoutMs: 5_000 });
		return {
			state: status.state,
			generation: status.generation,
			sessionId: status.sessionId ?? null,
		};
	}

	private async writeHealth(): Promise<void> {
		const plugin = await this.coordinator.currentState().catch(() => null);
		let workerStatus: { state: string; pid: number | null; generation: number | null } = {
			state: this.workerState,
			pid: this.workerHandle?.pid ?? null,
			generation: this.workerGeneration,
		};
		if (this.ipc.connected && this.workerState !== "stopped" && this.workerState !== "failed") {
			try {
				const status = await this.getWorkerStatus();
				this.workerState = status.state;
				this.workerSessionId = status.sessionId;
				workerStatus = {
					state: status.state,
					pid: this.workerHandle?.pid ?? null,
					generation: status.generation,
				};
			} catch {
				// Keep the last known state; the Watchdog owns liveness.
			}
		}
		const sleep = await this.sleepSchedulerValue?.status().catch(() => null);
		const watchdog = await this.watchdogValue?.status().catch(() => null);
		if (sleep?.status === "active") {
			workerStatus = { ...workerStatus, state: "sleeping" };
		} else if (workerStatus.state === "idle" || workerStatus.state === "busy") {
			workerStatus = { ...workerStatus, state: "healthy" };
		} else if (workerStatus.state === "reloading") {
			workerStatus = { ...workerStatus, state: "starting" };
		} else if (workerStatus.state === "stopping") {
			workerStatus = { ...workerStatus, state: "stopped" };
		}
		const health = {
			version: 1,
			updatedAtMs: this.clock.now().getTime(),
			supervisor: { pid: process.pid, state: this.stopping ? "stopping" : this.started ? "running" : "starting" },
			worker: { pid: workerStatus.pid, state: workerStatus.state, generation: workerStatus.generation },
			sleep: {
				active: sleep?.status === "active",
				deadlineMs: sleep?.status === "active" ? sleep.deadlineMs : null,
			},
			plugin: {
				generation: plugin?.active?.generation ?? null,
				healthTurns: plugin?.health?.healthyTurns ?? 0,
				lkgGeneration: plugin?.lkg?.generation ?? null,
			},
			watchdog: { phase: watchdog?.phase ?? "idle" },
		};
		await mkdir(dirname(this.healthFile), { recursive: true, mode: 0o700 });
		const temp = `${this.healthFile}.${randomUUID()}.tmp`;
		await writeFile(temp, `${JSON.stringify(health, null, 2)}\n`, { mode: 0o600 });
		await rename(temp, this.healthFile);
	}

	/**
	 * Tie a Worker message to the authenticated launch generation and the current
	 * session. A new generation is accepted only while that exact reload is in
	 * progress; a stale/old generation or session cannot roll state backwards.
	 */
	private async validateWorkerMessageIdentity(input: {
		readonly generation: number | null;
		readonly sessionId?: string | null;
	}): Promise<{ readonly generation: number | null; readonly reloading: boolean }> {
		const current = this.workerGeneration;
		let reloading = false;
		if (input.generation !== null && input.generation !== current) {
			const state = await this.coordinator.currentState().catch(() => null);
			const target = state?.reloading?.generation ?? null;
			if (target === null || input.generation !== target) {
				throw new RsiError(
					"IPC_AUTH_FAILED",
					`Worker generation ${input.generation} does not match the authenticated launch generation ${String(current)}.`,
				);
			}
			reloading = true;
		}
		const sessionId = input.sessionId;
		if (
			sessionId !== undefined &&
			sessionId !== null &&
			this.workerSessionId !== null &&
			sessionId !== this.workerSessionId
		) {
			if (!reloading) {
				const state = await this.coordinator.currentState().catch(() => null);
				if (state?.reloading === null || state?.reloading === undefined) {
					throw new RsiError(
						"IPC_AUTH_FAILED",
						"Worker session does not match the authenticated Worker process.",
					);
				}
				reloading = true;
			}
		}
		return { generation: input.generation ?? current, reloading };
	}

	private registerIpcHandlers(): void {
		this.ipc.handle("memory.current", async () => await this.knowledgeService.readCurrentMemory());
		this.ipc.handle("docs.list", async () => await this.knowledgeService.list());
		this.ipc.handle("docs.read", async (payload) => await this.knowledgeService.read(payload.name));
		this.ipc.handle("docs.readView", async (payload) =>
			await this.knowledgeService.readForTool(payload.name, new Date(payload.atMs)),
		);
		this.ipc.handle("docs.commit", async (payload) => await this.knowledgeService.commit(payload));
		this.ipc.handle("docs.indexReport", async (payload) =>
			await this.knowledgeService.indexReport(new Date(payload.nowMs ?? this.clock.now().getTime())),
		);
		this.ipc.handle("docs.consistency", async () => await this.knowledgeService.consistency());
		this.ipc.handle("reads.record", async (payload) => {
			const readsLast24h = await this.knowledgeService.recordRead(payload.name, new Date(payload.atMs));
			return { recorded: true as const, readsLast24h };
		});
		this.ipc.handle("tools.decorateResult", async (payload, context) => {
			if (this.decoration === undefined) throw new RsiError("INTERNAL", "Decoration service is not initialized.");
			return await this.decoration.decorate(payload, this.clock.now(), context.signal);
		});
		this.ipc.handle("sleep.request", async (payload) => {
			if (this.sleepSchedulerValue === undefined) throw new RsiError("INTERNAL", "Sleep scheduler is not initialized.");
			const now = this.clock.now();
			return await this.sleepSchedulerValue.request(
				{
					...(payload.duration === undefined ? {} : { duration: payload.duration }),
					...(payload.until === undefined ? {} : { until: payload.until }),
				},
				now,
				payload.toolCallId,
			);
		});
		this.ipc.handle("sleep.status", async () => await this.sleepSchedulerValue?.status() ?? null);
		this.ipc.handle("health.turn", async (payload) => {
			await this.validateWorkerMessageIdentity({
				generation: payload.generation,
				sessionId: payload.sessionId,
			});
			const outcome = await this.coordinator.recordHealthTurn(payload);
			const lkg = await this.coordinator.getLkg();
			const healthy = classifyHealthyTurn(payload);
			return {
				consecutiveHealthyTurns: outcome.count,
				required: outcome.required,
				promoted: outcome.promoted,
				lkgGeneration: outcome.promoted ? lkg?.generation ?? null : null,
				failed: !healthy,
			} satisfies HealthTurnResult;
		});
		this.ipc.handle("heartbeat", async (payload: HeartbeatReport) => {
			const identity = await this.validateWorkerMessageIdentity({
				generation: payload.generation,
				sessionId: payload.sessionId,
			});
			const hostPid = this.workerHandle?.pid;
			if (hostPid === undefined) {
				throw new RsiError("IPC_CLOSED", "The authenticated Worker has no live Supervisor launch handle.");
			}
			// Heartbeat payload pid is a namespace-local value. Never let it replace
			// the host bwrap/launch pid used by the Watchdog.
			const report: HeartbeatReport = {
				...payload,
				workerPid: hostPid,
				generation: identity.generation,
				sessionId: payload.sessionId ?? this.workerSessionId,
			};
			await this.watchdog.recordHeartbeat(report, this.clock.now());
			this.workerState = report.state;
			this.workerGeneration = report.generation ?? this.workerGeneration;
			this.workerSessionId = report.sessionId ?? this.workerSessionId;
			return {
				accepted: true as const,
				serverTimeMs: this.clock.now().getTime(),
				leaseExpiresAtMs:
					report.state === "sleeping"
						? 0
						: this.clock.now().getTime() + this.config.ipc.heartbeatTimeoutMs,
				directive: "none" as const,
			};
		});
		// Do not call coordinator.resolveCandidate() here: during a Supervisor-
		// initiated reload the coordinator queue is awaiting the Worker's
		// control.reload, so an enqueued resolution would deadlock.
		this.ipc.handle("reload.preflight", async (payload) => {
			this.log("reload", `worker preflight candidate=${payload.candidateId ?? "new"}`);
			const report = await this.reloadService.preflightForWorker(payload.candidateId);
			this.log("reload", `worker preflight complete candidate=${report.candidateId}`);
			return report;
		});
		this.ipc.handle("reload.started", async (payload) => {
			this.log("reload", `worker reload.started candidate=${payload.candidateId}`);
			if (this.supervisorAttemptId !== null) {
				return { attemptId: this.supervisorAttemptId, requiredHealthTurns: 3 };
			}
			return await this.reloadService.beginWorkerReload(payload.candidateId, "worker reload");
		});
		this.ipc.handle("reload.failed", async (payload) => {
			await this.reloadService.failWorkerReload(payload.attemptId, payload.reason);
			return { recorded: true as const };
		});
		this.ipc.handle("control.request", async (payload) => ({
			ok: false,
			error: `${payload.command} is reserved for the trusted external Supervisor.`,
			code: "AGENT_COMMAND_FORBIDDEN",
		}));
		this.ipc.onEvent("worker.ready", (payload) => {
			void this.handleWorkerReady(payload).catch((error) =>
				this.log("ipc", `worker.ready rejected: ${asRsiError(error).message}`),
			);
		});
		this.ipc.onEvent("agent.settled", (payload) => {
			void this.handleAgentSettled(payload).catch((error) =>
				this.log("ipc", `agent.settled rejected: ${asRsiError(error).message}`),
			);
		});
		this.ipc.onEvent("agent.end", (payload) => {
			void this.logFile("agent.end", JSON.stringify(payload));
		});
		this.ipc.onEvent("worker.exception", (payload) => {
			void this.logFile("worker.exception", JSON.stringify(payload));
		});
		this.ipc.onEvent("worker.stopping", (payload) => {
			void this.logFile("worker.stopping", JSON.stringify(payload));
		});
		this.ipc.onEvent("sleep.entered", (payload) => {
			this.workerState = "sleeping";
			void this.writeHealth().catch(() => undefined);
			void this.logFile("sleep.entered", JSON.stringify(payload));
		});
		this.ipc.onEvent("sleep.woke", (payload) => {
			this.workerState = "idle";
			void this.writeHealth().catch(() => undefined);
			void this.logFile("sleep.woke", JSON.stringify(payload));
		});
		this.ipc.onEvent("reload.completed", (payload) => {
			void this.handleReloadCompleted(payload).catch((error) =>
				this.log("reload", `reload.completed rejected: ${asRsiError(error).message}`),
			);
		});
		this.ipc.onEvent("recovery.noticeDelivered", (payload) => {
			void this.noticesValue
				?.acknowledge(payload.notificationId)
				.catch((error) => this.log("recovery", `notice acknowledgement failed: ${String(error)}`));
		});
	}

	private async handleWorkerReady(payload: {
		readonly pid: number;
		readonly generation: number | null;
		readonly sessionId?: string | null;
		readonly extensionPaths?: readonly string[];
	}): Promise<void> {
		const identity = this.ipc.currentIdentity;
		if (identity === null) {
			this.log("ipc", "ignored worker.ready without an authenticated Worker connection");
			return;
		}
		if (payload.generation !== identity.generation) {
			this.log(
				"ipc",
				`rejected worker.ready generation ${String(payload.generation)} for authenticated launch generation ${String(identity.generation)}`,
			);
			this.ipc.revokeWorkerLaunch(identity.launchId);
			return;
		}
		if (this.readyLaunchId === identity.launchId) {
			this.log("ipc", "ignored duplicate worker.ready for the authenticated launch");
			return;
		}
		const hostPid = this.workerHandle?.pid;
		if (hostPid === undefined) {
			this.log("ipc", "ignored worker.ready without a live Supervisor launch handle");
			return;
		}
		const info: WorkerReadyInfo = {
			pid: hostPid,
			reportedPid: payload.pid,
			generation: identity.generation,
			sessionId: payload.sessionId ?? null,
			extensionPaths: payload.extensionPaths ?? [],
		};
		this.readyLaunchId = identity.launchId;
		this.workerState = "idle";
		this.workerGeneration = info.generation;
		this.workerSessionId = info.sessionId;
		// Release the launch/restart waiter before enqueueing Watchdog state.
		// attemptRestart holds the Watchdog queue while it awaits waitForReady;
		// awaiting recordWorkerStarted first would deadlock that queue for the
		// full readiness timeout.
		this.resolveReady(info);
		await this.watchdog.recordWorkerStarted({
			// pid is the host launch handle; the Worker's namespace id is only
			// retained for diagnostics and never used for kill/exit correlation.
			pid: info.reportedPid ?? info.pid,
			hostPid: info.pid,
			startedAtMs: this.clock.now().getTime(),
			generation: info.generation,
		});
		await this.loopValue?.updateRuntime(info.generation, info.sessionId).catch((error) =>
			this.log("loop", `runtime update failed: ${String(error)}`),
		);
		await this.writeHealth().catch(() => undefined);
	}

	private async handleAgentSettled(payload: {
		readonly runId: string;
		readonly generation: number | null;
		readonly sessionId: string | null;
		readonly aborted: boolean;
		readonly stopReason: string;
		readonly assistantMessages: number;
		readonly atMs: number;
	}): Promise<void> {
		const identity = await this.validateWorkerMessageIdentity({
			generation: payload.generation,
			sessionId: payload.sessionId,
		});
		this.workerState = "idle";
		if (payload.generation !== null) this.workerGeneration = identity.generation;
		if (payload.sessionId !== null) this.workerSessionId = payload.sessionId;
		const deferred = this.reloadService.hasDeferredReload;
		if (deferred) {
			this.log("reload", "deferred reload waiting for the final agent_settled run to become idle");
			await this.waitForWorkerIdle();
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
			this.log("reload", "deferred reload starting");
			await this.reloadService.flushDeferredReload(true);
			this.log("reload", "deferred reload finished");
			const status = await this.getWorkerStatus().catch((error) => {
				this.log("reload", `post-reload status failed: ${String(error)}`);
				return null;
			});
			this.log(
				"reload",
				`post-reload status=${status?.state ?? "null"} gen=${String(status?.generation ?? null)} session=${status?.sessionId ?? "null"}`,
			);
			if (status !== null) {
				this.workerGeneration = status.generation;
				this.workerSessionId = status.sessionId;
			}
		} else if (await this.waitForWorkerIdle()) {
			// Skill files and MCP configuration are model-writable. Discover them
			// in the sandboxed Worker, then refresh only after the turn settles;
			// the model never needs an active-session /reload command.
			try {
				const preview = await this.ipc.request("worker.previewResources", {}, { timeoutMs: 30_000 });
				if (preview.changed) {
					const result = await this.reloadService.requestSupervisorReload({
						reason: "automatic Skill/MCP refresh",
						source: "operation",
					});
					if (!result.ok) throw new RsiError("RELOAD_FAILED", result.error ?? "Resource refresh failed.");
					this.resourceNotice = "Skill/MCP configuration was reloaded after the previous turn; MCP servers may still fail to connect.";
				}
				this.lastResourceFailure = null;
			} catch (error) {
				const failure = asRsiError(error, "RELOAD_FAILED");
				this.log("resources", `automatic refresh rejected: ${failure.message}`);
				if (this.lastResourceFailure !== failure.message) {
					this.resourceNotice = `Skill/MCP refresh failed; the previous session remains active if recovery succeeds. ${failure.message}`;
					this.lastResourceFailure = failure.message;
				}
			}
		}
		await this.loopValue?.handleWorkerEvent({
			type: "agent_settled",
			runId: payload.runId,
			generation: payload.generation,
			sessionId: payload.sessionId,
			aborted: payload.aborted,
			stopReason: payload.stopReason,
			queuedTasks: false,
			atMs: payload.atMs,
		}).catch((error) => this.log("loop", `settled event failed: ${String(error)}`));
		await this.writeHealth().catch(() => undefined);
	}

	private async handleReloadCompleted(payload: {
		readonly attemptId: string;
		readonly generation: number;
		readonly atMs: number;
	}): Promise<void> {
		if (this.supervisorAttemptId !== null) return;
		const state = await this.coordinator.currentState().catch(() => null);
		const reloading = state?.reloading;
		if (reloading === null || reloading === undefined || reloading.attemptId !== payload.attemptId) return;
		try {
			await this.reloadService.completeWorkerReload(
				payload.attemptId,
				payload.generation,
				reloading.digest,
			);
		} catch (error) {
			await this.reloadService.failWorkerReload(payload.attemptId, asRsiError(error, "RELOAD_FAILED").message);
		}
	}

	private buildControlServers(): void {
		const workerControl = new ControlServer({
			endpoint: this.controlEndpoint,
			endpointRoot: this.paths.stateDir,
			...(this.controlToken === undefined ? {} : { token: this.controlToken }),
			currentGeneration: () => this.workerGeneration,
			currentSessionId: () => this.workerSessionId,
			dispatch: async (_request: ControlRequestEnvelope) => {
				throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Active-session control is reserved for the trusted Supervisor.");
			},
		});
		const operatorControl = new ControlServer({
			endpoint: this.operatorEndpoint,
			endpointRoot: this.paths.stateDir,
			...(this.controlToken === undefined ? {} : { token: this.controlToken }),
			currentGeneration: () => this.workerGeneration,
			dispatch: async (request: ControlRequestEnvelope) => {
				if (request.source !== "supervisor") {
					throw new RsiError("AGENT_COMMAND_FORBIDDEN", "The operator socket accepts only trusted Supervisor requests.");
				}
				switch (request.command.kind) {
					case "reload": {
						const detail = await this.reloadService.requestDeferredReload({
							reason: request.command.reason,
							...(request.command.candidateId === undefined ? {} : { candidateId: request.command.candidateId }),
						});
						void this.reloadService.flushDeferredReload(
							(await this.getWorkerStatus().catch(() => ({ state: "busy" }))).state === "idle",
						);
						return { detail, generation: this.workerGeneration };
					}
					case "shutdown": {
						const detail = "Shutdown accepted by the trusted Supervisor.";
						setImmediate(() => {
							void this.stop(request.command.reason);
						});
						return { detail, generation: this.workerGeneration };
					}
					case "cancelSleep": {
						const cancelled = await this.sleepSchedulerValue?.cancel(
							request.command.reason,
							this.clock.now(),
						) ?? false;
						if (cancelled) {
							await this.ipc
								.request("control.cancelSleep", { reason: request.command.reason }, { timeoutMs: 5_000 })
								.catch(() => undefined);
						}
						return {
							detail: cancelled
								? "Active explicit sleep cancelled."
								: "No active explicit sleep to cancel.",
							generation: this.workerGeneration,
						};
					}
				}
			},
		});
		this.controlServers.push(workerControl, operatorControl);
	}

	private installSignals(): void {
		if (!this.installSignalHandlers || this.signalHandlersInstalled) return;
		this.signalHandlersInstalled = true;
		const stop = (signal: string): void => {
			void this.stop(signal).finally(() => process.exit(0));
		};
		process.on("SIGTERM", () => stop("SIGTERM"));
		process.on("SIGINT", () => stop("SIGINT"));
		process.on("uncaughtException", (error) => {
			this.log("fatal", error.stack ?? error.message);
			void this.stop("uncaughtException").finally(() => process.exit(70));
		});
		process.on("unhandledRejection", (reason) => {
			const error = asRsiError(reason, "INTERNAL");
			this.log("fatal", error.stack ?? error.message);
			void this.stop("unhandledRejection").finally(() => process.exit(70));
		});
	}

	async start(): Promise<void> {
		if (this.started) return;
		await this.buildServices();
		await ensureOperatorPiConfigBaseline(
			this.paths.piAgentDir,
			join(this.paths.stateDir, "runtime", "operator-pi-config.json"),
		);
		this.watchdogValue = this.buildWatchdog();
		this.buildLoop();
		this.registerIpcHandlers();
		this.buildControlServers();
		await this.ipc.listen();
		for (const server of this.controlServers) await server.listen();
		if (this.sandboxed && process.platform !== "win32") {
			// The Worker shim connects from the distinct Worker uid. The operator
			// socket stays under root-only /state/control.
			try {
				const { chmod, chown } = await import("node:fs/promises");
				await chmod(this.controlEndpoint, 0o660);
				await chown(this.controlEndpoint, process.getuid?.() ?? 0, this.config.sandbox.workerGid ?? 0);
			} catch (error) {
				this.log("control", `could not set Worker control socket permissions: ${String(error)}`);
			}
		}
		this.installSignals();
		this.watchdog.start();
		await this.watchdog.ready();
		// A process restart is not a Worker crash. Discard any previous in-memory
		// recovery timer before intentionally launching the new Worker; the reload
		// journal/LKG are still used below.
		await this.watchdog.markOperatorStop("supervisor restart").catch(() => undefined);

		const lkg = await this.coordinator.getLkg();
		let candidate: ReloadCandidate;
		if (lkg !== null) {
			// Reject legacy extension snapshots before they can restore files or be
			// projected into a Worker under the pinned-only extension policy.
			candidate = await this.reloadService.lkgCandidate(lkg.path);
			await this.snapshotStoreValue?.restoreLkg(lkg);
			await this.repairPluginSourcePermissions();
			await this.coordinator.markRolledBack(lkg, "supervisor restart uses the last known good snapshot");
			this.baselineCandidateId = null;
		} else {
			const prior = await this.coordinator.currentState();
			if (prior.active !== null) {
				throw new RsiError(
					"RELOAD_FAILED",
					"An active plugin generation exists without an LKG; refusing to start from untrusted state.",
				);
			}
			candidate = await this.reloadService.prepareCandidate({ allowEmpty: true });
			const report = await this.reloadService.validate(candidate);
			if (!report.ok) {
				throw new RsiError("PREFLIGHT_FAILED", `Initial plugin preflight failed: ${[
					...report.staticSyntaxCheck.errors,
					...report.mockLoad.errors,
				].join("\n")}`);
			}
			this.baselineCandidateId = candidate.candidateId;
		}
		const ready = await this.launchWorker({ candidate, generation: candidate.generation });
		this.workerSessionId = ready.sessionId;
		if (this.baselineCandidateId !== null) {
			const baseline = await this.coordinator.initializeBaseline(candidate);
			if (!baseline.ok) {
				throw new RsiError("RELOAD_FAILED", `Initial plugin baseline failed: ${baseline.error ?? "unknown"}`);
			}
			this.baselineCandidateId = null;
		}
		await this.loop.updateRuntime(ready.generation, ready.sessionId);
		await this.loop.start();
		this.started = true;
		this.healthTimer = setInterval(() => {
			void this.writeHealth().catch(() => undefined);
		}, 5_000);
		this.healthTimer.unref?.();
		await this.writeHealth();
		this.log("runtime", "Supervisor started; Worker is the only plugin-loading process.");
	}

	async stop(reason = "operator shutdown"): Promise<void> {
		if (this.shutdownPromise !== undefined) return this.shutdownPromise;
		this.shutdownPromise = (async () => {
			this.stopping = true;
			if (this.healthTimer !== undefined) clearInterval(this.healthTimer);
			this.healthTimer = undefined;
			for (const server of this.controlServers) {
				await server.close().catch(() => undefined);
			}
			await this.watchdogValue?.markOperatorStop(reason).catch(() => undefined);
			await this.loopValue?.stop(reason).catch(() => undefined);
			const handle = this.workerHandle;
			if (handle !== undefined) {
				await this.ipc.request("control.shutdown", { reason }, { timeoutMs: 3_000 }).catch(() => undefined);
				const exited = await Promise.race([
					handle.wait().then(() => true),
					new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 3_000)),
				]);
				if (!exited) await handle.terminate("SIGTERM").catch(() => undefined);
				await Promise.race([
					handle.wait(),
					new Promise<void>((resolveWait) => setTimeout(resolveWait, 3_000)),
				]);
				await handle.terminate("SIGKILL").catch(() => undefined);
			}
			await this.watchdogValue?.stop().catch(() => undefined);
			await this.ipc.close().catch(() => undefined);
			this.workerState = "stopped";
			await Promise.race([
				Promise.all([...this.pendingLogs]).then(() => undefined),
				new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000)),
			]);
			await this.writeHealth().catch(() => undefined);
			this.started = false;
			this.log("runtime", `stopped: ${reason}`);
		})();
		return this.shutdownPromise;
	}

	async status(): Promise<import("../shared/ipc/protocol.ts").WorkerStatus> {
		return await this.ipc.request("worker.status", {}, { timeoutMs: 5_000 });
	}
}

interface WorkerLaunchCandidate {
	readonly candidateId: string;
	readonly entryPaths?: readonly string[];
}
