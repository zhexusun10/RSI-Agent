import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startRuntimeHarness, waitFor } from "./helpers.ts";

test("local functional runtime starts a real Pi Worker process, refreshes Memory at the next request, and decorates tools", { timeout: 60_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const memoryPath = join(harness.paths.markdownsDir, "Memory.md");
		await harness.setScript([
			{
				toolCalls: [
					{
						name: "write",
						id: "memory-write",
						arguments: { path: memoryPath, content: "SMOKE-MEMORY-ALPHA" },
					},
				],
			},
			{ text: "memory updated" },
			{ text: "runtime continuation", stopReason: "error", errorMessage: "stop smoke loop" },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.length >= 2 ? current : undefined;
		}, "two provider requests", 30_000);
		const second = captures[1]!;
		assert.match(second.system, /SMOKE-MEMORY-ALPHA/);
		assert.match(second.system, /INTEGRATION-HUMAN-PROMPT-9C71/);
		const toolResult = second.messages.find((message) => message.role === "toolResult");
		assert.ok(toolResult);
		assert.equal(toolResult.toolName, "write");
		assert.match(toolResult.text ?? "", /Current Memory Usage: 3 \/ 500 words/);
		assert.match(toolResult.text ?? "", /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)/);
		assert.equal((await harness.runtime.knowledgeService.readCurrentMemory()).content, "SMOKE-MEMORY-ALPHA");
		const status = await harness.runtime.status();
		assert.ok(status.extensionPaths?.some((path) => path.includes("pi-continuity")));
		assert.ok(status.extensionPaths?.some((path) => path.includes("pi-better-web-search")));
	} catch (error) {
		console.error(`runtime logs:\n${harness.logs.join("\n")}`);
		throw error;
	} finally {
		await harness.cleanup();
	}
});
