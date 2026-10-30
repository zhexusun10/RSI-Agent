import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createCodemodeExtension,
	createToolSearchExtension,
	type ExtensionError,
	type InlineExtension,
	type ResourceLoader,
	SessionManager,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { RsiError, asRsiError } from "../shared/errors.ts";
import { formatPreflightToolError } from "../reload/preflight-runner.ts";
import type { ContentRevision } from "../shared/hash.ts";
import type { HealthTurnObservation, PreflightReport } from "../shared/preflight.ts";
import type {
	ReloadStartResult,
	WorkerStatus,
	WorkerToSupervisorEvents,
} from "../shared/ipc/protocol.ts";
import { assertAgentPromptAllowed, MAX_MCP_SERVERS } from "../shared/policy.ts";
import { REQUIRED_PLUGIN_PINS, resolveInstalledPluginExtension } from "../shared/plugins.ts";
import { SystemClock, type Clock } from "../shared/time.ts";
import { SessionControlGuard } from "./control-guard.ts";
import { ManagedToolRuntime } from "./managed-tools.ts";
import {
	createMcpCapState,
	createNativeMcpExtensionFactory,
	installMcpRegistrationCap,
	type McpCapState,
} from "./mcp-cap.ts";
import { RequestContextAdapter } from "./request-context.ts";
import { RestrictedResourceLoader } from "./resource-loader.ts";
import { createRsiExtension } from "./rsi-extension.ts";
import { SleepController } from "./sleep.ts";
import { ToolResultFinalizer } from "./tool-result-finalizer.ts";
import type {
	PiWorkerOptions,
	PiWorkerServices,
	WorkerEventSink,
	WorkerTelemetryEvent,
	WorkerTelemetryPort,
} from "./worker-types.ts";

export interface PiWorker {
	readonly session: AgentSession;
	readonly resourceLoader: RestrictedResourceLoader;
	readonly managedTools: ManagedToolRuntime;
	readonly sleep: SleepController;
	readonly generation: number | null;
	readonly nestedToolResults: readonly ToolResultEvent[];
	run(prompt: string, signal?: AbortSignal, options?: { readonly runId?: string }): Promise<void>;
	requestReload(options?: {
		readonly candidateId?: string;
		readonly approvedExtensionPaths?: readonly string[];
		readonly beforeSessionStart?: () => void | Promise<void>;
	}): Promise<{ readonly report: PreflightReport; readonly started: ReloadStartResult }>;
	cancelSleep(reason: string): Promise<boolean>;
	status(): WorkerStatus;
	previewResources(): Promise<{ readonly changed: boolean; readonly skillsChanged: boolean; readonly mcpChanged: boolean }>;
	stop(reason: string): Promise<void>;
	replaceSession(session: AgentSession, options?: { bind?: boolean }): Promise<void>;
}

class EventRelay implements WorkerEventSink {
	private target: WorkerEventSink | undefined;

	setTarget(target: WorkerEventSink | undefined): void {
		this.target = target;
	}

	sendEvent<E extends keyof WorkerToSupervisorEvents>(
		event: E,
		payload: WorkerToSupervisorEvents[E],
	): void {
		this.target?.sendEvent(event, payload);
	}
}

class NoopTelemetry implements WorkerTelemetryPort {
	emit(_event: WorkerTelemetryEvent): void {}
}

class PiWorkerImpl implements PiWorker {
	readonly resourceLoader: RestrictedResourceLoader;
	readonly managedTools: ManagedToolRuntime;
	readonly sleep: SleepController;
	private readonly options: PiWorkerOptions;
	private readonly services: PiWorkerServices;
	private readonly clock: Clock;
	private readonly eventRelay: EventRelay;
	private readonly telemetry: WorkerTelemetryPort;
	private readonly requestContext: RequestContextAdapter;
	private readonly guard: SessionControlGuard;
	private readonly mcpCap: McpCapState;
	private readonly requiredPluginPaths: readonly string[];
	private readonly nestedResults: ToolResultEvent[] = [];
	private sessionValue: AgentSession;
	private unsubscribe: (() => void) | undefined;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private heartbeatSequence = 0;
	private heartbeatBusy = false;
	private running = false;
	private reloading = false;
	private stopping = false;
	private assistantMessages = 0;
	private lastAssistantStopReason: string | undefined;
	private lastAgentEndAt: number | undefined;
	private settlementIndex = 0;
	private healthTurns = 0;
	private memoryRevision: ContentRevision | null = null;
	private observingAttemptId: string | undefined;
	private approvedPaths: string[];
	private generationValue: number | null;
	private runSettled = false;
	private currentRunId: string | undefined;
	private readonly diagnostics: string[] = [];
	private loadedMcpFingerprint = "";

