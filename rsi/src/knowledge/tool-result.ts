import { isAbsolute } from "node:path";
import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import { RsiError } from "../shared/errors.ts";
import type { ToolResultDecorationRequest, ToolResultDecorationResult } from "../shared/ipc/protocol.ts";
import { formatMemoryUsage } from "../shared/memory.ts";
import { MEMORY_MAX_WORDS } from "../shared/policy.ts";
import type { ToolMiddlewarePort, ToolResultDecorationPort, ToolResultDescriptor, ToolResultPatch } from "../shared/ports.ts";
import { assertValidTimeZone, currentTimeSuffix, formatCurrentTimeSuffix } from "../shared/time.ts";
import { appendToolResultText } from "../shared/tool-result.ts";
import { formatKnowledgeIndexWarning } from "./index-audit.ts";
import type { KnowledgeService } from "./service.ts";

export const MEMORY_USAGE_LINE_PATTERN = new RegExp(
	`^\\[System Meta: Current Memory Usage: \\d+ / ${MEMORY_MAX_WORDS} words\\]$`,
	"u",
);

const RUNTIME_METADATA_LINE =
	/^\[System Meta: (?:Current Memory Usage: \d+ \/ \d+ words|Index Warning: .*|Knowledge Warning: .*|Words: \d+; MTime: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}; Reads24h: \d+)\]$/u;
const CURRENT_TIME_LINE = /^\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)$/u;

export interface KnowledgeToolResultDescriptor extends ToolResultDescriptor {
	readonly structuredContent?: unknown;
	readonly usage?: Usage;
}

export interface KnowledgeToolResultPatch extends ToolResultPatch {
	readonly usage?: Usage;
}

export interface KnowledgeToolResultOptions {
	readonly service: KnowledgeService;
	readonly timeZone?: string;
	readonly now?: () => Date;
	readonly recordReads?: boolean;
	readonly includeIndexReport?: boolean;
}

function warningFromAuditError(error: unknown): string {
	const message = error instanceof Error && error.message.length > 0 ? error.message : "unknown error";
	return `[System Meta: Index Warning: Could not audit managed knowledge: ${message.replace(/[\r\n]+/gu, " ")}]`;
}

function validateMemoryUsage(memoryUsage: string | undefined): string | undefined {
	if (memoryUsage === undefined) return undefined;
	const match = /^\[System Meta: Current Memory Usage: (\d+) \/ 500 words\]$/u.exec(memoryUsage);
	const words = match?.[1] === undefined ? undefined : Number(match[1]);
	if (
		words === undefined ||
		!Number.isSafeInteger(words) ||
		words < 0 ||
		words > MEMORY_MAX_WORDS ||
		memoryUsage !== formatMemoryUsage(words)
	) {
		throw new RsiError(
			"INTERNAL",
			"Memory usage metadata must be exactly one canonical [System Meta: Current Memory Usage: N / 500 words] line.",
		);
	}
	return memoryUsage;
}

/** Remove stale standalone Runtime metadata before appending the authoritative copy. */
export function stripRuntimeMetadataText(text: string): string {
	const lines = text.split("\n");
	const kept = lines.filter((line) => {
		const trimmed = line.trim();
		return !RUNTIME_METADATA_LINE.test(trimmed) && !CURRENT_TIME_LINE.test(trimmed);
	});
	return kept.join("\n");
}

