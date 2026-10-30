import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import {
	assistantText,
	assistantToolCalls,
	createTestWorkspace,
	MANUAL_MARKER,
	queueResponses,
	systemTextOf,
	toolResultMessages,
} from "./helpers.ts";

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

test("Memory is refetched in system position for the next request in one run", async () => {
	const workspace = await createTestWorkspace({ memory: "ALPHA" });
	try {
		const memoryPath = join(workspace.markdownsDir, "Memory.md");
		const nextMemory = "BETA refreshed memory";
		const queued = queueResponses(workspace, [
			assistantToolCalls([{ name: "write", arguments: { path: memoryPath, content: nextMemory } }]),
			assistantText("finished"),
		]);

		await workspace.worker.run("First request");

		assert.equal(queued.captured.length, 2);
		const first = systemTextOf(queued.captured[0]!);
		const second = systemTextOf(queued.captured[1]!);
		assert.match(first, /ALPHA/);
		assert.doesNotMatch(first, /BETA/);
		assert.match(second, /BETA refreshed memory/);
		assert.doesNotMatch(second, /ALPHA/);

		// The human segment is replayed verbatim and is not duplicated.
		assert.equal(second.startsWith(workspace.manualPrompt.content), true);
		assert.equal(occurrences(second, MANUAL_MARKER), 1);

		// Memory was a named system section, not a user/assistant/tool message.
		const secondMessages = queued.captured[1]!.messages;
		assert.equal(secondMessages[0]?.role, "system");
		assert.equal(secondMessages.filter((message) => message.role === "system").length, 1);
		const nonSystemText = secondMessages
			.filter(
				(message) =>
					message.role === "user" || message.role === "toolResult",
			)
			.map((message) => JSON.stringify(message))
			.join("\n");
		assert.doesNotMatch(nonSystemText, /BETA refreshed memory/);

		const writeResult = toolResultMessages(queued.captured[1]!)[0];
		assert.ok(writeResult);
		assert.equal(writeResult.toolName, "write");
		const text = writeResult.content
			.map((block) => block.text ?? "")
			.filter((part) => part.length > 0)
			.join("\n");
		assert.match(text, /Current Memory Usage: 3 \/ 500 words/);
		assert.match(text, /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)/);
		assert.ok(
			text.indexOf("Current Memory Usage") < text.indexOf("(Current Time:"),
			"Memory usage must precede the final Current Time line",
		);

		assert.equal(workspace.documents.get("Memory.md")?.content, nextMemory);
		assert.equal(workspace.worker.status().memoryRevision, workspace.documents.get("Memory.md")?.revision);
	} finally {
		await workspace.cleanup();
	}
});


test("Memory is refreshed again for a native retry request", async () => {
	const workspace = await createTestWorkspace({
		memory: "ALPHA",
		settingsOverrides: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 5 } },
	});
	try {
		const queued = queueResponses(workspace, [
			({ index }) => {
				assert.equal(index, 0);
				workspace.documents.seed("Memory.md", "RETRY-MEMORY");
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
			},
			assistantText("retry succeeded"),
		]);
		await workspace.worker.run("retry request");
		assert.equal(queued.captured.length, 2);
		const first = systemTextOf(queued.captured[0]!);
		const second = systemTextOf(queued.captured[1]!);
		assert.match(first, /ALPHA/);
		assert.doesNotMatch(first, /RETRY-MEMORY/);
		assert.match(second, /RETRY-MEMORY/);
		assert.doesNotMatch(second, /ALPHA/);
		assert.equal(occurrences(second, MANUAL_MARKER), 1);
	} finally {
		await workspace.cleanup();
	}
});

test("an empty Memory replaces old Memory instead of leaving a stale section", async () => {
	const workspace = await createTestWorkspace({ memory: "OLD-MEMORY" });
	try {
		const memoryPath = join(workspace.markdownsDir, "Memory.md");
		const queued = queueResponses(workspace, [
			assistantToolCalls([{ name: "write", arguments: { path: memoryPath, content: "" } }]),
			assistantText("done"),
		]);
		await workspace.worker.run("clear memory");
		const second = systemTextOf(queued.captured[1]!);
		assert.doesNotMatch(second, /OLD-MEMORY/);
		assert.equal(second.startsWith(workspace.manualPrompt.content), true);
		assert.equal(occurrences(second, MANUAL_MARKER), 1);
	} finally {
		await workspace.cleanup();
	}
});
