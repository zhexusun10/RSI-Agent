import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { RsiError } from "./errors.ts";
import type { MemorySnapshot } from "./memory.ts";

export const MEMORY_SYSTEM_SECTION = "memory";

/** Pi-owned prompt sections; candidate extensions cannot add arbitrary system sections. */
const ALLOWED_SYSTEM_SECTIONS = new Set([
	"preamble",
	"tools",
	"rules",
	"docs",
	"addendum",
	"project_context",
	"skills",
	"cwd",
	MEMORY_SYSTEM_SECTION,
]);

/**
 * Build the request-local transcript used by Pi's `context_with_system` hook.
 *
 * The latest Memory is written into the leading system message's named section,
 * never appended as a user/assistant/tool message. All current system messages
 * are replayed first so prompt sections and tool declarations survive, then
 * collapsed into one leading system message so a stale Memory section cannot
 * win later in the transcript. The input array and its messages are not mutated.
 */
export function injectMemoryAtRequestBoundary(
	messages: readonly AgentMessage[],
	memory: Pick<MemorySnapshot, "content">,
	manualSystemPrompt?: string,
): AgentMessage[] {
	const head = getCurrentSystemMessage(messages);
	if (!head && manualSystemPrompt === undefined) {
		throw new RsiError(
			"INTERNAL",
			"Pi request has no leading system message; refusing to inject Memory outside the system position.",
		);
	}
	const base: SystemMessage = head ?? {
		role: "system",
		content: "",
		timestamp: Date.now(),
	};
	const sourceSections =
		manualSystemPrompt === undefined
			? (base.sections ?? {})
			: Object.fromEntries(
					Object.entries(base.sections ?? {}).filter(([name]) => ALLOWED_SYSTEM_SECTIONS.has(name)),
				);
	const sections: Record<string, string | null> = {
		...sourceSections,
		...(manualSystemPrompt === undefined ? {} : { preamble: manualSystemPrompt }),
		[MEMORY_SYSTEM_SECTION]: memory.content,
	};
	const nextHead: SystemMessage = {
		...base,
		content: manualSystemPrompt === undefined ? base.content : "",
		sections,
		timestamp: base.timestamp,
	};
	return [nextHead, ...messages.filter((message) => message.role !== "system")];
}

/**
 * Contract reminder used by the Worker extension wiring:
 * - load Memory inside `context_with_system`, once per model request;
 * - do not rely on `before_agent_start`, which runs per agent run, not per request;
 * - never persist the request-local decorated transcript.
 */
export interface RequestBoundaryMemorySource {
	readCurrentMemory(signal?: AbortSignal): Promise<MemorySnapshot>;
}
