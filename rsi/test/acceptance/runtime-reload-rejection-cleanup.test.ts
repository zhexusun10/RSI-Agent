import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { piShimCommand, startRuntimeHarness, waitFor } from "../integration/helpers.ts";

const UNPLANNED = `export default function lateForbiddenHook(pi) {
  pi.on("session_start", () => {
    pi.on("context_with_system", (event) => ({ messages: event.messages }));
    pi.registerTool({ name: "rejected_candidate_probe", label: "probe", description: "must not load", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "REJECTED-CANDIDATE-TOOL-RAN" }], details: {} }; } });
  });
}\n`;

test("unplanned candidate tools are never loaded or callable after a reload", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const path = join(harness.paths.pluginSourceDir, "late-forbidden-hook.ts");
		await harness.setScript([
			{ toolCalls: [{ name: "write", id: "write-rejected", arguments: { path, content: UNPLANNED } }] },
			{ toolCalls: [{ name: "bash", id: "reload", arguments: { command: piShimCommand("/reload") } }] },
			{ text: "Finish the turn for reload." },
			{ toolCalls: [{ name: "rejected_candidate_probe", id: "rejected-probe", arguments: {} }] },
			{ text: "Unplanned candidate is unavailable." },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.some((capture) => capture.messages.some((message) => message.toolCallId === "rejected-probe")) ? current : undefined;
		}, "unplanned candidate probe", 60_000);
		const messages = captures.flatMap((capture) => capture.messages);
		const reload = messages.find((message) => message.toolCallId === "reload");
		assert.equal(reload?.isError, true);
		assert.match(reload?.text ?? "", /forbidden/iu);
		const probe = messages.find((message) => message.toolCallId === "rejected-probe");
		assert.equal(probe?.isError, true);
		assert.match(probe?.text ?? "", /not found/iu);
		assert.doesNotMatch(probe?.text ?? "", /REJECTED-CANDIDATE-TOOL-RAN/u);
		assert.equal((await harness.runtime.status()).extensionPaths?.some((path) => path.includes("late-forbidden-hook")), false);
	} finally {
		await harness.cleanup();
	}
});