export function stripRuntimeMetadataFromContent(
	content: readonly (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	return content.map((block) =>
		block.type === "text" ? { ...block, text: stripRuntimeMetadataText(block.text) } : block,
	);
}

export interface FinalizableKnowledgeToolResult {
	readonly content: readonly (TextContent | ImageContent)[];
	readonly isError: boolean;
	readonly details?: unknown;
	readonly structuredContent?: unknown;
	readonly usage?: Usage;
}

export interface FinalizedKnowledgeToolResult extends FinalizableKnowledgeToolResult {}

/**
 * Final model-facing composition. Call this after every tool result, including
 * plugin tools, web_search, sleep, control tools, and rejected/error calls.
 * The authoritative order is: knowledge appendText, then Current Time.
 */
export function finalizeKnowledgeToolResult(
	input: FinalizableKnowledgeToolResult,
	decoration: Pick<ToolResultDecorationResult, "appendText" | "currentTime">,
): FinalizedKnowledgeToolResult {
	const text = [decoration.appendText, decoration.currentTime].filter((part) => part.length > 0).join("\n\n");
	const content = appendToolResultText(stripRuntimeMetadataFromContent(input.content), text);
	return { ...input, content };
}

/** Tool-result knowledge service implementing the shared decoration port. */
export class KnowledgeToolResultService implements ToolResultDecorationPort {
	readonly service: KnowledgeService;
	readonly timeZone: string;
	readonly recordReads: boolean;
	readonly includeIndexReport: boolean;
	private readonly now: () => Date;

	constructor(options: KnowledgeToolResultOptions) {
		this.service = options.service;
		this.timeZone = assertValidTimeZone(options.timeZone ?? options.service.timeZone);
		this.now = options.now ?? (() => options.service.clock.now());
		this.recordReads = options.recordReads ?? true;
		this.includeIndexReport = options.includeIndexReport ?? false;
	}

	private async auditWarnings(): Promise<string[]> {
		try {
			const audit = await this.service.auditIndex();
			const line = formatKnowledgeIndexWarning(audit);
			return line ? [line] : [];
		} catch (error) {
			return [warningFromAuditError(error)];
		}
	}

	private async recordSuccessfulRead(
		request: ToolResultDecorationRequest,
		now: Date,
	): Promise<string[]> {
		if (!this.recordReads || request.isError || request.readName === undefined || request.readName === null) {
			return [];
		}
		if (typeof request.readName !== "string" || request.readName.length === 0) {
			return ["[System Meta: Knowledge Warning: readName metadata is invalid.]"];
		}
		try {
			await this.service.recordRead(request.readName, now);
			return [];
		} catch (error) {
			const message = error instanceof Error && error.message.length > 0 ? error.message : "unknown error";
			return [
				`[System Meta: Knowledge Warning: Could not record successful read for ${request.readName}: ${message.replace(/[\r\n]+/gu, " ")}]`,
			];
		}
	}

	async decorate(
		request: ToolResultDecorationRequest,
		now: Date,
		signal?: AbortSignal,
	): Promise<ToolResultDecorationResult> {
		if (signal?.aborted) throw new RsiError("INTERNAL", "Tool result decoration aborted.");
		if (typeof request !== "object" || request === null) {
			throw new RsiError("INTERNAL", "Tool result decoration request must be an object.");
		}
		const usage = validateMemoryUsage(request.memoryUsage);
		const recordWarnings = await this.recordSuccessfulRead(request, now);
		const warnings = [...(await this.auditWarnings()), ...recordWarnings];
		let indexReport: string | null = null;
		if (request.indexRead) {
			try {
				indexReport = (await this.service.indexReport(now)).reportText;
			} catch (error) {
				const message = error instanceof Error && error.message.length > 0 ? error.message : "unknown error";
				const sanitized = message
					.split(String.fromCharCode(13))
					.join(" ")
					.split(String.fromCharCode(10))
					.join(" ");
				warnings.push(
					`[System Meta: Knowledge Warning: Could not build the request-time index report: ${sanitized}]`,
				);
			}
		}
		const parts: string[] = [];
		if (this.includeIndexReport && indexReport) parts.push(indexReport);
		if (usage) parts.push(usage);
		parts.push(...warnings);
		return {
			appendText: parts.join("\n\n"),
			currentTime: currentTimeSuffix(now, this.timeZone),
			warnings,
			indexReport,
		};
	}

	/** Convenience wrapper for the final Current Time decoration performed by the Worker. */
	async decorateAndFinalize(
		input: FinalizableKnowledgeToolResult,
		request: ToolResultDecorationRequest,
		now: Date = this.now(),
	): Promise<FinalizedKnowledgeToolResult> {
		const decoration = await this.decorate(request, now);
		return finalizeKnowledgeToolResult(input, decoration);
	}

	formatCurrentTime(now: Date = this.now()): string {
		return formatCurrentTimeSuffix(now, this.timeZone);
	}
}

/**
 * Middleware that re-audits the authoritative index after every tool result,
 * regardless of tool name, result shape, or error state.
 */
export class KnowledgeToolMiddleware implements ToolMiddlewarePort {
	readonly service: KnowledgeService;
	readonly recordReads: boolean;
	private readonly clock: { now(): Date };

	constructor(options: { readonly service: KnowledgeService; readonly recordReads?: boolean }) {
		this.service = options.service;
		this.recordReads = options.recordReads ?? false;
		this.clock = options.service.clock;
	}

	async beforeToolCall(): Promise<{ readonly action: "allow" }> {
		return { action: "allow" };
	}

	private async recordReadIfSuccessful(input: ToolResultDescriptor, now: Date): Promise<void> {
		if (!this.recordReads || input.isError || input.toolName !== "read") return;
		const candidate = input.input.path;
		if (typeof candidate !== "string" || !isAbsolute(candidate)) return;
		try {
			const target = await this.service.resolveManagedToolPath(candidate, this.service.root.realPath);
			await this.service.recordRead(target.name, now);
		} catch {
			// A read of an unmanaged path or a rejected read is not a managed read statistic.
		}
	}

	async afterToolResult(
		input: ToolResultDescriptor | KnowledgeToolResultDescriptor,
		signal?: AbortSignal,
	): Promise<KnowledgeToolResultPatch> {
		if (signal?.aborted) throw new RsiError("INTERNAL", "Tool result middleware aborted.");
		const now = this.clock.now();
		await this.recordReadIfSuccessful(input, now);
		let warning: string | undefined;
		try {
			warning = formatKnowledgeIndexWarning(await this.service.auditIndex());
		} catch (error) {
			warning = warningFromAuditError(error);
		}
		const stripped = stripRuntimeMetadataFromContent(input.content);
		const content = warning ? appendToolResultText(stripped, warning) : stripped;
		const contentChanged =
			content.length !== input.content.length ||
			content.some((block, index) => {
				const original = input.content[index];
				return (
					original === undefined ||
					block.type !== original.type ||
					(block.type === "text" && original.type === "text" && block.text !== original.text)
				);
			});
		if (!contentChanged) return {};
		return {
			content,
			...("structuredContent" in input
				? { structuredContent: (input as KnowledgeToolResultDescriptor).structuredContent }
				: {}),
			...("usage" in input ? { usage: (input as KnowledgeToolResultDescriptor).usage } : {}),
		};
	}
}
