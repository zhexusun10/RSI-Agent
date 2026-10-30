import type { AgentSession, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { RsiError } from "../shared/errors.ts";
import { FORBIDDEN_AGENT_CONTROL_COMMANDS } from "../shared/policy.ts";

export type GuardedSession = AgentSession & {
	reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void>;
	setModel(...args: never[]): Promise<void>;
	setThinkingLevel(...args: never[]): void;
	cycleModel(...args: never[]): Promise<unknown>;
};

export interface ControlGuardBindings {
	readonly reload: () => Promise<void>;
	readonly waitForIdle: () => Promise<void>;
	readonly onForbidden: (operation: string) => void;
}

const PROVIDER_MUTATION_METHODS = [
	"registerProvider",
	"unregisterProvider",
	"registerNativeProvider",
	"registerVirtualModel",
	"unregisterVirtualModel",
] as const;

type ProviderMutationMethod = (typeof PROVIDER_MUTATION_METHODS)[number];

type ProviderMutationAttempt = {
	readonly operation: ProviderMutationMethod;
	readonly target?: string;
};

type PendingProviderMutation = {
	readonly operation: ProviderMutationMethod;
	readonly target: string;
	readonly extensionPath: string;
};

const FORBIDDEN_CONTROL = new Set<string>([
	...FORBIDDEN_AGENT_CONTROL_COMMANDS,
	"set_model",
	"set_thinking_level",
	"setModel",
	"setThinkingLevel",
	"cycle",
	"shutdown",
	"quit",
	"exit",
]);

export function isForbiddenAgentControl(command: string): boolean {
	const normalized = command.trim().replace(/^\//, "");
	return FORBIDDEN_CONTROL.has(normalized) || FORBIDDEN_CONTROL.has(normalized.toLowerCase());
}

function providerMutationTarget(operation: ProviderMutationMethod, args: readonly unknown[]): string | undefined {
	const first = args[0];
	if (operation === "registerProvider" || operation === "unregisterProvider") {
		if (typeof first === "string") return first;
		if (typeof first === "object" && first !== null) {
			const id = (first as { id?: unknown }).id;
			if (typeof id === "string") return id;
		}
		return undefined;
	}
	if (operation === "registerNativeProvider") {
		if (typeof first === "object" && first !== null) {
			const id = (first as { id?: unknown }).id;
			if (typeof id === "string") return id;
		}
		return undefined;
	}
	if (operation === "registerVirtualModel") {
		if (typeof first === "object" && first !== null) {
			const definition = first as { provider?: unknown; id?: unknown };
			if (typeof definition.provider === "string" && typeof definition.id === "string") {
				return `${definition.provider}/${definition.id}`;
			}
		}
		return undefined;
	}
	if (operation === "unregisterVirtualModel") {
		const provider = args[0];
		const id = args[1];
		if (typeof provider === "string" && typeof id === "string") return `${provider}/${id}`;
		return typeof provider === "string" ? provider : undefined;
	}
	return undefined;
}

/**
 * Pi queues provider registrations made by extension factories and only flushes
 * them when bindCore runs. Reject the queue itself before a candidate runtime
 * can reach the live ModelRuntime; inspecting the queue is not a source scan and
 * cannot be evaded by computed access in the extension API.
 */
export function assertNoPendingProviderMutations(loader: Pick<LoadExtensionsResult, "runtime">): void {
	const runtime = loader.runtime;
	const pending: PendingProviderMutation[] = [];
	for (const registration of runtime.pendingProviderRegistrations) {
		pending.push({
			operation: "registerProvider",
			target: registration.name,
			extensionPath: registration.extensionPath,
		});
	}
	for (const registration of runtime.pendingNativeProviderRegistrations) {
		pending.push({
			operation: "registerNativeProvider",
			target: registration.provider.id,
			extensionPath: registration.extensionPath,
		});
	}
	for (const registration of runtime.pendingVirtualModelRegistrations) {
		const { definition } = registration;
		pending.push({
			operation: "registerVirtualModel",
			target: `${definition.provider}/${definition.id}`,
			extensionPath: registration.extensionPath,
		});
	}
	if (pending.length === 0) return;
	throw new RsiError(
		"PLUGIN_MANIFEST_MISMATCH",
		`Extension load attempted provider/model mutation (${pending
			.map((entry) => `${entry.operation}:${entry.target}`)
			.join(", ")}); candidate provider registration is rejected before activation.`,
		{
			details: {
				reason: "provider-mutation-during-extension-load",
				attempts: pending,
			},
		},
	);
}

/**
 * Public binding wrapper around an AgentSession.
 *
 * Pi's extension API binds directly to session methods. The Worker keeps those
 * methods unavailable to anything running inside an active agent run, while the
 * Worker itself opens the guarded operations (reload) only after external
 * preflight. `/quit`, `/model`, `/thinking`, and their API equivalents therefore
 * cannot be reached through command text or an extension API call.
 */
export class SessionControlGuard {
	private readonly patched = new WeakSet<object>();
	private readonly providerPatched = new WeakSet<object>();
	private readonly originalReload = new WeakMap<object, GuardedSession["reload"]>();
	private providerMutationAttempts: ProviderMutationAttempt[] = [];
	private readonly bindings: ControlGuardBindings;

	constructor(bindings: ControlGuardBindings) {
		this.bindings = bindings;
	}

	install(session: AgentSession): void {
		if (this.patched.has(session)) return;
		this.patched.add(session);
		const mutable = session as unknown as GuardedSession;

		this.originalReload.set(session, mutable.reload.bind(session));
		mutable.reload = async (options) => {
			// Every caller, including extension command contexts, passes through
			// the Worker's externally-preflighted reload path.
			void options;
			await this.bindings.reload();
		};

		mutable.setModel = async (..._args: never[]) => {
			this.bindings.onForbidden("set_model");
			throw new RsiError(
				"AGENT_COMMAND_FORBIDDEN",
				"Changing the model is not available to an active agent session.",
			);
		};
		mutable.setThinkingLevel = (..._args: never[]) => {
			this.bindings.onForbidden("set_thinking_level");
			throw new RsiError(
				"AGENT_COMMAND_FORBIDDEN",
				"Changing the thinking level is not available to an active agent session.",
			);
		};
		mutable.cycleModel = async (..._args: never[]) => {
			this.bindings.onForbidden("cycle_model");
			throw new RsiError(
				"AGENT_COMMAND_FORBIDDEN",
				"Cycling models is not available to an active agent session.",
			);
		};
	}

	commandContextActions(): {
		waitForIdle: () => Promise<void>;
		newSession: () => Promise<{ cancelled: boolean }>;
		fork: () => Promise<{ cancelled: boolean }>;
		navigateTree: () => Promise<{ cancelled: boolean }>;
		switchSession: () => Promise<{ cancelled: boolean }>;
		reload: () => Promise<void>;
	} {
		const reject = (name: string): never => {
			this.bindings.onForbidden(name);
			throw new RsiError(
				"AGENT_COMMAND_FORBIDDEN",
				`Session replacement (${name}) is not available to an active agent session.`,
			);
		};
		return {
			waitForIdle: async () => await this.bindings.waitForIdle(),
			newSession: async () => reject("new_session"),
			fork: async () => reject("fork"),
			navigateTree: async () => reject("navigate_tree"),
			switchSession: async () => reject("switch_session"),
			reload: async () => await this.bindings.reload(),
		};
	}

	shutdownHandler(): () => void {
		return () => {
			this.bindings.onForbidden("shutdown");
			throw new RsiError(
				"AGENT_COMMAND_FORBIDDEN",
				"Shutdown is not available to an active agent; use trusted Supervisor control.",
			);
		};
	}

	private rejectProviderMutation(operation: ProviderMutationMethod, target?: string): never {
		const attempt: ProviderMutationAttempt = {
			operation,
			...(target === undefined ? {} : { target }),
		};
		this.providerMutationAttempts.push(attempt);
		if (this.providerMutationAttempts.length > 50) this.providerMutationAttempts.shift();
		this.bindings.onForbidden(operation);
		throw new RsiError(
			"AGENT_COMMAND_FORBIDDEN",
			`Changing provider/model resolution (${operation}) is not available to an active agent session.`,
			{ details: { reason: "provider-mutation-rejected", operation, ...(target === undefined ? {} : { target }) } },
		);
	}

	private guardProviderMethods(runtime: object): void {
		if (this.providerPatched.has(runtime)) return;
		this.providerPatched.add(runtime);
		const mutable = runtime as Record<string, unknown>;
		for (const method of PROVIDER_MUTATION_METHODS) {
			// bindCore assigns live implementations during session binding; keep a
			// getter guard so a candidate session_start handler cannot replace it.
			// The same guard is installed on the ModelRuntime itself before any
			// candidate resource load, so a queued bindCore flush cannot reach it.
			const forbidden = (...args: unknown[]): never =>
				this.rejectProviderMutation(method, providerMutationTarget(method, args));
			try {
				Object.defineProperty(mutable, method, {
					configurable: true,
					enumerable: true,
					get: () => forbidden,
					set: () => undefined,
				});
			} catch {
				mutable[method] = forbidden;
			}
		}
	}

	/**
	 * Pi exposes provider registration/unregistration on the extension API after
	 * session bind. Those calls mutate the live ModelRuntime just like setModel;
	 * once a session is bound, block them at the shared runtime object.
	 */
	installProviderApiGuard(runtime: object): void {
		this.guardProviderMethods(runtime);
	}

	/**
	 * Install the same rejection boundary directly on the live ModelRuntime. This
	 * runs before resource discovery, so even a pending registration flushed by
	 * Pi's bindCore or a retained ext-api reference cannot change the operator's
	 * provider, baseUrl, api, auth, virtual models, or selected model route.
	 */
	installModelRuntimeGuard(runtime: object): void {
		this.guardProviderMethods(runtime);
	}

	clearProviderMutationAttempts(): void {
		this.providerMutationAttempts = [];
	}

	/**
	 * Convert an attempted live mutation into a structured reload/bind failure.
	 * The operation itself was already rejected, so this only makes the attempt
	 * visible to the Worker instead of silently accepting the candidate.
	 */
	assertNoProviderMutationAttempts(context: string): void {
		if (this.providerMutationAttempts.length === 0) return;
		const attempts = [...this.providerMutationAttempts];
		this.providerMutationAttempts = [];
		throw new RsiError(
			"AGENT_COMMAND_FORBIDDEN",
			`Provider/model mutation was rejected during ${context}: ${attempts
				.map((entry) => `${entry.operation}${entry.target === undefined ? "" : `:${entry.target}`}`)
				.join(", ")}. The active provider/model route is unchanged.`,
			{ details: { reason: "provider-mutation-rejected", context, attempts } },
		);
	}

	async runOriginalReload(
		session: AgentSession,
		options?: { beforeSessionStart?: () => void | Promise<void> },
	): Promise<void> {
		const original = this.originalReload.get(session);
		if (!original) {
			throw new RsiError("INTERNAL", "Session reload was requested before the control guard was installed.");
		}
		await original(options);
	}
}
