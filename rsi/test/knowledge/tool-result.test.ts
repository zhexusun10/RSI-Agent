import assert from "node:assert/strict";
import test from "node:test";
import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import {
	finalizeKnowledgeToolResult,
	KnowledgeToolResultService,
	MEMORY_USAGE_LINE_PATTERN,
	stripRuntimeMetadataText,
} from "../../src/knowledge/tool-result.ts";
import { formatMemoryUsage } from "../../src/shared/memory.ts";
import { createKnowledgeFixture, errorCode } from "./helpers.ts";

const usage: Usage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

test("decoration returns Memory metadata and index warnings in deterministic order", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await fixture.service.commit({
			name: "unindexed.md",
			content: "unindexed",
			expectedRevision: null,
			operation: "write",
		});
		const decorator = new KnowledgeToolResultService({ service: fixture.service });
		const now = fixture.clock.now();
		const first = await decorator.decorate(
			{
				toolName: "write",
				toolCallId: "call-1",
				isError: false,
				indexRead: false,
				memoryUsage: formatMemoryUsage(5),
			},
			now,
		);
		const second = await decorator.decorate(
			{
				toolName: "write",
				toolCallId: "call-2",
				isError: false,
				indexRead: false,
				memoryUsage: formatMemoryUsage(5),
			},
			now,
		);
		assert.equal(first.appendText, second.appendText);
		const parts = first.appendText.split("\n\n");
		assert.equal(parts[0], "[System Meta: Current Memory Usage: 5 / 500 words]");
		assert.match(parts[1] ?? "", /^\[System Meta: Index Warning: .*unindexed\.md/u);
		assert.equal(MEMORY_USAGE_LINE_PATTERN.test(parts[0] ?? ""), true);
		assert.equal(first.currentTime, "(Current Time: 2026/01/02 03:04:05)");
		assert.equal(first.appendText.includes("Current Time"), false);
		assert.equal(first.indexReport, null);
	} finally {
		await fixture.cleanup();
	}
});

test("non-canonical Memory metadata is rejected instead of reaching the model", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const decorator = new KnowledgeToolResultService({ service: fixture.service });
		await assert.rejects(
			() =>
				decorator.decorate(
					{
						toolName: "write",
						toolCallId: "bad-meta",
						isError: false,
						indexRead: false,
						memoryUsage: "[System Meta: Current Memory Usage: 1 / 500 words]\nextra",
					},
					fixture.clock.now(),
				),
			(error: unknown) => errorCode(error) === "INTERNAL",
		);
	} finally {
		await fixture.cleanup();
	}
});

test("finalization preserves images, details, structuredContent, isError, and usage", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const decorator = new KnowledgeToolResultService({ service: fixture.service });
		const now = fixture.clock.now();
		const decoration = await decorator.decorate(
			{
				toolName: "custom_plugin",
				toolCallId: "plugin",
				isError: true,
				indexRead: false,
			},
			now,
		);
		const image: ImageContent = { type: "image", data: "AA==", mimeType: "image/png" };
		const text: TextContent = {
			type: "text",
			text: [
				"plugin result",
				"(Current Time: 1999/01/01 00:00:00)",
				"[System Meta: Current Memory Usage: 1 / 500 words]",
				"[System Meta: Index Warning: stale]",
			].join("\n"),
		};
		const details = { nested: { value: 1 } };
		const structuredContent = { ok: true };
		const result = finalizeKnowledgeToolResult(
			{
				content: [text, image],
				isError: true,
				details,
				structuredContent,
				usage,
			},
			decoration,
		);
		assert.equal(result.isError, true);
		assert.equal(result.details, details);
		assert.equal(result.structuredContent, structuredContent);
		assert.equal(result.usage, usage);
		assert.equal(result.content[1], image);
		const finalText = result.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		assert.match(finalText, /^plugin result/u);
		assert.equal(finalText.includes("1999/01/01"), false);
		assert.equal(finalText.includes("Current Memory Usage: 1"), false);
		assert.equal(finalText.includes("stale"), false);
		assert.equal(
			finalText.split("\n").filter((line) => MEMORY_USAGE_LINE_PATTERN.test(line)).length,
			0,
			"a plugin-supplied Memory line is not Runtime metadata",
		);
		assert.equal(
			finalText.split("\n").filter((line) => line.startsWith("(Current Time: ")).length,
			1,
		);
		assert.match(finalText, /\(Current Time: 2026\/01\/02 03:04:05\)$/u);
	} finally {
		await fixture.cleanup();
	}
});

