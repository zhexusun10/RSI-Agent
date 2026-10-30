import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { startRuntimeHarness, waitFor } from "./helpers.ts";

function words(count: number, prefix = "word"): string {
	return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
}

test("managed knowledge enforces Memory/document caps, keeps bytes on rejection, and serves request-time index metadata", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const memoryPath = join(harness.paths.markdownsDir, "Memory.md");
		const indexPath = join(harness.paths.markdownsDir, "index.md");
		const notepadPath = join(harness.paths.markdownsDir, "notepad.md");
		const bigPath = join(harness.paths.markdownsDir, "boundary.md");
		const ordinaryPath = join(harness.paths.workspaceDir, "ordinary.txt");
		const indexBefore = await readFile(indexPath, "utf8");
		const indexStatBefore = await stat(indexPath);
		await harness.setScript([
			{
				toolCalls: [
					{ name: "write", id: "memory-too-big", arguments: { path: memoryPath, content: words(501, "m") } },
					{ name: "write", id: "doc-too-big", arguments: { path: bigPath, content: words(1_001, "d") } },
					{ name: "write", id: "doc-boundary", arguments: { path: bigPath, content: words(1_000, "d") } },
					{ name: "write", id: "notepad", arguments: { path: notepadPath, content: "unindexed knowledge" } },
					{ name: "write", id: "ordinary", arguments: { path: ordinaryPath, content: "ordinary workspace file" } },
				],
			},
			{ text: "first pass done" },
			{
				toolCalls: [
					{ name: "read", id: "read-index", arguments: { path: indexPath } },
					{ name: "read", id: "read-notepad", arguments: { path: notepadPath } },
				],
			},
			{ text: "second pass done", stopReason: "error", errorMessage: "stop integration loop" },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.length >= 4 ? current : undefined;
		}, "knowledge requests", 60_000);

		const firstToolResults = captures[1]!.messages.filter((message) => message.role === "toolResult");
		const byTool = new Map(firstToolResults.map((message) => [message.toolCallId, message.text ?? ""]));
		assert.match(byTool.get("memory-too-big") ?? "", /MEMORY_WORD_LIMIT|exceeds 500 words/);
		assert.match(byTool.get("memory-too-big") ?? "", /\(Current Time:/);
		assert.match(byTool.get("doc-too-big") ?? "", /DOCUMENT_WORD_LIMIT|exceeds 1000 words/);
		assert.equal(byTool.get("doc-boundary")?.includes("Successfully wrote"), true);
		assert.match(byTool.get("ordinary") ?? "", /\(Current Time:/);
		const memoryAfter = await readFile(memoryPath, "utf8");
		assert.equal(memoryAfter, "");
		assert.equal(await readFile(bigPath, "utf8"), words(1_000, "d"));

		const later = captures[3]!.messages.filter((message) => message.role === "toolResult");
		for (const result of later) {
			assert.match(result.text ?? "", /\[System Meta: Index Warning:/, `${result.toolCallId} needs warning`);
			assert.match(result.text ?? "", /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)$/);
		}
		const indexRead = later.find((message) => message.toolCallId === "read-index");
		assert.ok(indexRead);
		assert.match(indexRead.text ?? "", /\[System Meta: Words: \d+; MTime: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}; Reads24h: \d+\]/);
		assert.match(indexRead.text ?? "", /Managed Markdown statistics \(request-time; not written to index\.md\)/);
		assert.ok(
			(indexRead.text ?? "").indexOf("Managed Markdown statistics") <
				(indexRead.text ?? "").indexOf("[System Meta: Index Warning:"),
			"index report must precede the canonical warning",
		);
		assert.equal(await readFile(indexPath, "utf8"), indexBefore);
		const indexStatAfter = await stat(indexPath);
		assert.equal(indexStatAfter.mtimeMs, indexStatBefore.mtimeMs);
		const readStats = await readFile(harness.paths.readStatsFile, "utf8");
		assert.match(readStats, /index\.md/);
		const captureText = captures.map((capture) => JSON.stringify(capture)).join("\n");
		assert.match(captureText, /INTEGRATION-HUMAN-PROMPT-9C71/);
	} finally {
		await harness.cleanup();
	}
});
