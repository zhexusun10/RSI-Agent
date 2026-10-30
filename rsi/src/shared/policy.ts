import { RsiError } from "./errors.ts";

/** Fixed product limits. They are intentionally not configurable upward. */
export const MEMORY_MAX_WORDS = 500;
export const MANAGED_DOCUMENT_MAX_WORDS = 1_000;
export const MAX_MANAGED_DOCUMENTS = 20;
export const MAX_MCP_SERVERS = 5;
export const MAX_SKILLS = 5;
export const HEALTHY_TURNS_REQUIRED = 3;
export const PREFLIGHT_MOCK_LOAD_TIMEOUT_MS = 3_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_IPC_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_IPC_MAX_FRAME_BYTES = 1_048_576;
export const MAX_IPC_MAX_FRAME_BYTES = 4_194_304;
export const MIN_IPC_MAX_FRAME_BYTES = 4_096;

/**
 * Pi command names that the active agent must never invoke directly.
 *
 * This is deliberately narrow: /reload is routed through the external gate and
 * ordinary headless Pi commands, package installation and MCP CLI operations are
 * forwarded. Only process termination, model/thinking changes and equivalent
 * active-session replacement controls are forbidden here.
 */
export const FORBIDDEN_AGENT_CONTROL_COMMANDS = [
	"quit",
	"exit",
	"model",
	"thinking",
	"new",
	"resume",
	"fork",
	"clone",
	"tree",
	"session",
] as const;

export type ForbiddenAgentControlCommand = (typeof FORBIDDEN_AGENT_CONTROL_COMMANDS)[number];

/** The agent loop only submits ordinary text, never Pi command/template expansion. */
export interface AgentPromptPolicy {
	readonly expandPromptTemplates: false;
	readonly rejectLeadingSlash: true;
}

export const AGENT_PROMPT_POLICY: AgentPromptPolicy = Object.freeze({
	expandPromptTemplates: false,
	rejectLeadingSlash: true,
});

/**
 * Reject a loop-originated prompt that could reach Pi's command dispatcher.
 *
 * This is a prompt-path guard, not an OS sandbox. Command calls from the trusted
 * Supervisor use the separate control channel and never pass through this guard.
 */
export function assertAgentPromptAllowed(text: string): void {
	if (text.trimStart().startsWith("/")) {
		throw new RsiError(
			"AGENT_COMMAND_FORBIDDEN",
			"Agent-originated prompts must not begin with '/' or invoke Pi command/control entry points.",
		);
	}
}

/** Validate the product-level MCP and Skill caps without changing Pi's native discovery rules. */
export function assertResourceCaps(input: { mcpServerCount: number; skillCount: number }): void {
	if (!Number.isInteger(input.mcpServerCount) || input.mcpServerCount < 0) {
		throw new RsiError("RESOURCE_CAP_EXCEEDED", "mcpServerCount must be a non-negative integer.");
	}
	if (!Number.isInteger(input.skillCount) || input.skillCount < 0) {
		throw new RsiError("RESOURCE_CAP_EXCEEDED", "skillCount must be a non-negative integer.");
	}
	if (input.mcpServerCount > MAX_MCP_SERVERS) {
		throw new RsiError("RESOURCE_CAP_EXCEEDED", `At most ${MAX_MCP_SERVERS} MCP servers may be configured.`);
	}
	if (input.skillCount > MAX_SKILLS) {
		throw new RsiError("RESOURCE_CAP_EXCEEDED", `At most ${MAX_SKILLS} Skills may be configured.`);
	}
}