	constructor(input: {
		options: PiWorkerOptions;
		services: PiWorkerServices;
		resourceLoader: RestrictedResourceLoader;
		managedTools: ManagedToolRuntime;
		sleep: SleepController;
		session: AgentSession;
		mcpCap: McpCapState;
		requiredPluginPaths: readonly string[];
		approvedPaths: readonly string[];
		telemetry: WorkerTelemetryPort;
		guard: SessionControlGuard;
		eventRelay: EventRelay;
		requestContext: RequestContextAdapter;
	}) {
		this.options = input.options;
		this.services = input.services;
		this.resourceLoader = input.resourceLoader;
		this.managedTools = input.managedTools;
		this.sleep = input.sleep;
		this.sessionValue = input.session;
		this.mcpCap = input.mcpCap;
		this.requiredPluginPaths = input.requiredPluginPaths;
		this.approvedPaths = [...input.approvedPaths];
		this.clock = new SystemClock();
		this.generationValue = input.options.generation ?? null;
		this.telemetry = input.telemetry;
		this.guard = input.guard;
		this.eventRelay = input.eventRelay;
		this.requestContext = input.requestContext;
		this.eventRelay.setTarget(input.options.events);
	}

	get session(): AgentSession {
		return this.sessionValue;
	}

	get generation(): number | null {
		return this.generationValue;
	}

	get nestedToolResults(): readonly ToolResultEvent[] {
		return this.nestedResults;
	}

	setMemoryRevision(revision: ContentRevision): void {
		this.memoryRevision = revision;
	}

	recordNestedResult(event: ToolResultEvent): void {
		this.nestedResults.push(event);
		if (this.nestedResults.length > 200) this.nestedResults.shift();
	}

	async initialize(): Promise<void> {
		this.guard.install(this.sessionValue);
		await this.sleep.restorePersistedState().catch((error) => {
			this.reportException("sleep", error);
		});
		await this.bindCurrentSession();
		this.loadedMcpFingerprint = await this.mcpFingerprint();
		this.assertCandidateProviderHooks();
		this.subscribe(this.sessionValue);
		this.eventRelay.sendEvent("worker.ready", {
			pid: process.pid,
			generation: this.generationValue,
			startedAtMs: this.clock.now().getTime(),
			sessionId: this.sessionId(),
			extensionPaths: this.resourceLoader
				.getExtensions()
				.extensions.filter((entry) => !entry.path.startsWith("<") && !entry.path.startsWith("builtin:"))
				.map((entry) => entry.resolvedPath),
			skillCount: this.resourceLoader.getSkills().skills.length,
			mcpServerCount: Math.max(
				this.mcpCap.configuredNames.size,
				this.resourceLoader.getExtensions().runtime.mcpServers.list().length,
			),
		});
		this.startHeartbeat();
	}

	private bindings() {
		return {
			mode: "print" as const,
			commandContextActions: this.guard.commandContextActions(),
			shutdownHandler: this.guard.shutdownHandler(),
			onError: (error: ExtensionError) =>
				this.reportException("extension", `${error.extensionPath}: ${error.error}`),
		};
	}

