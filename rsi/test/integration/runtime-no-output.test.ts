import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startRuntimeHarness, waitFor } from "./helpers.ts";

test("an empty/no-output response settles without duplicating the Runtime prompt and the next tool result is fully decorated", { timeout: 60_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const path = join(harness.paths.workspaceDir, "no-output.txt");
		await writeFile(path, "no-output marker\n");
		await harness.setScript([
			{ text: "", stopReason: "stop" },
			{ toolCalls: [{ name: "read", id: "after-empty", arguments: { path } }] },
			{ text: "stop after empty-output probe", stopReason: "error", errorMessage: "stop" },
		]);
		const capture = await waitFor(async () => {
			const current = await harness.captures();
			return current.find((entry) =>
				entry.messages.some(
					(message) => message.role === "toolResult" && message.toolCallId === "after-empty",
				),
			);
		}, "tool call after no-output response", 40_000);
		const runtimePrompts = capture.messages.filter(
			(message) => message.role === "user" && (message.text ?? "").startsWith("Runtime state:"),
		);
		assert.ok(runtimePrompts.length <= 2, "empty output must not create a duplicate Supervisor prompt");
		const result = capture.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "after-empty",
		);
		assert.match(result?.text ?? "", /no-output marker/);
		assert.match(result?.text ?? "", /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)$/);
	} catch (error) {
		console.error(`LOGS:\n${harness.logs.join("\n")}`);
		throw error;
	} finally {
		await harness.cleanup();
	}
});
