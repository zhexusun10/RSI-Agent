import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assistantText,
	assistantToolCalls,
	createTestWorkspace,
	queueResponses,
	toolResultMessages,
} from "../pi/helpers.ts";

const NESTED_TOOL = `
import { Type } from "typebox";
export default function nestedTimeFixture(pi) {
  pi.registerTool({
    name: "nested_time_probe",
    label: "nested_time_probe",
    description: "Calls read through the nested tool context.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const nested = await ctx.executeTool("read", { path: params.path }, { signal });
      return {
        content: [
          { type: "text", text: "NESTED-BEGIN" },
          ...nested.result.content,
          { type: "text", text: "NESTED-END" },
        ],
        details: { nestedIsError: nested.isError },
      };
    },
  });
}
`;

/**
 * The nested tool's own finalized record may carry a Current Time, but the
 * model-visible parent result must still end with exactly one final suffix.
 * Embedding a timestamp in the middle of the parent creates duplicate metadata
 * and violates the per-result decoration contract.
 */
test("a top-level result containing a nested tool call has exactly one final Current Time", { timeout: 60_000 }, async () => {
	const workspace = await createTestWorkspace({});
	try {
		const extensionPath = await workspace.writeExtension("nested-time.ts", NESTED_TOOL);
		await workspace.worker.requestReload({ approvedExtensionPaths: [extensionPath] });
		const filePath = await workspace.writeTextFile("nested-time.txt", "line one\nline two\n");
		const queued = queueResponses(workspace, [
			assistantToolCalls([{ name: "nested_time_probe", arguments: { path: filePath }, id: "nested-time-1" }]),
			assistantText("nested complete"),
		]);
		await workspace.worker.run("call nested time probe");
		const parent = toolResultMessages(queued.captured[1]!).find(
			(result) => result.toolCallId === "nested-time-1",
		);
		assert.ok(parent);
		const text = parent.content.map((block) => block.text ?? "").join("\n");
		const timestamps = text.match(/\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)/gu) ?? [];
		assert.equal(timestamps.length, 1, `expected exactly one time suffix, got ${timestamps.length}`);
		assert.match(text, /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)$/u);
	} finally {
		await workspace.cleanup();
	}
});
