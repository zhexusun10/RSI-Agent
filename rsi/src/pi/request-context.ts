import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { MemoryPort, SleepGatePort } from "../shared/ports.ts";
import { injectMemoryAtRequestBoundary } from "../shared/memory-context.ts";
import type { MemorySnapshot } from "../shared/memory.ts";
import type { SleepState } from "../shared/sleep.ts";
import { isSleepDue } from "../shared/sleep.ts";
import type { Clock } from "../shared/time.ts";

export interface SleepWaiter {
	/** Wait until the current explicit sleep is no longer blocking, without blocking the event loop. */
	waitUntilReady(signal?: AbortSignal): Promise<void>;
	status(): Promise<SleepState | null>;
	markWoke(state: SleepState): Promise<void>;
	cancel(reason: string): void;
}

export interface RequestContextOptions {
	readonly memory: MemoryPort;
	readonly manualSystemPrompt: string;
	readonly sleepGate: SleepGatePort;
	readonly sleepWaiter: SleepWaiter;
	readonly clock: Clock;
	readonly onMemory?: (snapshot: MemorySnapshot) => void;
	readonly onProviderRequest?: () => void;
	readonly onError?: (error: unknown) => void;
}

/**
 * Install the per-provider-request context transform.
 *
 * It runs on every request, not once per run: initial turns, the next request
 * after a tool call, native retries, compaction follow-ups, reloads, and resumed
 * sessions all pass through here. Memory is fetched after the sleep gate and
 * written into the leading system message's named section, never as a
 * user/assistant/tool history message.
 */
export class RequestContextAdapter {
	private readonly options: RequestContextOptions;
	private readonly beforeAgentStartPatched = new WeakSet<object>();

	constructor(options: RequestContextOptions) {
		this.options = options;
	}

	async handle(event: ContextWithSystemEvent, signal?: AbortSignal): Promise<{ messages: AgentMessage[] }> {
		await this.options.sleepWaiter.waitUntilReady(signal);
		const memory = await this.options.memory.readCurrentMemory(signal);
		this.options.onMemory?.(memory);
		const head = getCurrentSystemMessage(event.messages);
		if (!head) {
			throw new Error(
				"Pi request has no leading system message; Memory cannot be injected outside the system position.",
			);
		}
		return {
			messages: injectMemoryAtRequestBoundary(
				event.messages,
				memory,
				this.options.manualSystemPrompt,
			),
		};
	}

	/**
	 * Final provider-request boundary. Pi calls `prepareRequest` after every
	 * extension's `context_with_system` handler, immediately before the provider
	 * stream. Reasserting the human prompt here prevents a candidate extension's
	 * `before_agent_start` or context hook from replacing or extending it.
	 */
	async enforceProviderRequest(
		messages: readonly AgentMessage[],
		signal?: AbortSignal,
		trustedMessages: readonly AgentMessage[] = messages,
	): Promise<AgentMessage[]> {
		await this.options.sleepWaiter.waitUntilReady(signal);
		const memory = await this.options.memory.readCurrentMemory(signal);
		this.options.onMemory?.(memory);
		// Rebuild the system message from the transcript *before* extension
		// context handlers ran. The transformed messages may contain arbitrary
		// candidate sections; only their non-system content is allowed through.
		const trusted = injectMemoryAtRequestBoundary(
			trustedMessages,
			memory,
			this.options.manualSystemPrompt,
		);
		const next = [trusted[0]!, ...messages.filter((message) => message.role !== "system")];
		this.options.onProviderRequest?.();
		return next;
	}

	installProviderBoundary(session: AgentSession): void {
		this.installBeforeAgentStartBoundary(session);
		const agent = session.agent as unknown as {
			transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> | AgentMessage[];
			onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown>;
		};
		if ((agent as unknown as { __rsiProviderBoundary?: boolean }).__rsiProviderBoundary !== true) {
			(agent as unknown as { __rsiProviderBoundary?: boolean }).__rsiProviderBoundary = true;
			const previous = agent.transformContext;
			agent.transformContext = async (messages, signal) => {
				// Snapshot the system message before a candidate handler can mutate
				// it in place; context_with_system is allowed to return changes but
				// not to alter the trusted transcript object.
				const trusted = snapshotSystemMessage(messages);
				const transformed = previous === undefined ? messages : await previous(messages, signal);
				return await this.enforceProviderRequest(transformed, signal, trusted);
			};
		}
		if ((agent as unknown as { __rsiProviderPayloadBoundary?: boolean }).__rsiProviderPayloadBoundary === true) {
			return;
		}
		(agent as unknown as { __rsiProviderPayloadBoundary?: boolean }).__rsiProviderPayloadBoundary = true;
		const previousPayload = agent.onPayload;
		agent.onPayload = async (payload, model) => {
			const safe = cloneProviderPayload(payload);
			if (previousPayload === undefined) return safe;
			try {
				// Candidate/trusted provider hooks may mutate or replace the payload.
				// They get an isolated copy; the request always uses the pre-hook copy,
				// which was produced by the trusted final context boundary above.
				await previousPayload(cloneProviderPayload(safe), model);
			} catch (error) {
				this.options.onError?.(error);
			}
			return safe;
		};
	}

