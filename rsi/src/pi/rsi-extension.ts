import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionFactory,
	type ToolResultEvent,
	type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { assertAgentPromptAllowed } from "../shared/policy.ts";
import type { ToolMiddlewarePort } from "../shared/ports.ts";
import type { ManagedToolRuntime } from "./managed-tools.ts";
import type { RequestContextAdapter } from "./request-context.ts";
import type { SleepController } from "./sleep.ts";
import { createSleepTool } from "./sleep.ts";
import type { ToolResultFinalizer } from "./tool-result-finalizer.ts";
export interface RsiExtensionOptions {
	readonly cwd: string;
	readonly managedTools: ManagedToolRuntime;
	readonly requestContext: RequestContextAdapter;
	readonly sleep: SleepController;
	readonly finalizer: ToolResultFinalizer;
	readonly middleware?: ToolMiddlewarePort;
	readonly onDiagnostic?: (message: string) => void;
	readonly onNestedResult?: (event: ToolResultEvent) => void;
	readonly onToolInput?: (toolCallId: string, input: Record<string, unknown>) => void;
	readonly onAgentSettled?: (aborted: boolean) => Promise<void> | void;
}

const MAX_TRACKED_TOOL_INPUTS = 2_000;

function toRecord(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

function withManagedToolCall<T extends { execute: (...args: any[]) => any }>(
	definition: T,
	managedTools: ManagedToolRuntime,
): T {
	return {
		...definition,
		execute: async (...args: any[]) => {
			const toolCallId = String(args[0] ?? "");
			return await managedTools.runInToolCall(toolCallId, () =>
				definition.execute.apply(definition, args),
			);
		},
	} as T;
}

/**
 * The single RSI extension installed in the untrusted Worker.
 *
 * It registers Pi's native read/write/edit definitions with broker-aware I/O,
 * adds only the explicit sleep tool, refreshes Memory at the real
 * provider request boundary, and finalizes every tool result at the finalized
 * message boundary.
 */
export function createRsiExtension(options: RsiExtensionOptions): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const toolInputs = new Map<string, Record<string, unknown>>();

		const rememberInput = (toolCallId: string, input: unknown): Record<string, unknown> => {
			const record = structuredClone(toRecord(input));
			toolInputs.set(toolCallId, record);
			if (toolInputs.size > MAX_TRACKED_TOOL_INPUTS) {
				const first = toolInputs.keys().next().value;
				if (first !== undefined) toolInputs.delete(first);
			}
			options.onToolInput?.(toolCallId, record);
			return record;
		};

		pi.registerTool(
			withManagedToolCall(
				createReadToolDefinition(options.cwd, {
					operations: options.managedTools.operations.read,
				}),
				options.managedTools,
			),
		);
		pi.registerTool(
			withManagedToolCall(
				createWriteToolDefinition(options.cwd, {
					operations: options.managedTools.operations.write,
				}),
				options.managedTools,
			),
		);
		pi.registerTool(
			withManagedToolCall(
				createEditToolDefinition(options.cwd, {
					operations: options.managedTools.operations.edit,
				}),
				options.managedTools,
			),
		);
		pi.registerTool(createSleepTool(options.sleep));

		pi.on("input", (event) => {
			try {
				assertAgentPromptAllowed(event.text);
				return;
			} catch (error) {
				options.onDiagnostic?.(error instanceof Error ? error.message : String(error));
				return { action: "handled" };
			}
		});

		pi.on("context_with_system", async (event, ctx) => {
			return await options.requestContext.handle(event, ctx.signal);
		});

		pi.on("tool_call", async (event) => {
			const input = rememberInput(event.toolCallId, event.input);
			if (!options.middleware) return;
			const decision = await options.middleware.beforeToolCall({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				input,
				cwd: options.cwd,
			});
			if (decision.action === "block") {
				return {
					block: true,
					reason: decision.reason,
					...(decision.terminate === undefined ? {} : { terminate: decision.terminate }),
				};
			}
			return;
		});

		// Nested calls never become transcript messages. Finalize them at their
		// real tool_result boundary and keep structured content/details/usage.
		pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | undefined> => {
			if (event.parentToolCallId === undefined) return undefined;
			toolInputs.delete(event.toolCallId);
			let current: ToolResultEvent = event;
			if (options.middleware) {
				const patch = await options.middleware.afterToolResult(
					{
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						input: event.input,
						content: event.content,
						isError: event.isError,
						details: event.details,
					},
					ctx.signal,
				);
				current = {
					...event,
					content: patch.content ?? event.content,
					details: patch.details ?? event.details,
					isError: patch.isError ?? event.isError,
					...(patch.structuredContent === undefined
						? event.structuredContent === undefined
							? {}
							: { structuredContent: event.structuredContent }
						: { structuredContent: patch.structuredContent }),
				} as ToolResultEvent;
			}
			const finalized = await options.finalizer.finalizeNested(current, ctx.signal);
			options.onNestedResult?.(
				finalized?.content === undefined ? current : ({ ...current, content: finalized.content } as ToolResultEvent),
			);
			return finalized;
		});

		// Top-level tool results are finalized here. Immediate outcomes (unknown
		// tool, validation failure, blocked/aborted call) never reach tool_result,
		// but every one of them emits message_end.
		pi.on("message_end", async (event, ctx) => {
			if (event.message.role !== "toolResult") return;
			if (!("toolCallId" in event.message)) return;
			const toolCallId = event.message.toolCallId;
			const input = toolInputs.get(toolCallId);
			toolInputs.delete(toolCallId);
			let message = event.message;
			if (options.middleware) {
				const patch = await options.middleware.afterToolResult(
					{
						toolCallId,
						toolName: message.toolName,
						input: input ?? {},
						content: message.content,
						isError: message.isError,
						details: message.details,
					},
					ctx.signal,
				);
				message = {
					...message,
					content: patch.content === undefined ? [...message.content] : [...patch.content],
					...(patch.details === undefined ? {} : { details: patch.details as never }),
					...(patch.isError === undefined ? {} : { isError: patch.isError }),
				};
			}
			const finalized = await options.finalizer.finalizeMessage(message, input, ctx.signal);
			return { message: finalized };
		});

		pi.on("agent_settled", async (event) => {
			await options.onAgentSettled?.(event.aborted);
		});

		pi.on("session_start", () => {
			toolInputs.clear();
		});
		pi.on("session_shutdown", () => {
			toolInputs.clear();
		});
	};
}