	private assertCandidateProviderHooks(): void {
		for (const extension of this.resourceLoader.getExtensions().extensions) {
			if (extension.path.startsWith("<") || extension.path.startsWith("builtin:")) continue;
			if (this.requiredPluginPaths.some((path) => resolve(path) === resolve(extension.resolvedPath))) continue;
			for (const hook of ["before_provider_request", "context_with_system"] as const) {
				if ((extension.handlers.get(hook) ?? []).length > 0) {
					throw new RsiError(
						"PLUGIN_MANIFEST_MISMATCH",
						`Candidate extension ${extension.path} registers ${hook}; provider/system mutation is not allowed.`,
					);
				}
			}
		}
	}

	private async bindCurrentSession(): Promise<void> {
		const runtime = this.resourceLoader.getExtensions().runtime;
		installMcpRegistrationCap(this.mcpCap, runtime.mcpServers);
		const registered = runtime.mcpServers.list().length;
		if (registered > MAX_MCP_SERVERS) {
			throw new RsiError(
				"RESOURCE_CAP_EXCEEDED",
				`At most ${MAX_MCP_SERVERS} MCP servers may be registered before activation.`,
				{ details: { count: registered, max: MAX_MCP_SERVERS } },
			);
		}
		this.guard.installProviderApiGuard(runtime);
		this.requestContext.installProviderBoundary(this.sessionValue);
		await this.sessionValue.bindExtensions(this.bindings());
		if (this.mcpCap.lastError) throw this.mcpCap.lastError;
		this.resourceLoader.assertApprovedExtensionsLoaded();
		this.assertRequiredPlugins();
		this.resourceLoader.assertSkillCap(this.resourceLoader as never, "session bind");
		this.guard.assertNoProviderMutationAttempts("session bind");
	}

	/** Prepare a newly loaded runtime before Pi emits session_start. */
	private prepareRuntimeForSessionStart(source: string): void {
		this.resourceLoader.assertApprovedExtensionsLoaded();
		this.assertRequiredPlugins();
		this.resourceLoader.assertSkillCap(this.resourceLoader as never, source);
		const runtime = this.resourceLoader.getExtensions().runtime;
		installMcpRegistrationCap(this.mcpCap, runtime.mcpServers);
		const registered = runtime.mcpServers.list().length;
		if (registered > MAX_MCP_SERVERS) {
			throw new RsiError(
				"RESOURCE_CAP_EXCEEDED",
				`At most ${MAX_MCP_SERVERS} MCP servers may be registered before activation.`,
				{ details: { count: registered, max: MAX_MCP_SERVERS } },
			);
		}
		if (this.mcpCap.lastError) throw this.mcpCap.lastError;
		this.guard.installProviderApiGuard(runtime);
		// reload() builds a new extension runner before beforeSessionStart. Wrap
		// that runner's before_agent_start boundary before any session_start hook
		// (and later model run) can mutate systemPromptOptions.
		this.requestContext.installProviderBoundary(this.sessionValue);
	}

	/**
	 * A failed reload can happen after Pi has already replaced the session's
	 * extension runner. Re-run the previous approved set through the real Pi
	 * reload path so rejected candidate tools/MCP servers are unloaded instead of
	 * leaving a generation that the Supervisor must pretend succeeded. If this
	 * restoration itself fails, the caller falls back to process exit/Watchdog.
	 */
	private async restorePreviousSession(): Promise<void> {
		this.mcpCap.lastError = undefined;
		this.guard.clearProviderMutationAttempts();
		await this.guard.runOriginalReload(this.sessionValue, {
			beforeSessionStart: async () => {
				this.prepareRuntimeForSessionStart("reload restoration");
			},
		});
		if (this.mcpCap.lastError) throw this.mcpCap.lastError;
		this.guard.install(this.sessionValue);
		this.guard.installProviderApiGuard(this.resourceLoader.getExtensions().runtime);
		this.guard.clearProviderMutationAttempts();
	}

	private subscribe(session: AgentSession): void {
		this.unsubscribe?.();
		this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
	}

