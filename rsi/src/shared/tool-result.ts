import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { CURRENT_TIME_SUFFIX_PATTERN, currentTimeSuffix } from "./time.ts";

export type ToolResultContent = TextContent | ImageContent;

const TRAILING_TIME_SUFFIX = /\n{0,2}\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)\s*$/u;
const EMBEDDED_TIME_SUFFIX = /[ \t]*\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)[ \t]*/gu;

/** Remove an earlier decoration when multiple handlers run; no other text is altered. */
export function stripTrailingCurrentTime(text: string): string {
	return text.replace(TRAILING_TIME_SUFFIX, "");
}

/** Remove Runtime time lines anywhere in a flattened nested text block. */
export function stripEmbeddedCurrentTime(
	content: readonly ToolResultContent[],
): ToolResultContent[] {
	return content.map((block) =>
		block.type === "text"
			? {
					...block,
					text: block.text
						.replace(EMBEDDED_TIME_SUFFIX, "")
						.replace(/[ 	]+$/u, ""),
				}
			: block,
	);
}

/** Append model-facing text while preserving images and tool result content order. */
export function appendToolResultText(
	content: readonly ToolResultContent[],
	text: string,
): ToolResultContent[] {
	if (text.length === 0) return [...content];
	const last = content[content.length - 1];
	if (last?.type === "text") {
		const base = stripTrailingCurrentTime(last.text);
		const separator = base.length === 0 ? "" : "\n\n";
		return [...content.slice(0, -1), { ...last, text: `${base}${separator}${text}` }];
	}
	return [...content, { type: "text", text }];
}

export interface ToolResultSuffixInput {
	readonly indexReport?: string | null;
	readonly memoryUsage?: string | null;
	readonly warnings?: readonly string[];
	readonly now: Date;
	readonly timeZone: string;
}

/**
 * Canonical decoration order: dynamic index report, Memory usage metadata,
 * index warnings, then the final Current Time line. Only plain metadata is
 * appended; no agent policy or prompt text is generated here.
 */
export function composeToolResultSuffix(input: ToolResultSuffixInput): string {
	const parts: string[] = [];
	if (input.indexReport) parts.push(input.indexReport);
	if (input.memoryUsage) parts.push(input.memoryUsage);
	for (const warning of input.warnings ?? []) {
		if (warning.length > 0) parts.push(warning);
	}
	parts.push(currentTimeSuffix(input.now, input.timeZone));
	return parts.join("\n\n");
}

/** Apply the final suffix exactly once, replacing an older trailing time suffix if present. */
export function decorateToolResultContent(
	content: readonly ToolResultContent[],
	suffix: string,
): ToolResultContent[] {
	return appendToolResultText(content, suffix);
}

/** Validate that the final model-facing text block ends with the required time line. */
export function hasCurrentTimeSuffix(content: readonly ToolResultContent[]): boolean {
	const last = content[content.length - 1];
	if (last?.type !== "text") return false;
	return new RegExp(`${CURRENT_TIME_SUFFIX_PATTERN.source}\\s*$`, "u").test(last.text);
}
