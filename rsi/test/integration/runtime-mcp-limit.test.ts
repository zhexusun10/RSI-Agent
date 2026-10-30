import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { RSI_ROOT, startRuntimeHarness, waitFor } from "./helpers.ts";

function piCommand(command: string): string {
	const bin = join(RSI_ROOT, "bin").replaceAll("\\", "/");
	const nodeBin = dirname(process.execPath).replaceAll("\\", "/");
	return [
		"set -e",
		`RSI_BIN='${bin}'`,
		`NODE_BIN='${nodeBin}'`,
		'if command -v cygpath >/dev/null 2>&1; then RSI_BIN="$(cygpath -u "$RSI_BIN")"; NODE_BIN="$(cygpath -u "$NODE_BIN")"; fi',
		'export PATH="$RSI_BIN:$NODE_BIN:$PATH"',
		'export MSYS2_ARG_CONV_EXCL="/reload"',
		`pi ${command}`,
	].join("\n");
}

test("a sixth MCP server is rejected before automatic activation and the model can remove it", { timeout: 120_000 }, async () => {
	const harness = await startRuntimeHarness({
		beforeStart: async ({ piAgentDir }) => {
			await writeFile(join(piAgentDir, "mcp.json"), JSON.stringify({
				mcpServers: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
					`server${index + 1}`,
					{ url: `http://127.0.0.1:9/server${index + 1}`, enabled: false },
				])),
			}));
		},
	});
	try {
		assert.equal((await harness.runtime.status()).mcpServerCount, 5);
		await harness.setScript([
			{ toolCalls: [{ name: "bash", id: "add-sixth", arguments: { command: piCommand("mcp add sixth --url http://127.0.0.1:9/sixth") } }] },
			{ text: "The new MCP configuration is ready for automatic validation." },
			{ toolCalls: [{ name: "bash", id: "remove-sixth", arguments: { command: piCommand("mcp remove sixth") } }] },
			{ text: "The invalid MCP entry was removed." },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.some((capture) => capture.messages.some((message) => message.toolCallId === "remove-sixth"))
				? current : undefined;
		}, "MCP cap rejection and repair", 90_000);
		const messages = captures.flatMap((capture) => capture.messages);
		const byId = (id: string) => messages.find((message) => message.toolCallId === id);
		assert.equal(byId("add-sixth")?.isError, false);
		assert.ok(messages.some((message) => /At most 5 MCP servers.*found 6/iu.test(message.text ?? "")));
		assert.equal(byId("remove-sixth")?.isError, false);
		assert.equal((await harness.runtime.status()).mcpServerCount, 5);
		const config = JSON.parse(await readFile(join(harness.paths.piAgentDir, "mcp.json"), "utf8"));
		assert.equal(Object.keys(config.mcpServers).length, 5);
	} catch (error) {
		console.error(`CAPTURES:\n${JSON.stringify((await harness.captures()).slice(-10), null, 2)}`);
		console.error(`LOGS:\n${harness.logs.join("\n")}`);
		throw error;
	} finally {
		await harness.cleanup();
	}
});
