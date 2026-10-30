import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { countWords } from "../../src/shared/words.ts";
import { startRuntimeHarness, waitFor } from "../integration/helpers.ts";

function toolResults(capture: {
	readonly messages: ReadonlyArray<{
		readonly role?: string;
		readonly toolCallId?: string;
		readonly toolName?: string;
		readonly text?: string;
		readonly isError?: boolean;
	}>;
}) {
	return capture.messages.filter((message) => message.role === "toolResult");
}

/**
 * Independent review regression: a 501-word Memory write must be rejected
 * atomically, while a subsequent successful write in the same agent turn must
 * be visible as the only Memory section in the very next provider request.
 */
test("review2: Memory 501 is atomic and the same-turn successful Memory reaches the next system request", { timeout: 60_000 }, async () => {
	const oldMemory = "OLD-REVIEW2-MEMORY";
	const newMemory = "同一轮 REVIEW2 新记忆";
	const overLimit = "记".repeat(501);
	const harness = await startRuntimeHarness({
		beforeStart: async ({ config }) => {
			const { writeFile } = await import("node:fs/promises");
			await writeFile(join(config.paths.markdownsDir, "Memory.md"), oldMemory, "utf8");
		},
	});
	try {
		const memoryPath = join(harness.paths.markdownsDir, "Memory.md");
		await harness.setScript([
			{
				toolCalls: [
					{
						name: "write",
						id: "review2-memory-over",
						arguments: { path: memoryPath, content: overLimit },
					},
					{
						name: "write",
						id: "review2-memory-ok",
						arguments: { path: memoryPath, content: newMemory },
					},
				],
			},
			{ text: "review2 memory turn complete", stopReason: "error", errorMessage: "stop review2 loop" },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.length >= 2 ? current : undefined;
		}, "provider requests before and after Memory writes", 30_000);
		assert.match(captures[0]!.system, new RegExp(oldMemory, "u"));
		const results = toolResults(captures[1]!);
		const over = results.find((result) => result.toolCallId === "review2-memory-over");
		const ok = results.find((result) => result.toolCallId === "review2-memory-ok");
		assert.ok(over);
		assert.ok(ok);
		assert.equal(over.isError, true);
		assert.match(over.text ?? "", /MEMORY_WORD_LIMIT|exceeds 500 words/iu);
		assert.equal(ok.isError, false);
		assert.equal(await readFile(memoryPath, "utf8"), newMemory);
		assert.equal(captures[1]!.messages.filter((message) => message.role === "system").length, 1);
		assert.match(captures[1]!.system, /INTEGRATION-HUMAN-PROMPT-9C71/u);
		assert.match(captures[1]!.system, new RegExp(newMemory, "u"));
		assert.doesNotMatch(captures[1]!.system, new RegExp(overLimit, "u"));
		assert.doesNotMatch(captures[1]!.system, new RegExp(oldMemory, "u"));
		const expectedUsage = `[System Meta: Current Memory Usage: ${countWords(newMemory)} / 500 words]`;
		assert.match(ok.text ?? "", new RegExp(expectedUsage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
		const nonSystem = captures[1]!.messages
			.filter((message) => message.role !== "system")
			.map((message) => message.text ?? "")
			.join("\n");
		assert.doesNotMatch(nonSystem, new RegExp(newMemory, "u"));
	} finally {
		await harness.cleanup();
	}
});
