import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startRuntimeHarness, waitFor } from "./helpers.ts";

function sse(): string {
	const item = {
		type: "web_search_call",
		id: "ws_integration_1",
		status: "completed",
		action: { query: "rsi sandbox", sources: [{ url: "https://example.test/source", title: "Example" }] },
	};
	return [
		{ type: "response.output_item.done", item },
		{
			type: "response.completed",
			response: {
				output: [
					item,
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture search answer", annotations: [] }] },
				],
			},
		},
	].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

test("the two pinned npm plugins load, web_search uses the real plugin, continuity does not duplicate a prompt, and 5 MCP/5 Skill sources are counted independently", { timeout: 120_000 }, async () => {
	let requests = 0;
	const server: Server = createServer((_request, response) => {
		requests += 1;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(sse());
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no HTTP test port");
	const harness = await startRuntimeHarness({
		openAiBaseUrl: `http://127.0.0.1:${address.port}`,
		beforeStart: async ({ piAgentDir }) => {
			for (let index = 1; index <= 5; index++) {
				const dir = join(piAgentDir, "skills", `skill-${index}`);
				await mkdir(dir, { recursive: true });
				await writeFile(
					join(dir, "SKILL.md"),
					`---\nname: skill-${index}\ndescription: Integration skill ${index}.\n---\n\nskill ${index} body\n`,
				);
			}
			await writeFile(
				join(piAgentDir, "mcp.json"),
				JSON.stringify({
					mcpServers: Object.fromEntries(
						Array.from({ length: 5 }, (_, index) => [
							`mcp-${index + 1}`,
							{ type: "http", url: `http://127.0.0.1:9/mcp-${index + 1}`, enabled: false },
						]),
					),
				}),
			);
		},
	});
	try {
		await harness.setScript([
			{ toolCalls: [{ name: "web_search", id: "web-1", arguments: { query: "rsi sandbox" } }] },
			{ text: "search completed" },
			{ text: "truncated partial", stopReason: "length" },
			{ text: "continuity completed the response" },
			{ text: "stop integration loop", stopReason: "error", errorMessage: "stop" },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			const text = current.map((entry) => JSON.stringify(entry)).join("\n");
			return text.includes("continuity completed the response") ? current : undefined;
		}, "web search and continuity requests", 60_000);
		const webResult = captures
			.flatMap((entry) => entry.messages)
			.find((message) => message.role === "toolResult" && message.toolName === "web_search");
		assert.ok(webResult);
		assert.match(webResult.text ?? "", /ws_integration_1|rsi sandbox/);
		assert.match(webResult.text ?? "", /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)$/);
		assert.ok(requests >= 1, "the pinned web-search plugin made the real HTTP request");

		const partial = captures.find((entry) => entry.index === 2);
		const continuityRequest = captures.find((entry) => entry.index === 3);
		assert.ok(partial);
		assert.ok(continuityRequest);
		const runtimeUserCount = (entry: typeof partial) =>
			entry.messages.filter((message) => message.role === "user" && (message.text ?? "").startsWith("Runtime state:")).length;
		assert.equal(runtimeUserCount(continuityRequest), runtimeUserCount(partial!));
		assert.match(JSON.stringify(continuityRequest), /preceding provider response was interrupted/);
		assert.equal(
			continuityRequest.messages.filter(
				(message) => message.role === "user" && (message.text ?? "").startsWith("Runtime state:"),
			).length,
			partial.messages.filter(
				(message) => message.role === "user" && (message.text ?? "").startsWith("Runtime state:"),
			).length,
		);

		const status = await harness.runtime.status();
		assert.equal(status.skillCount, 5);
		assert.equal(status.mcpServerCount, 5);
		assert.ok((status.extensionPaths ?? []).some((path) => path.includes("pi-continuity")));
		assert.ok((status.extensionPaths ?? []).some((path) => path.includes("pi-better-web-search")));
	} catch (error) {
		console.error(`LOGS:\n${harness.logs.join("\n")}`);
		throw error;
	} finally {
		await harness.cleanup();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
});
