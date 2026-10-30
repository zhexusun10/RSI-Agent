import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assistantText,
	assistantToolCalls,
	createTestWorkspace,
	queueResponses,
	toolResultMessages,
} from "../pi/helpers.ts";

const OVER_CAP_CANDIDATE = `
import { Type } from "typebox";

export default function overCapCandidate(pi) {
	for (let index = 1; index <= 6; index++) {
		pi.registerMcpServer("rejected-mcp-" + index, {
			type: "http",
			url: "http://127.0.0.1:9/mcp-" + index,
			enabled: false,
		});
	}
	pi.registerTool({
		name: "rejected_candidate_still_loaded",
		label: "rejected_candidate_still_loaded",
		description: "Must not remain callable after the reload is rejected.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "REJECTED-CANDIDATE-STILL-LOADED" }], details: {} };
		},
	});
}
`;

/**
 * A reload can fail after Pi's AgentSession has already built the replacement
 * extension runner. Such a rejection must not leave the rejected candidate's
 * tools/MCP registrations active in the running Worker. Preflight success is
 * not permission to keep an unapproved generation loaded after a failed bind.
 */
test("a reload rejected before session_start does not leave candidate tools or MCP servers active", { timeout: 60_000 }, async () => {
	const workspace = await createTestWorkspace({});
	try {
		const extensionPath = await workspace.writeExtension("over-cap-candidate.ts", OVER_CAP_CANDIDATE);
		await assert.rejects(
			workspace.worker.requestReload({ approvedExtensionPaths: [extensionPath] }),
			/MCP|RESOURCE_CAP|At most|sixth|cap/iu,
		);

		const runtime = workspace.worker.resourceLoader.getExtensions().runtime;
		assert.ok(
			runtime.mcpServers.list().length <= 5,
			"a rejected reload must not leave an over-cap MCP server set active",
		);
		assert.equal(
			workspace.worker.session.getActiveToolNames().includes("rejected_candidate_still_loaded"),
			false,
			"a rejected reload must not leave its tool callable",
		);

		const queued = queueResponses(workspace, [
			assistantToolCalls(
				[{ name: "rejected_candidate_still_loaded", arguments: {}, id: "rejected-probe" }],
			),
			assistantText("rejected tool probe complete"),
		]);
		await workspace.worker.run("probe rejected candidate tool");
		const result = toolResultMessages(queued.captured[1]!).find(
			(entry) => entry.toolName === "rejected_candidate_still_loaded",
		);
		assert.ok(result);
		assert.equal(result.isError, true);
		assert.doesNotMatch(result.content.map((block) => block.text ?? "").join("\n"), /REJECTED-CANDIDATE-STILL-LOADED/u);
	} finally {
		await workspace.cleanup();
	}
});
