import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	assistantText,
	assistantToolCalls,
	createTestWorkspace,
	queueResponses,
	toolResultMessages,
} from "./helpers.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.map((block) => block.text ?? "")
		.filter((part) => part.length > 0)
		.join("\n");
}

test("an inconsistent index adds a warning to every tool result without writing stats to disk", async () => {
	const workspace = await createTestWorkspace({ memory: "INDEX-MEMORY" });
	try {
		const indexPath = join(workspace.markdownsDir, "index.md");
		const originalIndex = workspace.documents.get("index.md")?.content ?? "";
		const normalPath = await workspace.writeTextFile("metadata.txt", "metadata body\n");
		workspace.documents.seed(
			"index.md",
			"| md名 | description | 链接位置 |\n| --- | --- | --- |\n| Memory.md | Long-term memory | Memory.md |\n",
		);

		const queued = queueResponses(workspace, [
			assistantToolCalls([
				{ name: "read", arguments: { path: normalPath }, id: "meta-read" },
				{ name: "read", arguments: { path: indexPath }, id: "meta-index" },
			]),
			assistantText("done"),
		]);
		await workspace.worker.run("check metadata");
		const results = toolResultMessages(queued.captured[1]!);
		assert.equal(results.length, 2);
		for (const result of results) {
			const text = textOf(result);
			assert.match(text, /\[System Meta: Index Warning:/);
			assert.match(text, /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)/);
			assert.doesNotMatch(text, /Current Memory Usage/, "Memory usage belongs only to a Memory update result");
		}
		const indexResult = results.find((result) => result.toolCallId === "meta-index");
		assert.ok(indexResult);
		assert.match(textOf(indexResult), /Managed Markdown statistics/);
		assert.equal(await readFile(indexPath, "utf8"), originalIndex);
		assert.equal(workspace.documents.get("index.md")?.content.startsWith("| md名"), true);
	} finally {
		await workspace.cleanup();
	}
});
