import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolMiddlewarePort } from "../../src/shared/ports.ts";
import {
	assistantText,
	assistantToolCalls,
	createTestWorkspace,
	queueResponses,
	toolResultMessages,
} from "./helpers.ts";

const CUSTOM_EXTENSION = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function toolsFixture(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "custom_tool",
		label: "custom_tool",
		description: "Fixture custom tool.",
		parameters: Type.Object({ value: Type.String() }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: "CUSTOM-OK:" + params.value }],
				details: { keep: true, value: params.value },
				structuredContent: { ok: true, value: params.value },
				usage: {
					input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		},
	});
	pi.registerTool({
		name: "nested_probe",
		label: "nested_probe",
		description: "Fixture nested tool.",
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
				structuredContent: { nestedIsError: nested.isError },
			};
		},
	});
	pi.registerTool({
		name: "blocked_tool",
		label: "blocked_tool",
		description: "Fixture blocked tool.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "SHOULD-NOT-RUN" }], details: {} };
		},
	});
}
`;

const PNG_1X1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";

function textOf(blocks: Array<{ type: string; text?: string }>): string {
	return blocks
		.map((block) => block.text ?? "")
		.filter((part) => part.length > 0)
		.join("\n");
}

test("every finalized top-level tool result carries metadata and preserves native structure", async () => {
	const middleware: ToolMiddlewarePort = {
		async beforeToolCall(input) {
			return input.toolName === "blocked_tool"
				? { action: "block", reason: "BLOCKED-FOR-TEST" }
				: { action: "allow" };
		},
		async afterToolResult() {
			return {};
		},
	};
	const workspace = await createTestWorkspace({ memory: "TOOL-MEMORY", toolMiddleware: middleware });
	try {
		const extensionPath = await workspace.writeExtension("tools-fixture.ts", CUSTOM_EXTENSION);
		workspace.approvedExtensionPaths.push(extensionPath);
		// Rebuild the Worker with the fixture extension registered.
		await workspace.worker.stop("fixture-restart").catch(() => {});
		await workspace.startWorker({
			approvedExtensionPaths: workspace.approvedExtensionPaths,
			toolMiddleware: middleware,
		});

		const readmePath = await workspace.writeTextFile("readme.txt", "line one\nline two\n");
		const editmePath = await workspace.writeTextFile("editme.txt", "alpha beta gamma\n");
		const imagePath = await workspace.writeTextFile("pixel.png", "");
		await writeFile(imagePath, Buffer.from(PNG_1X1, "base64"));
		const bigPath = await workspace.writeTextFile(
			"big.txt",
			Array.from({ length: 2_500 }, (_, index) => `line-${index + 1}`).join("\n"),
		);
		const indexPath = join(workspace.markdownsDir, "index.md");
		const newFilePath = join(workspace.cwd, "written.txt");

		const queued = queueResponses(workspace, [
			assistantToolCalls([
				{ name: "read", arguments: { path: readmePath }, id: "read-1" },
				{ name: "write", arguments: { path: newFilePath, content: "written-by-native\n" }, id: "write-1" },
				{
					name: "edit",
					arguments: {
						path: editmePath,
						edits: [{ oldText: "beta", newText: "BETA" }],
					},
					id: "edit-1",
				},
				{ name: "bash", arguments: { command: "printf 'bash-ok\\n'" }, id: "bash-1" },
				{ name: "read", arguments: { path: imagePath }, id: "image-1" },
				{ name: "read", arguments: { path: bigPath }, id: "big-1" },
				{ name: "read", arguments: { path: indexPath }, id: "index-1" },
				{ name: "custom_tool", arguments: { value: "42" }, id: "custom-1" },
				{ name: "nested_probe", arguments: { path: readmePath }, id: "nested-1" },
				{ name: "unknown_tool", arguments: {}, id: "unknown-1" },
				{ name: "read", arguments: {}, id: "invalid-1" },
				{ name: "blocked_tool", arguments: {}, id: "blocked-1" },
				{ name: "pi_control", arguments: { command: "status" }, id: "control-1" },
			]),
			assistantText("tools complete"),
		]);

		await workspace.worker.run("exercise tools");

		assert.equal(queued.captured.length, 2);
		const results = toolResultMessages(queued.captured[1]!);
		const byId = new Map<string, (typeof results)[number]>();
		for (const result of results) {
			const id = (result as unknown as { toolCallId: string }).toolCallId;
			byId.set(id, result);
		}
		assert.equal(results.length, 13);

		for (const [id, result] of byId) {
			const text = textOf(result.content);
			assert.match(text, /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)/, `missing time for ${id}`);
		}

		const readResult = byId.get("read-1");
		assert.ok(readResult);
		assert.match(textOf(readResult.content), /line one/);
		assert.equal(readResult.isError, false);

		assert.equal(await readFile(newFilePath, "utf8"), "written-by-native\n");
		assert.equal(await readFile(editmePath, "utf8"), "alpha BETA gamma\n");
		const bashResult = byId.get("bash-1");
		assert.ok(bashResult);
		assert.match(textOf(bashResult.content), /bash-ok/);

		const imageResult = byId.get("image-1");
		assert.ok(imageResult);
		assert.equal(imageResult.content.some((block) => block.type === "image"), true);
		assert.equal(imageResult.content.some((block) => block.type === "text"), true);

		const bigResult = byId.get("big-1");
		assert.ok(bigResult);
		assert.match(textOf(bigResult.content), /Use offset=/);
		const bigMessage = workspace.session.messages.find(
			(message) =>
				message.role === "toolResult" &&
				(message as { toolCallId?: string }).toolCallId === "big-1",
		) as { details?: { truncation?: unknown } } | undefined;
		assert.ok(bigMessage?.details?.truncation);

		const indexResult = byId.get("index-1");
		assert.ok(indexResult);
		const indexText = textOf(indexResult.content);
		assert.match(indexText, /Managed Markdown statistics \(request-time; not written to index.md\)/);
		assert.match(indexText, /index\.md/);
		assert.match(indexText, /\| md名 \| words \| mtime \| readsLast24h \|/);
		assert.equal(workspace.documents.countReads("index.md"), 1);

		const customResult = byId.get("custom-1");
		assert.ok(customResult);
		const customText = textOf(customResult.content);
		assert.match(customText, /CUSTOM-OK:42/);
		assert.match(customText, /\(Current Time:/);
		const customMessage = workspace.session.messages.find(
			(message) =>
				message.role === "toolResult" &&
				(message as { toolCallId?: string }).toolCallId === "custom-1",
		) as
			| { details?: { keep?: boolean }; usage?: { totalTokens?: number }; isError: boolean }
			| undefined;
		assert.equal(customMessage?.isError, false);
		assert.equal(customMessage?.details?.keep, true);
		assert.equal(customMessage?.usage?.totalTokens, 3);

		const nestedResult = byId.get("nested-1");
		assert.ok(nestedResult);
		const nestedText = textOf(nestedResult.content);
		assert.match(nestedText, /NESTED-BEGIN/);
		assert.match(nestedText, /line one/);
		assert.match(nestedText, /NESTED-END/);
		// The nested read is finalized at its own tool_result boundary (before the
		// parent's final Current Time line) and is retained as a nested call record.
		assert.equal((nestedText.match(/\(Current Time:/g) ?? []).length >= 1, true);
		assert.equal(workspace.worker.nestedToolResults.length, 1);
		assert.equal(typeof workspace.worker.nestedToolResults[0]?.parentToolCallId, "string");

		const unknown = byId.get("unknown-1");
		assert.ok(unknown);
		assert.equal(unknown.isError, true);
		assert.match(textOf(unknown.content), /not found/i);
		const invalid = byId.get("invalid-1");
		assert.ok(invalid);
		assert.equal(invalid.isError, true);
		const blocked = byId.get("blocked-1");
		assert.ok(blocked);
		assert.equal(blocked.isError, true);
		assert.match(textOf(blocked.content), /BLOCKED-FOR-TEST/);
		const control = byId.get("control-1");
		assert.ok(control);
		assert.equal(control.isError, true);
		assert.match(textOf(control.content), /not found/i);
		assert.doesNotMatch(textOf(control.content), /SHOULD-NOT-RUN/);
	} finally {
		await workspace.cleanup();
	}
});
