import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { piShimCommand, startRuntimeHarness, waitFor } from "./helpers.ts";

function extensionSource(index: number): string {
	return `export default function generated(pi) {
  pi.registerTool({ name: "generated_tool_${index}", label: "generated", description: "Must not load", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "UNEXPECTED-${index}" }], details: {} }; } });
}\n`;
}

test("Agent-written Pi extensions remain inactive and the CLI reload is forbidden", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const generated = Array.from({ length: 6 }, (_, index) => ({
			name: "write", id: `write-${index}`, arguments: {
				path: join(harness.paths.pluginSourceDir, `generated-${index}.ts`), content: extensionSource(index),
			},
		}));
		await harness.setScript([
			{ toolCalls: generated },
			{ toolCalls: [{ name: "bash", id: "reload", arguments: { command: piShimCommand("/reload") } }] },
			{ text: "Finish the turn to let reload settle." },
			{ toolCalls: [
				{ name: "generated_tool_0", id: "tool-0", arguments: {} },
				{ name: "generated_tool_5", id: "tool-5", arguments: {} },
			] },
			{ text: "Those extensions were not mounted." },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.some((capture) => capture.messages.some((message) => message.toolCallId === "tool-5")) ? current : undefined;
		}, "unplanned tool rejection", 60_000);
		const messages = captures.flatMap((capture) => capture.messages);
		const reload = messages.find((message) => message.toolCallId === "reload");
		assert.equal(reload?.isError, true);
		assert.match(reload?.text ?? "", /forbidden/iu);
		for (const id of ["tool-0", "tool-5"]) {
			const result = messages.find((message) => message.toolCallId === id);
			assert.equal(result?.isError, true);
			assert.match(result?.text ?? "", /not found/i);
		}
		const status = await harness.runtime.status();
		assert.equal((status.extensionPaths ?? []).some((path) => path.includes("generated-")), false);
	} finally {
		await harness.cleanup();
	}
});