	private handleSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.assistantMessages = 0;
			this.lastAssistantStopReason = undefined;
			this.lastAgentEndAt = undefined;
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			this.assistantMessages++;
			this.lastAssistantStopReason = event.message.stopReason;
			return;
		}
		if (event.type === "agent_end") {
			this.lastAgentEndAt = this.clock.now().getTime();
			this.eventRelay.sendEvent("agent.end", {
				willRetry: event.willRetry,
				atMs: this.lastAgentEndAt,
			});
			void this.telemetry.emit({
				type: "agent_end",
				willRetry: event.willRetry,
				atMs: this.lastAgentEndAt,
			});
		}
		if (event.type === "agent_settled") {
			void this.telemetry.emit({
				type: "agent_settled",
				runId: this.currentRunId ?? `turn-${this.settlementIndex}`,
				generation: this.generationValue,
				sessionId: this.sessionId(),
				aborted: event.aborted,
				stopReason: this.lastAssistantStopReason ?? "unknown",
				assistantMessages: this.assistantMessages,
				atMs: this.clock.now().getTime(),
			});
		}
	}

	async run(prompt: string, signal?: AbortSignal, options: { readonly runId?: string } = {}): Promise<void> {
		if (this.stopping) throw new RsiError("INTERNAL", "Worker is stopping.");
		if (this.reloading) throw new RsiError("INTERNAL", "Worker is reloading.");
		if (this.running || !this.sessionValue.isIdle) {
			throw new RsiError(
				"INTERNAL",
				"Refusing to start a prompt while the previous run, native retry, or continuity settlement is still active.",
			);
		}
		assertAgentPromptAllowed(prompt);
		this.running = true;
		this.runSettled = false;
		this.currentRunId = options.runId ?? `run-${this.sessionId() ?? "session"}-${this.settlementIndex + 1}`;
		const onAbort = (): void => {
			void this.sessionValue.abort();
		};
		if (signal?.aborted) {
			this.running = false;
			throw signal.reason ?? new RsiError("INTERNAL", "Run aborted before it started.");
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await this.sessionValue.prompt(prompt, { expandPromptTemplates: false });
		} catch (error) {
			if (!this.runSettled) await this.recordFailedSettlement(error);
			this.reportException("run", error);
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.running = false;
		}
	}

	async requestReload(options: {
		candidateId?: string;
		approvedExtensionPaths?: readonly string[];
		beforeSessionStart?: () => void | Promise<void>;
	} = {}): Promise<{ report: PreflightReport; started: ReloadStartResult }> {
		if (this.reloading) throw new RsiError("RELOAD_FAILED", "A reload is already in progress.");
		this.reloading = true;
		const previousPaths = [...this.approvedPaths];
		let attemptId: string | undefined;
		let runtimeMayBeLoaded = false;
		let reloadCommitted = false;
		try {
			const report = await this.services.reload.preflight(options.candidateId);
			await this.emitTelemetry({
				type: "reload",
				phase: "preflight",
				detail: report.candidateId,
				atMs: this.clock.now().getTime(),
			});
			if (!report.ok) {
				throw new RsiError(
					"PREFLIGHT_FAILED",
					`Preflight rejected candidate ${report.candidateId}.
${formatPreflightToolError(report)}`,
					{
					details: {
						candidateId: report.candidateId,
						digest: report.digest,
						staticErrors: [...report.staticSyntaxCheck.errors],
						mockErrors: [...report.mockLoad.errors],
					},
				});
			}
			const started = await this.services.reload.started(report);
			attemptId = started.attemptId;
			this.observingAttemptId = started.attemptId;
			const nextPaths = options.approvedExtensionPaths ?? report.entryPaths;
			if (nextPaths !== undefined) {
				this.approvedPaths = [
					...new Set([
						...this.requiredPluginPaths,
						...nextPaths.map((path) => resolve(path)),
					]),
				];
				this.resourceLoader.setApprovedExtensionPaths(this.approvedPaths);
			}
			await this.emitTelemetry({
				type: "reload",
				phase: "started",
				detail: started.attemptId,
				atMs: this.clock.now().getTime(),
			});
			this.guard.clearProviderMutationAttempts();
			runtimeMayBeLoaded = true;
			await this.guard.runOriginalReload(this.sessionValue, {
				beforeSessionStart: async () => {
					await options.beforeSessionStart?.();
					// The resource loader has already reloaded at this point. Install the
					// provider boundary before session_start, not after session.reload
					// returns, and cap MCP before session_start connects anything.
					this.prepareRuntimeForSessionStart("reload");
					this.guard.assertNoProviderMutationAttempts("reload before session_start");
				},
			});
			reloadCommitted = true;
			this.guard.assertNoProviderMutationAttempts("reload session_start");
			if (this.mcpCap.lastError) throw this.mcpCap.lastError;
			this.assertCandidateProviderHooks();
			this.guard.install(this.sessionValue);
			this.guard.installProviderApiGuard(this.resourceLoader.getExtensions().runtime);
			this.loadedMcpFingerprint = await this.mcpFingerprint();
			this.generationValue = report.generation;
			this.eventRelay.sendEvent("reload.completed", {
				attemptId: started.attemptId,
				generation: report.generation,
				atMs: this.clock.now().getTime(),
			});
			await this.emitTelemetry({
				type: "reload",
				phase: "completed",
				detail: started.attemptId,
				atMs: this.clock.now().getTime(),
			});
			return { report, started };
		} catch (error) {
			this.approvedPaths = previousPaths;
			this.resourceLoader.setApprovedExtensionPaths(previousPaths);
			this.observingAttemptId = undefined;
			const failure = asRsiError(error, "RELOAD_FAILED");
			const providerBoundaryFailure = isProviderMutationFailure(failure);
			const useExternalRecovery = reloadCommitted && !providerBoundaryFailure;
			let restored = !runtimeMayBeLoaded;
			if (runtimeMayBeLoaded && !useExternalRecovery) {
				try {
					await this.restorePreviousSession();
					restored = true;
				} catch (restoreError) {
					this.reportException("reload-restore", restoreError);
				}
			}
			if (attemptId !== undefined) {
				await this.services.reload.failed(attemptId, failure.message).catch(() => {});
			}
			if (useExternalRecovery || !restored) {
				// Restoration itself failed. Do not leave candidate tools/hooks callable
				// or a partially applied generation looking healthy; let the external
				// Watchdog restore the LKG Worker.
				setTimeout(() => process.exit(70), 10);
			}
			await this.emitTelemetry({
				type: "reload",
				phase: "failed",
				detail: failure.message,
				atMs: this.clock.now().getTime(),
			});
			this.reportException("reload", failure);
			throw failure;
		} finally {
			this.reloading = false;
		}
	}

	private async mcpFingerprint(): Promise<string> {
		const hash = createHash("sha256");
		for (const path of [join(this.options.agentDir, "mcp.json"), join(this.options.cwd, ".pi", "mcp.json")]) {
			hash.update(path).update("\0");
			try {
				hash.update(await readFile(path));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				hash.update("<missing>");
			}
			hash.update("\0");
		}
		return hash.digest("hex");
	}

	async previewResources(): Promise<{ changed: boolean; skillsChanged: boolean; mcpChanged: boolean }> {
		if (this.state() !== "idle") throw new RsiError("RELOAD_FAILED", "Resource preview requires an idle Worker.");
		const skillsChanged = await this.resourceLoader.previewSkillChanges();
		const mcpChanged = (await this.mcpFingerprint()) !== this.loadedMcpFingerprint;
		return { changed: skillsChanged || mcpChanged, skillsChanged, mcpChanged };
	}

	async cancelSleep(reason: string): Promise<boolean> {
		return await this.sleep.cancelExternal(reason);
	}

	status(): WorkerStatus {
		return {
			state: this.state(),
			generation: this.generationValue,
			healthTurns: this.healthTurns,
			memoryRevision: this.memoryRevision,
			sessionId: this.sessionId(),
			extensionPaths: this.resourceLoader
				.getExtensions()
				.extensions.filter((entry) => !entry.path.startsWith("<") && !entry.path.startsWith("builtin:"))
				.map((entry) => entry.resolvedPath),
			skillCount: this.resourceLoader.getSkills().skills.length,
			mcpServerCount: Math.max(
				this.mcpCap.configuredNames.size,
				this.resourceLoader.getExtensions().runtime.mcpServers.list().length,
			),
		};
	}

	async stop(reason: string): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		this.stopHeartbeat();
		this.eventRelay.sendEvent("worker.stopping", {
			reason,
			atMs: this.clock.now().getTime(),
		});
		try {
			await this.sessionValue.abort();
		} catch {}
		try {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			this.sessionValue.dispose();
		} catch {}
	}

	async replaceSession(session: AgentSession, options: { bind?: boolean } = {}): Promise<void> {
		this.unsubscribe?.();
		this.sessionValue = session;
		this.assistantMessages = 0;
		this.lastAssistantStopReason = undefined;
		this.lastAgentEndAt = undefined;
		this.guard.install(session);
		this.requestContext.installProviderBoundary(session);
		this.subscribe(session);
		if (options.bind !== false) {
			await this.bindCurrentSession();
			this.assertCandidateProviderHooks();
		}
	}

	private async recordFailedSettlement(error: unknown): Promise<void> {
		this.reportException("health", error);
		const observation: HealthTurnObservation = {
			attemptId: this.observingAttemptId ?? "steady",
			generation: this.generationValue ?? 0,
			turnIndex: this.settlementIndex++,
			stopReason: "error",
			aborted: true,
			assistantMessages: this.assistantMessages,
			atMs: this.clock.now().getTime(),
		};
		await this.recordHealth(observation);
		this.sendSettledEvent(observation);
	}

	async recordSettlement(aborted: boolean): Promise<void> {
		this.runSettled = true;
		const observation: HealthTurnObservation = {
			attemptId: this.observingAttemptId ?? "steady",
			generation: this.generationValue ?? 0,
			turnIndex: this.settlementIndex++,
			stopReason: this.lastAssistantStopReason ?? "unknown",
			aborted,
			assistantMessages: this.assistantMessages,
			atMs: this.clock.now().getTime(),
		};
		await this.recordHealth(observation);
		this.sendSettledEvent(observation);
	}

	private sendSettledEvent(observation: HealthTurnObservation): void {
		this.eventRelay.sendEvent("agent.settled", {
			runId: this.currentRunId ?? `turn-${observation.turnIndex}`,
			generation: this.generationValue,
			sessionId: this.sessionId(),
			aborted: observation.aborted,
			stopReason: observation.stopReason,
			assistantMessages: observation.assistantMessages,
			atMs: observation.atMs,
		});
	}

	private sessionId(): string | null {
		try {
			return this.sessionValue.sessionManager.getSessionId() ?? null;
		} catch {
			return null;
		}
	}

	private async recordHealth(observation: HealthTurnObservation): Promise<void> {
		try {
			const result = await this.services.health.record(observation);
			this.healthTurns = result.consecutiveHealthyTurns;
			await this.emitTelemetry({
				type: "health_turn",
				observation,
				result,
				atMs: this.clock.now().getTime(),
			});
		} catch (error) {
			this.reportException("health", error);
		}
	}

	private assertRequiredPlugins(): void {
		const loaded = new Set(
			this.resourceLoader
				.getExtensions()
				.extensions.filter(
					(extension) =>
						!extension.path.startsWith("<") && !extension.path.startsWith("builtin:"),
				)
				.map((extension) => resolve(extension.resolvedPath)),
		);
		const missing = this.requiredPluginPaths.filter((path) => !loaded.has(resolve(path)));
		if (missing.length > 0) {
			throw new RsiError(
				"PLUGIN_MANIFEST_MISMATCH",
				`Mandatory Pi plugins did not load: ${missing.join(", ")}`,
				{ details: { missing } },
			);
		}
	}

	private state(): WorkerStatus["state"] {
		if (this.stopping) return "stopping";
		if (this.reloading) return "reloading";
		if (this.sleep.sleeping) return "sleeping";
		if (this.running || !this.sessionValue.isIdle) return "busy";
		return "idle";
	}

	private startHeartbeat(): void {
		const interval = Math.max(1_000, this.options.config.ipc.heartbeatIntervalMs);
		this.heartbeatTimer = setInterval(() => {
			void this.tickHeartbeat();
		}, interval);
		this.heartbeatTimer.unref?.();
		void this.tickHeartbeat();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	private async tickHeartbeat(): Promise<void> {
		if (this.heartbeatBusy || this.stopping) return;
		this.heartbeatBusy = true;
		try {
			const report = {
				sequence: ++this.heartbeatSequence,
				workerPid: process.pid,
				generation: this.generationValue,
				state: this.state(),
				healthTurns: this.healthTurns,
				memoryRevision: this.memoryRevision,
				sentAtMs: this.clock.now().getTime(),
			};
			await this.services.heartbeat.beat(report);
		} catch (error) {
			this.reportException("heartbeat", error);
		} finally {
			this.heartbeatBusy = false;
		}
	}

	private reportException(scope: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.diagnostics.push(`${scope}: ${message}`);
		if (this.diagnostics.length > 100) this.diagnostics.shift();
		this.eventRelay.sendEvent("worker.exception", {
			scope,
			message,
			...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
			atMs: this.clock.now().getTime(),
		});
		void this.telemetry.emit({
			type: "exception",
			scope,
			message,
			atMs: this.clock.now().getTime(),
		});
	}

	private async emitTelemetry(event: WorkerTelemetryEvent): Promise<void> {
		try {
			await this.telemetry.emit(event);
		} catch {}
	}
}

