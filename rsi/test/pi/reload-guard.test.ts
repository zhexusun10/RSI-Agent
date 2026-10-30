import { test } from "node:test";
import assert from "node:assert/strict";
import {
	assistantText,
	assistantToolCalls,
	createTestEnvironment,
	createTestWorkspace,
	queueResponses,
	toolResultMessages,
} from "./helpers.ts";

const V1 = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function reloadFixtureV1(pi: ExtensionAPI): void {
	pi.registerCommand("test-reload", {
		description: "Fixture reload command",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});
}
`;

const V2 = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function reloadFixtureV2(pi: ExtensionAPI): void {
	pi.registerCommand("test-reload", {
		description: "Fixture reload command",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});
	pi.registerTool({
		name: "new_tool",
		label: "new_tool",
		description: "Tool introduced by the approved reload candidate.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "NEW-TOOL-OK" }], details: { reloaded: true } };
		},
	});
}
`;

test("all reload entries require external preflight, and new extension tools become callable", async () => {
	const environment = await createTestEnvironment({});
	try {
		const v1 = await environment.writeExtension("reload-v1.ts", V1);
		environment.approvedExtensionPaths = [v1];
		await environment.startWorker({ approvedExtensionPaths: [v1] });
		const worker = environment.worker!;
		const session = worker.session;
		assert.equal(environment.session?.getActiveToolNames().includes("new_tool"), false);

		// Command-context reload goes through the same external preflight path.
		await session.prompt("/test-reload", { expandPromptTemplates: true });
		assert.equal(environment.reload.preflights.length, 1);
		assert.equal(environment.reload.starts.length, 1);

		const v2 = await environment.writeExtension("reload-v2.ts", V2);
		const reloaded = await worker.requestReload({ approvedExtensionPaths: [v2] });
		assert.equal(reloaded.report.ok, true);
		assert.equal(environment.reload.preflights.length, 2);
		assert.equal(environment.reload.starts.length, 2);
		assert.equal(session.getActiveToolNames().includes("new_tool"), true);

		// The returned session keeps the control guard after reload.
		await assert.rejects(session.setModel(environment.model), /forbidden|not available/i);
		assert.throws(() => session.setThinkingLevel("high"), /forbidden|not available/i);

		const queued = queueResponses(environment, [
			assistantToolCalls([{ name: "new_tool", arguments: {}, id: "new-tool-1" }]),
			assistantText("new tool complete"),
		]);
		await worker.run("call the reloaded tool");
		const newToolResult = toolResultMessages(queued.captured[1]!).find((result) => result.toolName === "new_tool");
		assert.ok(newToolResult);
		assert.match(
			newToolResult.content.map((block) => block.text ?? "").join("\n"),
			/NEW-TOOL-OK/,
		);
		assert.match(
			newToolResult.content.map((block) => block.text ?? "").join("\n"),
			/\(Current Time:/,
		);

		// A direct session.reload() is also intercepted before the real reload.
		await session.reload();
		assert.equal(environment.reload.preflights.length, 3);
		assert.equal(environment.reload.starts.length, 3);

		const afterReload = queueResponses(environment, [
			assistantToolCalls([
				{
					name: "read",
					arguments: { path: `${environment.markdownsDir}/index.md` },
					id: "after-reload-read",
				},
			]),
			assistantText("still decorated"),
		]);
		await worker.run("verify listeners after reload");
		const readResult = toolResultMessages(afterReload.captured[1]!).find(
			(result) => result.toolName === "read",
		);
		assert.ok(readResult);
		const readText = readResult.content.map((block) => block.text ?? "").join("\n");
		assert.match(readText, /Managed Markdown statistics/);
		assert.match(readText, /\(Current Time:/);
		assert.ok(environment.health.observations.length >= 1);
	} finally {
		await environment.cleanup();
	}
});

test("a reload preflight failure does not run session.reload and is reported", async () => {
	const workspace = await createTestWorkspace({});
	try {
		workspace.reload.nextOk = false;
		await assert.rejects(workspace.worker.requestReload(), /Preflight rejected|PREFLIGHT_FAILED/);
		assert.equal(workspace.reload.preflights.length, 1);
		assert.equal(workspace.reload.starts.length, 0);
		assert.equal(workspace.worker.status().state, "idle");
		// The worker remains usable and the guard remains installed.
		await assert.rejects(workspace.session.setModel(workspace.model), /forbidden|not available/i);
		workspace.reload.nextOk = true;
		const queued = queueResponses(workspace, [assistantText("still alive")]);
		await workspace.worker.run("post-failure prompt");
		assert.equal(queued.captured.length, 1);
	} finally {
		await workspace.cleanup();
	}
});
