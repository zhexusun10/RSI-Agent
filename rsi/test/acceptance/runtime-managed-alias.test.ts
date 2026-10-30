import assert from "node:assert/strict";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
	assistantText,
	assistantToolCalls,
	createTestWorkspace,
	queueResponses,
	toolResultMessages,
} from "../pi/helpers.ts";

/**
 * A writable workspace can contain a directory symlink/junction to markdowns.
 * The native read tool must classify the canonical target, not only its lexical
 * path, or an alias can read a managed document without the broker, request-
 * time index metadata, or read-stat accounting. In production this is a real
 * symlink in the workspace; Windows uses a junction for the same test.
 */
test("the native read tool cannot bypass the managed broker through a workspace alias", { timeout: 60_000 }, async () => {
	const workspace = await createTestWorkspace({});
	try {
		const aliasRoot = join(workspace.cwd, "markdowns-alias");
		await symlink(
			workspace.markdownsDir,
			aliasRoot,
			process.platform === "win32" ? "junction" : "dir",
		);
		const queued = queueResponses(workspace, [
			assistantToolCalls([
				{ name: "read", arguments: { path: join(aliasRoot, "index.md") }, id: "alias-index-read" },
			]),
			assistantText("alias read complete"),
		]);
		await workspace.worker.run("read the managed index through an alias");
		const result = toolResultMessages(queued.captured[1]!).find(
			(entry) => entry.toolCallId === "alias-index-read",
		);
		assert.ok(result);
		const text = result.content.map((block) => block.text ?? "").join("\n");
		const readCount = [...workspace.documents.reads.values()].reduce(
			(sum, list) => sum + list.length,
			0,
		);
		if (result.isError) {
			assert.match(text, /symlink|alias|outside|managed/iu);
			assert.equal(readCount, 0, "a rejected alias must not be counted as a managed read");
		} else {
			assert.match(
				text,
				/Managed Markdown statistics|Reads24h|\| md名 \| words/u,
				"if the alias is routed rather than rejected, it must receive managed read metadata",
			);
			assert.equal(readCount, 1, "a routed managed alias must be counted exactly once");
		}
	} finally {
		await workspace.cleanup();
	}
});
