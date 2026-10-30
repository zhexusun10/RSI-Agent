import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { countWords } from "../../src/shared/words.ts";
import { startRuntimeHarness, waitFor } from "../integration/helpers.ts";

function usageLines(text: string): string[] {
	return text.match(/\[System Meta: Current Memory Usage: \d+ \/ 500 words\]/gu) ?? [];
}

/**
 * Two Memory writes in one assistant tool batch are concurrent from Pi's
 * perspective. Every successful write result must carry the usage for its own
 * committed bytes. A shared pending-usage slot keyed only by path can hand the
 * later commit's count to the earlier result and omit it from the later result.
 */
test("concurrent Memory writes carry an exact usage for each successful result", { timeout: 60_000 }, async () => {
	const harness = await startRuntimeHarness();
	const firstContent = "alpha beta gamma";
	const secondContent = "one two three four five six seven eight nine ten";
	const expectedById = new Map([
		["memory-write-1", countWords(firstContent)],
		["memory-write-2", countWords(secondContent)],
	]);
	try {
		const memoryPath = join(harness.paths.markdownsDir, "Memory.md");
		await harness.setScript([
			{
				toolCalls: [
					{ name: "write", id: "memory-write-1", arguments: { path: memoryPath, content: firstContent } },
					{ name: "write", id: "memory-write-2", arguments: { path: memoryPath, content: secondContent } },
				],
			},
			{ text: "concurrent memory writes complete", stopReason: "error", errorMessage: "stop acceptance loop" },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			const results = current
				.flatMap((entry) => entry.messages)
				.filter((message) => message.role === "toolResult" && message.toolName === "write");
			return results.length >= 2 ? current : undefined;
		}, "both concurrent memory write results", 30_000);

		const results = captures
			.flatMap((entry) => entry.messages)
			.filter((message) => message.role === "toolResult" && message.toolName === "write");
		assert.equal(results.length, 2);
		let successful = 0;
		for (const result of results) {
			const id = (result as { toolCallId?: string }).toolCallId ?? "";
			const expected = expectedById.get(id);
			assert.notEqual(expected, undefined, `unexpected write result id ${id}`);
			if (result.isError) continue;
			successful += 1;
			const lines = usageLines(result.text ?? "");
			assert.equal(lines.length, 1, `${id} must have exactly one Memory usage line`);
			assert.equal(
				lines[0],
				`[System Meta: Current Memory Usage: ${expected} / 500 words]`,
				`${id} must report the usage of its own committed content`,
			);
		}
		assert.equal(successful >= 1, true, "at least one write must succeed");
		const finalContent = await readFile(memoryPath, "utf8");
		assert.ok(
			finalContent === firstContent || finalContent === secondContent,
			"final Memory must be one committed value, not a mixed or torn value",
		);
	} catch (error) {
		console.error(`LOGS:\n${harness.logs.join("\n")}`);
		console.error(`CAPTURES:\n${JSON.stringify(await harness.captures().catch(() => []), null, 2)}`);
		throw error;
	} finally {
		await harness.cleanup();
	}
});