	/**
	 * Pi exposes mutable systemPromptOptions to before_agent_start handlers and
	 * then turns them into transcript sections. Native-looking section names do
	 * not make candidate-authored text trusted. Wrap the runner for every new
	 * session/reload generation and restore the pre-handler system fields while
	 * still allowing the normal selected-tool loadout to change.
	 */
	private installBeforeAgentStartBoundary(session: AgentSession): void {
		const runner = (session as unknown as {
			_extensionRunner?: {
				emitBeforeAgentStart?: (
					trigger: unknown,
					options: Record<string, unknown>,
				) => Promise<Record<string, unknown>>;
			};
		})._extensionRunner;
		if (runner === undefined || typeof runner.emitBeforeAgentStart !== "function") return;
		if (this.beforeAgentStartPatched.has(runner)) return;
		this.beforeAgentStartPatched.add(runner);
		const original = runner.emitBeforeAgentStart.bind(runner);
		runner.emitBeforeAgentStart = async (trigger, options) => {
			const trusted = cloneSystemPromptFields(options);
			const result = await original(trigger, options);
			const current = result.systemPromptOptions;
			if (typeof current !== "object" || current === null || Array.isArray(current)) {
				return result;
			}
			return {
				...result,
				systemPromptOptions: restoreTrustedSystemPromptFields(
					current as Record<string, unknown>,
					trusted,
				),
			};
		};
	}
}

const TRUSTED_SYSTEM_PROMPT_FIELDS = [
	"forceSystemPrompt",
	"customPrompt",
	"appendSystemPrompt",
	"promptGuidelines",
	"sections",
	"cwd",
	"contextFiles",
	"skills",
	"toolSnippets",
	"toolGuidelines",
	"hiddenTools",
] as const;

function cloneValue<T>(value: T): T {
	if (value === undefined) return value;
	try {
		return structuredClone(value);
	} catch {
		try {
			return JSON.parse(JSON.stringify(value)) as T;
		} catch {
			return value;
		}
	}
}

function cloneSystemPromptFields(options: Record<string, unknown>): Record<string, unknown> {
	const trusted: Record<string, unknown> = {};
	for (const field of TRUSTED_SYSTEM_PROMPT_FIELDS) trusted[field] = cloneValue(options[field]);
	return trusted;
}

function restoreTrustedSystemPromptFields(
	current: Record<string, unknown>,
	trusted: Record<string, unknown>,
): Record<string, unknown> {
	const restored = { ...current };
	for (const field of TRUSTED_SYSTEM_PROMPT_FIELDS) {
		if (trusted[field] === undefined) delete restored[field];
		else restored[field] = cloneValue(trusted[field]);
	}
	return restored;
}

function snapshotSystemMessage(messages: readonly AgentMessage[]): AgentMessage[] {
	const head = getCurrentSystemMessage(messages);
	if (!head) return [...messages];
	let snapshot: AgentMessage;
	try {
		snapshot = structuredClone(head) as AgentMessage;
	} catch {
		snapshot = {
			...head,
			sections: head.sections === undefined ? undefined : { ...head.sections },
			...(head.toolsAdded === undefined ? {} : { toolsAdded: head.toolsAdded.map((tool) => ({ ...tool })) }),
			...(head.toolsRemoved === undefined ? {} : { toolsRemoved: [...head.toolsRemoved] }),
		} as AgentMessage;
	}
	return [snapshot, ...messages.filter((message) => message.role !== "system")];
}

function cloneProviderPayload(value: unknown): unknown {
	if (value === undefined) return value;
	try {
		return structuredClone(value);
	} catch {
		try {
			return JSON.parse(JSON.stringify(value)) as unknown;
		} catch (error) {
			throw new Error("Provider payload is not isolatable; refusing to send extension-mutated data.", {
				cause: error,
			});
		}
	}
}

/** Timer-based waiter for the external explicit sleep state. */
export class TimedSleepWaiter implements SleepWaiter {
	private readonly gate: SleepGatePort;
	private readonly clock: Clock;
	private readonly onWake: (state: SleepState) => void;
	private readonly waiters = new Set<() => void>();
	private cancelled = false;
	private cancelReason: string | undefined;

	constructor(options: {
		gate: SleepGatePort;
		clock: Clock;
		onWake?: (state: SleepState) => void;
	}) {
		this.gate = options.gate;
		this.clock = options.clock;
		this.onWake = options.onWake ?? (() => {});
	}

	cancel(reason: string): void {
		this.cancelled = true;
		this.cancelReason = reason;
		for (const resolve of [...this.waiters]) resolve();
		this.waiters.clear();
	}

	async status(): Promise<SleepState | null> {
		return await this.gate.status();
	}

	async markWoke(state: SleepState): Promise<void> {
		this.onWake(state);
	}

	async waitUntilReady(signal?: AbortSignal): Promise<void> {
		this.cancelled = false;
		this.cancelReason = undefined;
		for (;;) {
			const state = await this.status();
			if (!state || state.status !== "active") return;
			if (this.cancelled) {
				throw new Error(`Sleep cancelled: ${this.cancelReason ?? "external cancellation"}`);
			}
			const now = this.clock.now();
			if (isSleepDue(state, now)) {
				await this.markWoke(state);
				return;
			}
			await this.delay(Math.max(1, Math.min(state.deadlineMs - now.getTime(), 2_147_483_647)), signal);
			if (this.cancelled) {
				throw new Error(`Sleep cancelled: ${this.cancelReason ?? "external cancellation"}`);
			}
		}
	}

	private async delay(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw signal.reason ?? new Error("Sleep wait aborted");
		}
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: unknown): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.waiters.delete(onCancel);
				if (error === undefined) resolve();
				else reject(error);
			};
			const onCancel = (): void => finish();
			const onAbort = (): void => finish(signal?.reason ?? new Error("Sleep wait aborted"));
			const timer = setTimeout(() => finish(), ms);
			this.waiters.add(onCancel);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}
