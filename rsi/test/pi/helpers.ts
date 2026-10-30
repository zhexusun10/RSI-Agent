import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/compat";
import {
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { DocumentMutationResult, IndexConsistency, ManagedDocumentStat } from "../../src/shared/documents.ts";
import {
	auditIndex,
	formatIndexWarning,
	renderIndexReadReport,
	validateManagedDocumentWrite,
} from "../../src/shared/documents.ts";
import { RsiError } from "../../src/shared/errors.ts";
import { sha256Text, type ContentRevision } from "../../src/shared/hash.ts";
import type {
	DocumentStorePort,
	MemoryPort,
	SleepGatePort,
	ToolMiddlewarePort,
	ToolResultDecorationPort,
} from "../../src/shared/ports.ts";
import { MAX_MANAGED_DOCUMENTS, MAX_MCP_SERVERS, MAX_SKILLS } from "../../src/shared/policy.ts";
import { createMemorySnapshot, formatMemoryUsage, type MemorySnapshot } from "../../src/shared/memory.ts";
import { INDEX_FILENAME, MEMORY_FILENAME } from "../../src/shared/paths.ts";
import { parseRsiConfig, type RsiConfig } from "../../src/shared/config.ts";
import { readImmutableSystemPrompt, type ManualSystemPrompt } from "../../src/shared/prompt.ts";
import {
	advanceHealthTurns,
	classifyHealthyTurn,
	type HealthTurnObservation,
	type PreflightReport,
} from "../../src/shared/preflight.ts";
import {
	computeSleepDeadline,
	createSleepState,
	type SleepRequestInput,
	type SleepState,
} from "../../src/shared/sleep.ts";
import type {
	HealthTurnResult,
	HeartbeatAck,
	HeartbeatReport,
	IndexReadReport,
	ReloadStartResult,
	SleepGrant,
	ToolResultDecorationRequest,
	ToolResultDecorationResult,
	WorkerToSupervisorEvent,
	WorkerToSupervisorEvents,
} from "../../src/shared/ipc/protocol.ts";
import { formatTimestamp } from "../../src/shared/time.ts";
import { countWords } from "../../src/shared/words.ts";
import { createPiWorker, type PiWorker } from "../../src/pi/worker.ts";
import type {
	HeartbeatPort,
	PiWorkerServices,
	WorkerReloadPort,
	WorkerTelemetryEvent,
	WorkerTelemetryPort,
} from "../../src/pi/worker-types.ts";

export const RSI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARTIFACTS = join(RSI_ROOT, ".artifacts");

export const MANUAL_MARKER = "RSI-MANUAL-PROMPT-7F3A";
export const MANUAL_PROMPT = `${MANUAL_MARKER}\nLine two of the human prompt.`;

class FakeDocuments implements DocumentStorePort {
	readonly files = new Map<string, { content: string; revision: ContentRevision; mtimeMs: number }>();
	readonly reads = new Map<string, number[]>();
	readonly commits: Array<Parameters<DocumentStorePort["commit"]>[0]> = [];
	private readonly timeZone: string;

	constructor(timeZone: string) {
		this.timeZone = timeZone;
	}

	seed(name: string, content: string, mtimeMs = Date.now()): void {
		this.files.set(name, { content, revision: sha256Text(content), mtimeMs });
	}

	get(name: string): { content: string; revision: ContentRevision; mtimeMs: number } | undefined {
		return this.files.get(name);
	}

	async list() {
		return [...this.files.entries()].map(([name, file]) => ({
			name,
			words: countWords(file.content),
			revision: file.revision,
			mtimeMs: file.mtimeMs,
		}));
	}

	async read(name: string) {
		const file = this.files.get(name);
		if (!file) throw new RsiError("DOCUMENT_NOT_FOUND", `Managed Markdown does not exist: ${name}`);
		return {
			name,
			content: file.content,
			words: countWords(file.content),
			revision: file.revision,
			mtimeMs: file.mtimeMs,
		};
	}

	async commit(request: Parameters<DocumentStorePort["commit"]>[0]): Promise<DocumentMutationResult> {
		this.commits.push(request);
		const existing = this.files.get(request.name);
		const currentRevision = existing?.revision ?? null;
		if (request.expectedRevision !== currentRevision) {
			throw new RsiError("DOCUMENT_REVISION_CONFLICT", `Revision conflict for ${request.name}.`);
		}
		if (!existing && this.files.size >= MAX_MANAGED_DOCUMENTS) {
			throw new RsiError("DOCUMENT_COUNT_LIMIT", `At most ${MAX_MANAGED_DOCUMENTS} managed files.`);
		}
		validateManagedDocumentWrite({
			name: request.name,
			content: request.content,
			existingNames: [...this.files.keys()],
		});
		const words = countWords(request.content);
		const revision = sha256Text(request.content);
		const mtimeMs = Date.now();
		this.files.set(request.name, { content: request.content, revision, mtimeMs });
		const consistency = await this.consistency();
		return {
			name: request.name,
			revision,
			words,
			created: existing === undefined,
			...(request.name === MEMORY_FILENAME ? { memoryUsage: formatMemoryUsage(words) } : {}),
			indexWarnings: consistency.warnings,
			committedAtMs: mtimeMs,
		};
	}

	async indexReport(now: Date): Promise<IndexReadReport> {
		const stats: ManagedDocumentStat[] = [...this.files.entries()].map(([name, file]) => ({
			name,
			words: countWords(file.content),
			mtimeMs: file.mtimeMs,
			readsLast24h: this.readsLast24h(name, now),
		}));
		const consistency = await this.consistency();
		return {
			generatedAtMs: now.getTime(),
			stats,
			consistency,
			reportText: renderIndexReadReport(stats, now, this.timeZone),
		};
	}

	async consistency(): Promise<IndexConsistency> {
		const index = this.files.get(INDEX_FILENAME)?.content ?? "";
		return auditIndex(index, [...this.files.keys()]);
	}

	async recordRead(name: string, at: Date): Promise<number> {
		const list = this.reads.get(name) ?? [];
		list.push(at.getTime());
		this.reads.set(name, list);
		return this.readsLast24h(name, at);
	}

	countReads(name: string): number {
		return this.reads.get(name)?.length ?? 0;
	}

	private readsLast24h(name: string, now: Date): number {
		const cutoff = now.getTime() - 24 * 60 * 60 * 1_000;
		return (this.reads.get(name) ?? []).filter((at) => at >= cutoff).length;
	}
}

class FakeDecoration implements ToolResultDecorationPort {
	readonly requests: ToolResultDecorationRequest[] = [];
	private readonly documents: FakeDocuments;
	private readonly timeZone: string;

	constructor(documents: FakeDocuments, timeZone: string) {
		this.documents = documents;
		this.timeZone = timeZone;
	}

	async decorate(request: ToolResultDecorationRequest, now: Date): Promise<ToolResultDecorationResult> {
		this.requests.push(request);
		if (request.readName) await this.documents.recordRead(request.readName, now);
		const consistency = await this.documents.consistency();
		const warning = formatIndexWarning(consistency);
		const report = request.indexRead ? await this.documents.indexReport(now) : null;
		return {
			appendText: "",
			currentTime: formatTimestamp(now, this.timeZone),
			warnings: warning === undefined ? [] : [warning],
			indexReport: report?.reportText ?? null,
		};
	}
}

class FakeMemory implements MemoryPort {
	private readonly documents: FakeDocuments;

	constructor(documents: FakeDocuments) {
		this.documents = documents;
	}

	async readCurrentMemory(): Promise<MemorySnapshot> {
		const file = this.documents.get(MEMORY_FILENAME);
		return createMemorySnapshot({
			content: file?.content ?? "",
			updatedAtMs: file?.mtimeMs ?? Date.now(),
		});
	}

	async commitMemory(input: { content: string; expectedRevision: ContentRevision }) {
		const result = await this.documents.commit({
			name: MEMORY_FILENAME,
			content: input.content,
			expectedRevision: input.expectedRevision,
			operation: "memory",
		});
		return { snapshot: await this.readCurrentMemory(), usage: result.memoryUsage ?? "" };
	}
}

class FakeSleepGate implements SleepGatePort {
	readonly requests: SleepRequestInput[] = [];
	state: SleepState | null = null;
	cancelled: string | undefined;
	private readonly timeZone: string;

	constructor(timeZone: string) {
		this.timeZone = timeZone;
	}

	async request(input: SleepRequestInput, now: Date): Promise<SleepGrant> {
		this.requests.push(input);
		const deadline = computeSleepDeadline(input, now, this.timeZone);
		const sleepId = `sleep-${this.requests.length}`;
		this.state = createSleepState({ sleepId, deadline, now });
		return {
			accepted: true,
			sleepId,
			deadlineMs: deadline.deadlineMs,
			deadlineLocal: deadline.deadlineLocal,
			timeZone: this.timeZone,
			state: this.state,
		};
	}

	async status(): Promise<SleepState | null> {
		return this.state;
	}

	async cancel(reason: string, now: Date): Promise<boolean> {
		this.cancelled = reason;
		if (this.state?.status === "active") {
			this.state = { ...this.state, status: "cancelled", updatedAtMs: now.getTime() };
			return true;
		}
		return false;
	}

	setActive(deadlineMs: number): void {
		const now = Date.now();
		this.state = {
			version: 1,
			sleepId: `external-${now}`,
			source: "explicit-sleep-tool",
			request: { kind: "relative", duration: { raw: "1s", amount: 1, unit: "s" } },
			requestedAtMs: now,
			deadlineMs,
			timeZone: this.timeZone,
			status: "active",
			updatedAtMs: now,
		};
	}
}

class FakeReload implements WorkerReloadPort {
	readonly preflights: Array<string | undefined> = [];
	readonly starts: PreflightReport[] = [];
	readonly failures: Array<{ attemptId: string; reason: string }> = [];
	nextOk = true;
	private generation = 1;

	async preflight(candidateId?: string): Promise<PreflightReport> {
		this.preflights.push(candidateId);
		const generation = this.generation;
		return {
			candidateId: candidateId ?? `candidate-${generation}`,
			generation,
			digest: sha256Text(`candidate-${generation}`),
			staticSyntaxCheck: { ok: this.nextOk, durationMs: 1, errors: this.nextOk ? [] : ["syntax"] },
			mockLoad: { ok: this.nextOk, durationMs: 1, errors: this.nextOk ? [] : ["load"] },
			ok: this.nextOk,
			completedAtMs: Date.now(),
		};
	}

	async started(report: PreflightReport): Promise<ReloadStartResult> {
		this.starts.push(report);
		this.generation = report.generation + 1;
		return { attemptId: `attempt-${report.generation}`, requiredHealthTurns: 3 };
	}

	async failed(attemptId: string, reason: string): Promise<void> {
		this.failures.push({ attemptId, reason });
	}
}

class FakeHealth {
	readonly observations: HealthTurnObservation[] = [];
	private count = 0;

	async record(observation: HealthTurnObservation): Promise<HealthTurnResult> {
		this.observations.push(observation);
		const healthy = classifyHealthyTurn(observation);
		const step = advanceHealthTurns(this.count, healthy);
		this.count = step.consecutiveHealthyTurns;
		return {
			consecutiveHealthyTurns: this.count,
			required: step.required,
			promoted: step.readyToPromote,
			lkgGeneration: step.readyToPromote ? observation.generation : null,
			failed: !healthy,
		};
	}
}

class FakeHeartbeat implements HeartbeatPort {
	readonly reports: HeartbeatReport[] = [];

	async beat(report: HeartbeatReport): Promise<HeartbeatAck> {
		this.reports.push(report);
		return {
			accepted: true,
			serverTimeMs: Date.now(),
			leaseExpiresAtMs: Date.now() + 30_000,
			directive: "none",
		};
	}
}

class FakeTelemetry implements WorkerTelemetryPort {
	readonly events: WorkerTelemetryEvent[] = [];

	async emit(event: WorkerTelemetryEvent): Promise<void> {
		this.events.push(event);
	}
}

class FakeEvents {
	readonly events: Array<{ event: WorkerToSupervisorEvent; payload: unknown }> = [];

	sendEvent<E extends WorkerToSupervisorEvent>(event: E, payload: WorkerToSupervisorEvents[E]): void {
		this.events.push({ event, payload });
	}
}

export interface TestEnvironment {
	readonly root: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly markdownsDir: string;
	readonly stateDir: string;
	readonly homesDir: string;
	readonly config: RsiConfig;
	readonly manualPrompt: ManualSystemPrompt;
	readonly settingsManager: SettingsManager;
	readonly documents: FakeDocuments;
	readonly memory: FakeMemory;
	readonly decoration: FakeDecoration;
	readonly sleepGate: FakeSleepGate;
	readonly reload: FakeReload;
	readonly health: FakeHealth;
	readonly heartbeat: FakeHeartbeat;
	readonly telemetry: FakeTelemetry;
	readonly events: FakeEvents;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<any>;
	readonly services: PiWorkerServices;
	readonly sessionManager: SessionManager;
	approvedExtensionPaths: string[];
	worker: PiWorker | undefined;
	session: AgentSession | undefined;
	seedSkill(name: string, description: string, scope: "global" | "project"): Promise<string>;
	writeTextFile(relative: string, content: string): Promise<string>;
	writeExtension(filename: string, source: string): Promise<string>;
	startWorker(options?: StartWorkerOptions): Promise<PiWorker>;
	cleanup(): Promise<void>;
}

export type TestWorkspace = TestEnvironment & {
	readonly worker: PiWorker;
	readonly session: AgentSession;
};

export interface StartWorkerOptions {
	readonly approvedExtensionPaths?: readonly string[];
	readonly extensionFactories?: readonly import("@earendil-works/pi-coding-agent").InlineExtension[];
	readonly toolMiddleware?: ToolMiddlewarePort;
	readonly sessionManager?: SessionManager;
}

export interface TestWorkspaceOptions {
	readonly memory?: string;
	readonly withWebProvider?: boolean;
	readonly projectTrusted?: boolean;
	readonly approvedExtensionPaths?: readonly string[];
	readonly extensionFactories?: readonly import("@earendil-works/pi-coding-agent").InlineExtension[];
	readonly toolMiddleware?: ToolMiddlewarePort;
	readonly sessionManager?: SessionManager;
	readonly settingsOverrides?: Parameters<SettingsManager["applyOverrides"]>[0];
}

function createConfig(input: { root: string; promptFile: string }): RsiConfig {
	return parseRsiConfig({
		version: 1,
		timeZone: "UTC",
		paths: {
			workspaceDir: join(input.root, "workspace"),
			dataDir: join(input.root, "data"),
			stateDir: join(input.root, "state"),
			markdownsDir: join(input.root, "markdowns"),
			piSourceDir: join(input.root, "pi-source"),
			rsiSourceDir: join(input.root, "rsi-source"),
			systemPromptFile: input.promptFile,
			hostIpcSocketPath: join(input.root, "state", "run", "worker.sock"),
		},
		ipc: { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 30_000 },
	});
}

export async function writeSkillFixture(dir: string, name: string, description: string): Promise<string> {
	const skillDir = join(dir, name);
	await mkdir(skillDir, { recursive: true });
	const file = join(skillDir, "SKILL.md");
	await writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} fixture body.\n`);
	return file;
}

export async function createTestEnvironment(options: TestWorkspaceOptions = {}): Promise<TestEnvironment> {
	await mkdir(ARTIFACTS, { recursive: true });
	const previousEnv = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_BETTER_WEB_SEARCH_CACHE: process.env.PI_BETTER_WEB_SEARCH_CACHE,
	};
	const root = await mkdtemp(join(ARTIFACTS, "pi-worker-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const markdownsDir = join(root, "markdowns");
	const stateDir = join(root, "state");
	const homesDir = join(root, "home");
	const sessionsDir = join(root, "sessions");
	for (const dir of [cwd, agentDir, markdownsDir, stateDir, homesDir, sessionsDir, join(root, "data")]) {
		await mkdir(dir, { recursive: true });
	}
	process.env.HOME = homesDir;
	process.env.USERPROFILE = homesDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_BETTER_WEB_SEARCH_CACHE = join(agentDir, "better-web-search.json");

	const promptFile = join(root, "manual-prompt.txt");
	await writeFile(promptFile, MANUAL_PROMPT);
	const manualPrompt = await readImmutableSystemPrompt(promptFile);
	const config = createConfig({ root, promptFile });

	const documents = new FakeDocuments(config.timeZone);
	const memoryText = options.memory ?? "";
	documents.seed(MEMORY_FILENAME, memoryText, Date.now());
	const indexText = [
		"| md名 | description | 链接位置 |",
		"| --- | --- | --- |",
		"| Memory.md | Long-term memory | Memory.md |",
		"| index.md | Index | index.md |",
		"",
	].join("\n");
	documents.seed(INDEX_FILENAME, indexText, Date.now());
	await writeFile(join(markdownsDir, MEMORY_FILENAME), memoryText);
	await writeFile(join(markdownsDir, INDEX_FILENAME), indexText);

	const settingsManager = SettingsManager.inMemory({}, { projectTrusted: options.projectTrusted ?? false });
	options.settingsOverrides && settingsManager.applyOverrides(options.settingsOverrides);
	const decoration = new FakeDecoration(documents, config.timeZone);
	const sleepGate = new FakeSleepGate(config.timeZone);
	const reload = new FakeReload();
	const health = new FakeHealth();
	const heartbeat = new FakeHeartbeat();
	const telemetry = new FakeTelemetry();
	const events = new FakeEvents();
	const memory = new FakeMemory(documents);
	const services: PiWorkerServices = {
		memory,
		documents,
		decoration,
		sleep: sleepGate,
		preflight: { preflight: async (candidateId?: string) => await reload.preflight(candidateId) },
		reload,
		health: { record: async (observation: HealthTurnObservation) => await health.record(observation) },
		heartbeat,
		telemetry,
	};

	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 128_000, maxTokens: 16_384 }],
	});
	const modelRuntime = await ModelRuntime.create({
		refreshOnCreate: false,
		allowModelNetwork: false,
		modelsPath: null,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("faux", "faux-key");
	if (options.withWebProvider !== false) {
		modelRuntime.registerProvider("openai", {
			baseUrl: "https://fake-openai.invalid/v1",
			apiKey: "fake-openai-key",
			api: "openai-responses",
			models: [
				{
					id: "gpt-5-web-test",
					name: "Fake web model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 16_384,
				},
			],
		});
		await modelRuntime.setRuntimeApiKey("openai", "fake-openai-key");
		await modelRuntime.getAvailable().catch(() => []);
	}

	const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
	const environment: TestEnvironment = {
		root,
		cwd,
		agentDir,
		markdownsDir,
		stateDir,
		homesDir,
		config,
		manualPrompt,
		settingsManager,
		documents,
		memory,
		decoration,
		sleepGate,
		reload,
		health,
		heartbeat,
		telemetry,
		events,
		faux,
		modelRuntime,
		model: faux.getModel(),
		services,
		sessionManager,
		approvedExtensionPaths: [...(options.approvedExtensionPaths ?? [])],
		worker: undefined,
		session: undefined,
		async seedSkill(name, description, scope) {
			return await writeSkillFixture(scope === "global" ? join(agentDir, "skills") : join(cwd, ".pi", "skills"), name, description);
		},
		async writeTextFile(relative, content) {
			const path = join(cwd, relative);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content);
			return path;
		},
		async writeExtension(filename, source) {
			const dir = join(root, "extensions");
			await mkdir(dir, { recursive: true });
			const path = join(dir, filename);
			await writeFile(path, source);
			return path;
		},
		async startWorker(overrides: StartWorkerOptions = {}) {
			if (overrides.approvedExtensionPaths !== undefined) {
				environment.approvedExtensionPaths = [...overrides.approvedExtensionPaths];
			}
			const worker = await createPiWorker({
				config,
				manualPrompt,
				cwd,
				agentDir,
				model: faux.getModel(),
				modelRuntime,
				settingsManager,
				sessionManager: overrides.sessionManager ?? sessionManager,
				services,
				events,
				approvedExtensionPaths: overrides.approvedExtensionPaths ?? environment.approvedExtensionPaths,
				...(overrides.extensionFactories === undefined ? {} : { extensionFactories: overrides.extensionFactories }),
				...(overrides.toolMiddleware === undefined ? {} : { toolMiddleware: overrides.toolMiddleware }),
			});
			environment.worker = worker;
			environment.session = worker.session;
			return worker;
		},
		async cleanup() {
			await environment.worker?.stop("test-cleanup").catch(() => {});
			environment.worker = undefined;
			environment.session = undefined;
			await rm(root, { recursive: true, force: true });
			for (const [key, value] of Object.entries(previousEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
	return environment;
}

export async function createTestWorkspace(options: TestWorkspaceOptions = {}): Promise<TestWorkspace> {
	const environment = await createTestEnvironment(options);
	try {
		await environment.startWorker({
			...(options.toolMiddleware === undefined ? {} : { toolMiddleware: options.toolMiddleware }),
			...(options.extensionFactories === undefined
				? {}
				: { extensionFactories: options.extensionFactories }),
			...(options.sessionManager === undefined ? {} : { sessionManager: options.sessionManager }),
			...(options.approvedExtensionPaths === undefined
				? {}
				: { approvedExtensionPaths: options.approvedExtensionPaths }),
		});
		return environment as unknown as TestWorkspace;
	} catch (error) {
		await environment.cleanup();
		throw error;
	}
}

export function assistantText(text: string): AssistantMessage {
	return fauxAssistantMessage(text);
}

export function assistantToolCalls(
	calls: Array<{ name: string; arguments: Record<string, unknown>; id?: string }>,
	options: { stopReason?: AssistantMessage["stopReason"]; text?: string } = {},
): AssistantMessage {
	const content = [
		...(options.text === undefined ? [] : [fauxText(options.text)]),
		...calls.map((call) => fauxToolCall(call.name, call.arguments as never, { id: call.id })),
	];
	return fauxAssistantMessage(content, {
		...(options.stopReason === undefined ? {} : { stopReason: options.stopReason }),
	});
}

export interface QueueResult {
	readonly captured: TranscriptContext[];
	readonly callTimes: number[];
}

export function queueResponses(
	environment: TestEnvironment,
	steps: Array<
		AssistantMessage |
		((call: { index: number; context: TranscriptContext }) => AssistantMessage | Promise<AssistantMessage>)
	>,
): QueueResult {
	const captured: TranscriptContext[] = [];
	const callTimes: number[] = [];
	let index = 0;
	environment.faux.setResponses(
		steps.map((step) => (context: TranscriptContext) => {
			const current = index++;
			captured.push(context);
			callTimes.push(Date.now());
			return typeof step === "function" ? step({ index: current, context }) : step;
		}),
	);
	return { captured, callTimes };
}

export function systemTextOf(context: TranscriptContext): string {
	return context.messages
		.filter((message) => message.role === "system")
		.map((message) => {
			const text = typeof message.content === "string" ? message.content : "";
			const sections = Object.values(message.sections ?? {}).filter(
				(part): part is string => typeof part === "string" && part.length > 0,
			);
			return [text, ...sections].filter((part) => part.length > 0).join("\n\n");
		})
		.join("\n\n");
}

export function toolResultMessages(context: TranscriptContext): Array<{
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError: boolean;
	details?: unknown;
	usage?: unknown;
}> {
	return context.messages.filter((message) => message.role === "toolResult") as never;
}

export function withMockFetch(
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: Array<{ url: string; init?: RequestInit }>; restore: () => void } {
	const original = globalThis.fetch;
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: typeof input === "object" && input !== null && "url" in input
						? String((input as { url: unknown }).url)
						: String(input);
		calls.push({ url, ...(init === undefined ? {} : { init }) });
		return await handler(url, init);
	}) as typeof fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

export { MAX_MANAGED_DOCUMENTS, MAX_MCP_SERVERS, MAX_SKILLS };