function bundledExtensionFactories(
	options: PiWorkerOptions,
	mcp: InlineExtension,
	rsi: InlineExtension,
): InlineExtension[] {
	return [
		...(options.extensionFactories ?? []),
		{ name: "codemode", factory: createCodemodeExtension(), replaceable: true },
		{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true },
		mcp,
		rsi,
	];
}

function isProviderMutationFailure(error: RsiError): boolean {
	const details = error.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return false;
	const reason = (details as Record<string, unknown>).reason;
	return typeof reason === "string" && reason.startsWith("provider-mutation");
}

export async function createPiWorker(options: PiWorkerOptions): Promise<PiWorker> {
	const clock: Clock = new SystemClock();
	const timeZone = options.config.timeZone;
	const managedTools = await ManagedToolRuntime.create({
		markdownsDir: options.config.paths.markdownsDir,
		cwd: options.cwd,
		documents: options.services.documents,
	});
	const telemetry: WorkerTelemetryPort = options.services.telemetry ?? new NoopTelemetry();
	const eventRelay = new EventRelay();
	eventRelay.setTarget(options.events);
	const sleep = new SleepController({
		gate: options.services.sleep,
		clock,
		timeZone,
		events: {
			sendEvent: (event, payload) => eventRelay.sendEvent(event, payload),
		},
		telemetry,
	});
	const mcpCap = createMcpCapState();
	const nativeMcpFactory = await createNativeMcpExtensionFactory(mcpCap, options.agentDir);
	const requiredPluginPaths = REQUIRED_PLUGIN_PINS.map((pin) => resolveInstalledPluginExtension(pin));
	const approvedPaths = [
		...new Set([
			...requiredPluginPaths,
			...(options.approvedExtensionPaths ?? []).map((path) => resolve(path)),
		]),
	];

	let workerRef: PiWorkerImpl | undefined;
	const guard = new SessionControlGuard({
		reload: async () => {
			if (!workerRef) throw new RsiError("INTERNAL", "Worker is not initialized.");
			await workerRef.requestReload();
		},
		waitForIdle: async () => {
			if (!workerRef) throw new RsiError("INTERNAL", "Worker is not initialized.");
			await workerRef.session.waitForIdle();
		},
		onForbidden: (operation) => {
			void telemetry.emit({
				type: "exception",
				scope: "forbidden-control",
				message: operation,
				atMs: clock.now().getTime(),
			});
		},
	});
	// Install before any candidate resource is loaded: an extension factory's
	// registerProvider goes into Pi's pending queue and is flushed by bindCore,
	// which is too early for a session_start-only guard.
	guard.installModelRuntimeGuard(options.modelRuntime);
	const requestContext = new RequestContextAdapter({
		memory: options.services.memory,
		manualSystemPrompt: options.manualPrompt.content,
		sleepGate: options.services.sleep,
		sleepWaiter: sleep.waiter,
		clock,
		onMemory: (memory) => {
			workerRef?.setMemoryRevision(memory.revision);
		},
		onProviderRequest: options.onProviderRequest,
		onError: (error) => {
			void telemetry.emit({
				type: "exception",
				scope: "memory",
				message: error instanceof Error ? error.message : String(error),
				atMs: clock.now().getTime(),
			});
		},
	});
	const finalizer = new ToolResultFinalizer({
		decoration: options.services.decoration,
		managedTools,
		clock,
		timeZone,
		onDecorationError: (error) => {
			void telemetry.emit({
				type: "exception",
				scope: "decoration",
				message: error instanceof Error ? error.message : String(error),
				atMs: clock.now().getTime(),
			});
		},
	});
	const rsiFactory = createRsiExtension({
		cwd: options.cwd,
		managedTools,
		requestContext,
		sleep,
		finalizer,
		middleware: options.toolMiddleware,
		onDiagnostic: (message) => {
			void telemetry.emit({
				type: "exception",
				scope: "guard",
				message,
				atMs: clock.now().getTime(),
			});
		},
		onAgentSettled: async (aborted) => {
			await workerRef?.recordSettlement(aborted);
		},
		onNestedResult: (event) => {
			workerRef?.recordNestedResult(event);
		},
	});
	const mcpInline: InlineExtension = { name: "mcp", factory: nativeMcpFactory, replaceable: true };
	const rsiInline: InlineExtension = { name: "rsi", factory: rsiFactory };
	const resourceLoader = new RestrictedResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: options.settingsManager,
		approvedExtensionPaths: approvedPaths,
		manualSystemPrompt: options.manualPrompt.content,
		extensionFactories: bundledExtensionFactories(options, mcpInline, rsiInline),
	});
	await resourceLoader.reload();
	resourceLoader.assertApprovedExtensionsLoaded();
	for (const extension of resourceLoader.getExtensions().extensions) {
		if (extension.path.startsWith("<") || extension.path.startsWith("builtin:")) continue;
		if (requiredPluginPaths.some((path) => resolve(path) === resolve(extension.resolvedPath))) continue;
		if ((extension.handlers.get("before_provider_request") ?? []).length > 0) {
			throw new RsiError(
				"PLUGIN_MANIFEST_MISMATCH",
				`Candidate extension ${extension.path} registers before_provider_request; provider payload mutation is not allowed.`,
			);
		}
	}
	const requiredLoaded = new Set(
		resourceLoader
			.getExtensions()
			.extensions.filter(
				(extension) => !extension.path.startsWith("<") && !extension.path.startsWith("builtin:"),
			)
			.map((extension) => resolve(extension.resolvedPath)),
	);
	const missingRequired = requiredPluginPaths.filter((path) => !requiredLoaded.has(resolve(path)));
	if (missingRequired.length > 0) {
		throw new RsiError(
			"PLUGIN_MANIFEST_MISMATCH",
			`Mandatory Pi plugins did not load: ${missingRequired.join(", ")}`,
			{ details: { missing: missingRequired } },
		);
	}

	const sessionManager =
		options.sessionManager ?? SessionManager.create(options.cwd, options.config.paths.piSessionDir);
	const created = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		model: options.model,
		modelRuntime: options.modelRuntime,
		settingsManager: options.settingsManager,
		...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
		resourceLoader: resourceLoader as unknown as ResourceLoader,
		sessionManager,
		sessionStartEvent: options.sessionStartEvent,
	});

	requestContext.installProviderBoundary(created.session);

	workerRef = new PiWorkerImpl({
		options,
		services: options.services,
		resourceLoader,
		managedTools,
		sleep,
		session: created.session,
		mcpCap,
		requiredPluginPaths,
		approvedPaths,
		telemetry,
		guard,
		eventRelay,
		requestContext,
	});
	try {
		await workerRef.initialize();
	} catch (error) {
		await workerRef.stop("initialization-failed").catch(() => {});
		throw error;
	}
	return workerRef;
}
