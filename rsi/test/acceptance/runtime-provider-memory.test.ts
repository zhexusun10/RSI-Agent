import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { countWords } from "../../src/shared/words.ts";
import { startRuntimeHarness, waitFor } from "../integration/helpers.ts";

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/**
 * Observe the actual provider-facing transcript, not a unit helper: the leading
 * system message must contain the new Memory section and the unchanged manual
 * prompt, while no user/tool message duplicates the Memory text.
 */
test("provider transcript refreshes mixed-CJK Memory in the single leading system message", { timeout: 60_000 }, async () => {
	const harness = await startRuntimeHarness();
	const memoryContent = "新记忆 中文 ALPHA";
	const expectedWords = countWords(memoryContent);
	try {
		const memoryPath = join(harness.paths.markdownsDir, "Memory.md");
		await harness.setScript([
			{ toolCalls: [{ name: "write", id: "memory-write", arguments: { path: memoryPath, content: memoryContent } }] },
			{ text: "memory committed", stopReason: "error", errorMessage: "stop acceptance loop" },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.length >= 2 ? current : undefined;
		}, "initial and post-write provider requests", 30_000);
		const first = captures[0]!;
		const second = captures[1]!;
		const manualPrompt = await readFile(join(harness.root, "manual-prompt.txt"), "utf8");

		assert.match(first.system, /INTEGRATION-HUMAN-PROMPT-9C71/);
		assert.doesNotMatch(first.system, new RegExp(memoryContent));
		assert.match(second.system, new RegExp(memoryContent));
		assert.equal(second.messages.filter((message) => message.role === "system").length, 1);
		assert.equal(second.system.startsWith(manualPrompt.trim()), true);
		assert.equal(occurrences(second.system, "INTEGRATION-HUMAN-PROMPT-9C71"), 1);
		const nonSystemText = second.messages
			.filter((message) => message.role !== "system")
			.map((message) => message.text ?? "")
			.join("\n");
		assert.doesNotMatch(nonSystemText, new RegExp(memoryContent));

		const toolResult = second.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "write",
		);
		assert.ok(toolResult);
		assert.equal(toolResult.isError, false);
		assert.match(toolResult.text ?? "", new RegExp(`\[System Meta: Current Memory Usage: ${expectedWords} / 500 words\]`, "u"));
		const times = (toolResult.text ?? "").match(/\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)/gu) ?? [];
		assert.equal(times.length, 1, "one top-level result must have exactly one final Current Time");
		assert.match(toolResult.text ?? "", /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)$/u);
	} finally {
		await harness.cleanup();
	}
});
