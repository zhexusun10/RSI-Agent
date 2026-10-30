import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assistantText,
	assistantToolCalls,
	createTestWorkspace,
	queueResponses,
	toolResultMessages,
} from "../pi/helpers.ts";

const CONCATENATED_NESTED_TOOL = `
import { Type } from "typebox";
export default function concatenatedNestedTool(pi) {
  pi.registerTool({
    name: "nested_concat_time_probe",
    label: "nested_concat_time_probe",
    description: "Concatenates a nested result into one parent text block.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const nested = await ctx.executeTool("read", { path: params.path }, { signal });
      const text = nested.result.content.map((block) => block.text || "").join(" ");
      return {
        content: [{ type: "text", text: "NESTED-BEGIN " + text + " NESTED-END" }],
        details: { nestedIsError: nested.isError },
      };
    },
  });
}
`;

/**
 * The previous regression covered separately wrapped nested content. A plugin
 * can also flatten a nested result into one text block before returning it.
 * The embedded nested Runtime time must be removed at the parent boundary so
 * the model-visible top-level result ends with exactly one Current Time.
 */
test("flattened nested content cannot leave a duplicate Current Time in the parent result", { timeout: 60_000 }, async () => {
	const workspace = await createTestWorkspace({});
	try {
		const extensionPath = await workspace.writeExtension("nested-concat-time.ts", CONCATENATED_NESTED_TOOL);
		await workspace.worker.requestReload({ approvedExtensionPaths: [extensionPath] });
		const filePath = await workspace.writeTextFile("nested-concat-time.txt", "line one\nline two\n");
		const queued = queueResponses(workspace, [
			assistantToolCalls([
				{ name: "nested_concat_time_probe", arguments: { path: filePath }, id: "nested-concat-time-1" },
			]),
			assistantText("nested concatenated complete"),
		]);
		await workspace.worker.run("call concatenated nested time probe");
		const parent = toolResultMessages(queued.captured[1]!).find(
			(result) => result.toolCallId === "nested-concat-time-1",
		);
		assert.ok(parent);
		const text = parent.content.map((block) => block.text ?? "").join("\n");
		const timestamps = text.match(/\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)/gu) ?? [];
		assert.equal(timestamps.length, 1, `expected exactly one time suffix, got ${timestamps.length}: ${text}`);
		assert.match(text, /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)$/u);
		assert.match(text, /NESTED-BEGIN/u);
		assert.match(text, /NESTED-END/u);
		assert.equal(workspace.worker.nestedToolResults.length, 1);
	} finally {
		await workspace.cleanup();
	}
});
