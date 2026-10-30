import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolResultDecorationRequest } from "../shared/ipc/protocol.ts";
import type { ToolResultDecorationPort } from "../shared/ports.ts";
import type { Clock } from "../shared/time.ts";
import { formatCurrentTimeSuffix } from "../shared/time.ts";
import {
	appendToolResultText,
	composeToolResultSuffix,
	hasCurrentTimeSuffix,
	stripEmbeddedCurrentTime,
} from "../shared/tool-result.ts";
import { stripRuntimeMetadataFromContent } from "../knowledge/tool-result.ts";
import type { ManagedToolRuntime } from "./managed-tools.ts";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

export interface ToolResultFinalizerOptions {
	readonly decoration: ToolResultDecorationPort;
	readonly managedTools: ManagedToolRuntime;
	readonly clock: Clock;
	readonly timeZone: string;
	readonly onDecorationError?: (error: unknown) => void;
}

/**
 * Finalize model-facing tool results at Pi's finalized-message boundary.
 *
 * `tool_result` runs only when an execution reaches afterToolCall. Unknown tools,
 * schema validation failures, blocked calls, and aborted calls are finalized as
 * immediate tool-result messages without that hook. `message_end` for role
 * `toolResult` is the real boundary that covers every top-level result exactly once.
 * Nested calls never become messages, so their `tool_result` event is finalized
 * separately and retains structured content.
 */
export class ToolResultFinalizer {
	private readonly decoration: ToolResultDecorationPort;
	private readonly managedTools: ManagedToolRuntime;
	private readonly clock: Clock;
	private readonly timeZone: string;
	private readonly onDecorationError: ((error: unknown) => void) | undefined;

	constructor(options: ToolResultFinalizerOptions) {
		this.decoration = options.decoration;
		this.managedTools = options.managedTools;
		this.clock = options.clock;
		this.timeZone = options.timeZone;
		this.onDecorationError = options.onDecorationError;
	}

	async finalizeMessage(
		message: Extract<ToolResultMessage, { role: "toolResult" }>,
		input: Readonly<Record<string, unknown>> | undefined,
		signal?: AbortSignal,
	): Promise<Extract<ToolResultMessage, { role: "toolResult" }>> {
		const suffix = await this.suffixFor({
			toolName: message.toolName,
			toolCallId: message.toolCallId,
			input,
			content: message.content,
			isError: message.isError,
			details: message.details,
			signal,
		});
		const cleaned = stripEmbeddedCurrentTime(
			stripRuntimeMetadataFromContent(message.content),
		);
		return {
			...message,
			content: appendToolResultText(cleaned, suffix),
		};
	}

	async finalizeNested(
		event: ToolResultEvent,
		signal?: AbortSignal,
	): Promise<ToolResultEventResult | undefined> {
		const suffix = await this.suffixFor({
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			input: event.input,
			content: event.content,
			isError: event.isError,
			details: event.details,
			signal,
		});
		return {
			content: appendToolResultText(
				stripRuntimeMetadataFromContent(event.content),
				suffix,
			),
			details: event.details,
			...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
			isError: event.isError,
			...(event.usage === undefined ? {} : { usage: event.usage }),
		};
	}

	private async suffixFor(input: {
		readonly toolName: string;
		readonly toolCallId: string;
		readonly input: Readonly<Record<string, unknown>> | undefined;
		readonly content: readonly (TextContent | import("@earendil-works/pi-ai").ImageContent)[];
		readonly isError: boolean;
		readonly details: unknown;
		readonly signal?: AbortSignal;
	}): Promise<string> {
		const now = this.clock.now();
		const read = input.toolName === "read" && !input.isError
			? await this.managedTools.classifyRead(input.input?.path)
			: null;
		const memoryUsage = this.managedTools.takeMemoryUsage(
			input.toolName,
			input.input ?? {},
			input.isError,
			input.toolCallId,
		);
		const request: ToolResultDecorationRequest = {
			toolName: input.toolName,
			toolCallId: input.toolCallId,
			isError: input.isError,
			readName: read?.name ?? null,
			indexRead: read?.indexRead ?? false,
			...(memoryUsage === undefined ? {} : { memoryUsage }),
		};
		try {
			const result = await this.decoration.decorate(request, now, input.signal);
			if (result.appendText.trim().length > 0) {
				const parts = [result.indexReport, result.appendText].filter(
					(part): part is string => typeof part === "string" && part.length > 0,
				);
				const composed = parts.join("\n\n");
				const decorated: TextContent[] = [{ type: "text", text: composed }];
				if (hasCurrentTimeSuffix(decorated)) return composed;
				return `${composed}\n\n${formatCurrentTimeSuffix(now, this.timeZone)}`;
			}
			return composeToolResultSuffix({
				indexReport: result.indexReport,
				memoryUsage,
				warnings: result.warnings,
				now,
				timeZone: this.timeZone,
			});
		} catch (error) {
			this.onDecorationError?.(error);
			const message = error instanceof Error ? error.message : String(error);
			return composeToolResultSuffix({
				warnings: [`[System Meta: Decoration Warning: ${message}]`],
				now,
				timeZone: this.timeZone,
			});
		}
	}
}