test("finalization appends exactly one authoritative Memory line", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const decorator = new KnowledgeToolResultService({ service: fixture.service });
		const decoration = await decorator.decorate(
			{
				toolName: "write",
				toolCallId: "memory-write",
				isError: false,
				indexRead: false,
				memoryUsage: formatMemoryUsage(12),
			},
			fixture.clock.now(),
		);
		const result = finalizeKnowledgeToolResult(
			{
				content: [{ type: "text", text: "stale\n[System Meta: Current Memory Usage: 1 / 500 words]" }],
				isError: false,
			},
			decoration,
		);
		const text = (result.content[0] as TextContent).text;
		assert.equal(text.includes("[System Meta: Current Memory Usage: 1 / 500 words]"), false);
		assert.equal(text.split("\n").filter((line) => MEMORY_USAGE_LINE_PATTERN.test(line)).length, 1);
		assert.match(text, /\[System Meta: Current Memory Usage: 12 \/ 500 words\]/u);
	} finally {
		await fixture.cleanup();
	}
});

test("successful managed reads are recorded once by decoration and errors are not counted", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await fixture.service.commit({
			name: "read-me.md",
			content: "read me",
			expectedRevision: null,
			operation: "write",
		});
		const decorator = new KnowledgeToolResultService({ service: fixture.service });
		const now = fixture.clock.now();
		await decorator.decorate(
			{
				toolName: "read",
				toolCallId: "read-ok",
				isError: false,
				readName: "read-me.md",
				indexRead: false,
			},
			now,
		);
		assert.equal((await fixture.service.readStatsCounts(now)).get("read-me.md"), 1);
		await decorator.decorate(
			{
				toolName: "read",
				toolCallId: "read-error",
				isError: true,
				readName: "read-me.md",
				indexRead: false,
			},
			now,
		);
		assert.equal((await fixture.service.readStatsCounts(now)).get("read-me.md"), 1);
		const indexDecoration = await decorator.decorate(
			{
				toolName: "read",
				toolCallId: "index-read",
				isError: false,
				readName: "index.md",
				indexRead: true,
			},
			now,
		);
		assert.match(indexDecoration.indexReport ?? "", /Managed Markdown statistics/u);
		assert.equal(indexDecoration.appendText.includes("Managed Markdown statistics"), false);
		assert.equal((await fixture.service.readStatsCounts(now)).get("index.md"), 1);
		assert.equal((await fixture.service.readStatsCounts(now)).get("read-me.md"), 1);
	} finally {
		await fixture.cleanup();
	}
});

test("stripRuntimeMetadataText removes only exact Runtime metadata lines", () => {
	const text = [
		"keep this",
		"[System Meta: Current Memory Usage: 1 / 500 words]",
		"[System Meta: Index Warning: stale",
		"| a.md | [System Meta: Words: 1; MTime: 2026/01/01 00:00:00; Reads24h: 1] |",
		"(Current Time: 1999/01/01 00:00:00)",
	].join("\n");
	const stripped = stripRuntimeMetadataText(text);
	assert.match(stripped, /^keep this\n/u);
	assert.equal(stripped.includes("Current Memory Usage"), false);
	assert.equal(stripped.includes("Current Time"), false);
	assert.match(stripped, /\[System Meta: Words: 1; MTime:/u);
	assert.equal(stripped.includes("Index Warning: stale"), true);
});

test("middleware strips stale Runtime metadata and preserves structured fields", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const middleware = new (await import("../../src/knowledge/tool-result.ts")).KnowledgeToolMiddleware({
			service: fixture.service,
		});
		const patch = await middleware.afterToolResult({
			toolCallId: "plugin-meta",
			toolName: "web_search",
			input: {},
			content: [
				{
					type: "text",
					text: "plugin output\n(Current Time: 1999/01/01 00:00:00)\n[System Meta: Current Memory Usage: 1 / 500 words]",
				},
			],
			isError: false,
			structuredContent: { value: 1 },
			usage,
		});
		assert.equal(patch.structuredContent !== undefined, true);
		assert.equal(patch.usage, usage);
		const text = (patch.content?.[0] as TextContent).text;
		assert.equal(text, "plugin output");
		const clean = await middleware.afterToolResult({
			toolCallId: "clean",
			toolName: "custom",
			input: {},
			content: [{ type: "text", text: "clean result" }],
			isError: false,
		});
		assert.deepEqual(clean, {});
	} finally {
		await fixture.cleanup();
	}
});
