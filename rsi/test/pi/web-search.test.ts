import { test } from "node:test";
import assert from "node:assert/strict";
import {
	assistantText,
	assistantToolCalls,
	createTestWorkspace,
	queueResponses,
	toolResultMessages,
	withMockFetch,
} from "./helpers.ts";

function sseResponse(): Response {
	const item = {
		type: "web_search_call",
		id: "ws_test_1",
		status: "completed",
		action: { query: "rsi sandbox", sources: [{ url: "https://example.test/source", title: "Example" }] },
	};
	const events = [
		{ type: "response.output_item.done", item },
		{
			type: "response.completed",
			response: {
				output: [
					item,
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "fixture answer", annotations: [] }],
					},
				],
			},
		},
	];
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

test("the pinned pi-better-web-search tool is exposed by provider capability and runs with a mock fetch", async () => {
	const workspace = await createTestWorkspace({ withWebProvider: true });
	const mock = withMockFetch((url) => {
		assert.match(url, /fake-openai\.invalid/);
		return sseResponse();
	});
	try {
		assert.equal(workspace.session.getActiveToolNames().includes("web_search"), true);
		assert.equal(
			workspace.worker.resourceLoader
				.getExtensions()
				.extensions.some((extension) => extension.path.includes("pi-better-web-search")),
			true,
		);

		const queued = queueResponses(workspace, [
			assistantToolCalls([{ name: "web_search", arguments: { query: "rsi sandbox" }, id: "web-1" }]),
			assistantText("searched"),
		]);
		await workspace.worker.run("search the web");

		assert.equal(mock.calls.length, 1);
		assert.match(mock.calls[0]!.url, /fake-openai\.invalid/);
		const result = toolResultMessages(queued.captured[1]!).find((entry) => entry.toolName === "web_search");
		assert.ok(result);
		assert.equal(result.isError, false);
		const text = result.content
			.map((block) => block.text ?? "")
			.filter((part) => part.length > 0)
			.join("\n");
		assert.match(text, /web_search_call|ws_test_1|rsi sandbox/);
		assert.match(text, /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)/);
		const sessionResult = workspace.session.messages.find(
			(message) =>
				message.role === "toolResult" &&
				(message as { toolCallId?: string }).toolCallId === "web-1",
		) as { details?: { provider?: string; model?: string; resultCount?: number }; isError: boolean } | undefined;
		assert.equal(sessionResult?.details?.provider, "openai");
		assert.equal(sessionResult?.details?.model, "gpt-5-web-test");
		assert.equal(sessionResult?.details?.resultCount, 1);
	} finally {
		mock.restore();
		await workspace.cleanup();
	}
});

test("without a capable authenticated provider the plugin tool is not activated and no fake tool is substituted", async () => {
	const workspace = await createTestWorkspace({ withWebProvider: false });
	try {
		assert.equal(workspace.session.getActiveToolNames().includes("web_search"), false);
		const queued = queueResponses(workspace, [
			assistantToolCalls([{ name: "web_search", arguments: { query: "unavailable" }, id: "web-2" }]),
			assistantText("no tool"),
		]);
		await workspace.worker.run("try search");
		const result = toolResultMessages(queued.captured[1]!).find((entry) => entry.toolName === "web_search");
		assert.ok(result);
		assert.equal(result.isError, true);
		const text = result.content.map((block) => block.text ?? "").join("\n");
		assert.match(text, /not found|not available/i);
		assert.match(text, /\(Current Time:/);
	} finally {
		await workspace.cleanup();
	}
});
