import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { RSI_ROOT, startRuntimeHarness, waitFor } from "./helpers.ts";

const UNPLANNED_EXTENSION = `export default function unplanned(pi) {
  pi.registerTool({
    name: "unplanned_agent_tool",
    label: "Unplanned tool",
    description: "Must never be loaded into the active Agent.",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "UNEXPECTED-EXTENSION-LOAD" }], details: {} }; },
  });
}
`;

const MCP_SERVER = `import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "agent-mcp-fixture", version: "1.0.0" } };
  } else if (request.method === "tools/list") {
    result = { tools: [{ name: "echo", description: "Echo a message.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }] };
  } else if (request.method === "tools/call") {
    result = { content: [{ type: "text", text: "MCP-OK: " + request.params.arguments.message }] };
  } else if (request.method === "ping") {
    result = {};
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Put the real `pi` shim on the shell PATH on both Git Bash and Linux. */
function piCommand(command: string): string {
	const bin = join(RSI_ROOT, "bin").replaceAll("\\", "/");
	const nodeBin = dirname(process.execPath).replaceAll("\\", "/");
	return [
		"set -e",
		`RSI_BIN=${shellQuote(bin)}`,
		`NODE_BIN=${shellQuote(nodeBin)}`,
		'if command -v cygpath >/dev/null 2>&1; then RSI_BIN="$(cygpath -u "$RSI_BIN")"; NODE_BIN="$(cygpath -u "$NODE_BIN")"; fi',
		'export PATH="$RSI_BIN:$NODE_BIN:$PATH"',
		'export MSYS2_ARG_CONV_EXCL="/reload"',
		`pi ${command}`,
	].join("\n");
}

function findResult(captures: Awaited<ReturnType<Awaited<ReturnType<typeof startRuntimeHarness>>["captures"]>>, id: string) {
	return captures.flatMap((capture) => capture.messages).find((message) => message.toolCallId === id);
}

test("an Agent-written Pi extension is unavailable and pi /reload is forbidden", { timeout: 120_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const pluginPath = join(harness.paths.pluginSourceDir, "unplanned.ts");
		await harness.setScript([
			{ toolCalls: [{ name: "write", id: "write-extension", arguments: { path: pluginPath, content: UNPLANNED_EXTENSION } }] },
			{ toolCalls: [{ name: "bash", id: "request-reload", arguments: { command: piCommand("/reload") } }] },
			{ text: "End the current turn so the requested reload can settle." },
			{ toolCalls: [
				{ name: "unplanned_agent_tool", id: "call-unplanned", arguments: {} },
				{ name: "pi_control", id: "call-removed-control", arguments: { command: "status" } },
			] },
			{ text: "Both unplanned tools are unavailable." },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return findResult(current, "call-removed-control") ? current : undefined;
		}, "rejection of unplanned tools", 90_000);
		assert.equal(findResult(captures, "write-extension")?.isError, false);
		const reload = findResult(captures, "request-reload");
		assert.equal(reload?.isError, true);
		assert.match(reload?.text ?? "", /forbidden/iu);
		for (const id of ["call-unplanned", "call-removed-control"]) {
			const result = findResult(captures, id);
			assert.equal(result?.isError, true);
			assert.match(result?.text ?? "", /not found|not available/iu);
		}
		assert.equal(await readFile(pluginPath, "utf8"), UNPLANNED_EXTENSION);
		const status = await harness.runtime.status();
		assert.equal((status.extensionPaths ?? []).some((path) => path.includes("unplanned")), false);
		assert.ok((status.extensionPaths ?? []).some((path) => path.includes("pi-continuity")));
		assert.ok((status.extensionPaths ?? []).some((path) => path.includes("pi-better-web-search")));
		const state = await harness.runtime.coordinator.currentState();
		assert.ok(state.active);
		const candidate = await harness.runtime.candidateStore.verifyCandidate(state.active.path);
		assert.deepEqual(candidate.manifest.entries, []);
		assert.deepEqual(candidate.manifest.sources, []);

		// Old content-addressed snapshots must not bypass the new policy through
		// candidate IDs, Worker projection, or Watchdog recovery.
		const legacy = await harness.runtime.candidateStore.prepareCandidate({
			generation: 99,
			sourceRoots: [{ id: "legacy", path: harness.paths.pluginSourceDir, discovery: "extensions" }],
			now: new Date(),
		});
		await assert.rejects(harness.runtime.reloadService.workerView(legacy), /Loading additional Pi extensions is disabled/u);
		await assert.rejects(harness.runtime.reloadService.lkgCandidate(legacy.path), /Loading additional Pi extensions is disabled/u);
		await assert.rejects(
			harness.runtime.reloadService.prepareSupervisorReload({ reason: "legacy candidate", candidateId: legacy.candidateId }),
			/Loading additional Pi extensions is disabled/u,
		);
	} catch (error) {
		console.error(`CAPTURES:\n${JSON.stringify((await harness.captures()).slice(-10), null, 2)}`);
		console.error(`LOGS:\n${harness.logs.join("\n")}`);
		throw error;
	} finally {
		await harness.cleanup();
	}
});

test("an Agent-written Skill is discovered and activated without a Pi reload command", { timeout: 120_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const skillPath = join(harness.paths.piAgentDir, "skills", "agent-skill", "SKILL.md");
		await harness.setScript([
			{ toolCalls: [{ name: "write", id: "write-skill", arguments: {
				path: skillPath,
				content: "---\nname: agent-skill\ndescription: AGENT-SKILL-DESCRIPTION\n---\n\nSkill body.\n",
			} }] },
			{ text: "The Skill files are ready." },
			{ text: "The next turn sees the Skill." },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.some((capture) => capture.system.includes("AGENT-SKILL-DESCRIPTION")) ? current : undefined;
		}, "automatically activated Skill", 90_000);
		assert.equal(findResult(captures, "write-skill")?.isError, false);
		assert.equal((await harness.runtime.status()).skillCount, 1);
		assert.ok(captures.some((capture) => capture.messages.some((message) =>
			(message.text ?? "").includes("Skill/MCP configuration was reloaded"))));
	} finally {
		await harness.cleanup();
	}
});

test("a sixth Skill is rejected before activation and the existing Worker remains usable", { timeout: 120_000 }, async () => {
	const harness = await startRuntimeHarness({
		beforeStart: async ({ piAgentDir }) => {
			for (let i = 1; i <= 5; i++) {
				const dir = join(piAgentDir, "skills", `skill-${i}`);
				await mkdir(dir, { recursive: true });
				await writeFile(join(dir, "SKILL.md"), `---\nname: skill-${i}\ndescription: Skill ${i}\n---\n\nBody.\n`);
			}
		},
	});
	try {
		const pid = harness.runtime.workerPid;
		const skillPath = join(harness.paths.piAgentDir, "skills", "sixth", "SKILL.md");
		await harness.setScript([
			{ toolCalls: [{ name: "write", id: "write-sixth-skill", arguments: {
				path: skillPath,
				content: "---\nname: sixth\ndescription: Sixth Skill\n---\n\nBody.\n",
			} }] },
			{ text: "Sixth Skill is written." },
			{ text: "Inspect the rejection." },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.some((capture) => capture.messages.some((message) =>
				/At most 5 Skills may be discovered/u.test(message.text ?? ""))) ? current : undefined;
		}, "Skill cap rejection notice", 90_000);
		assert.equal(findResult(captures, "write-sixth-skill")?.isError, false);
		assert.equal(harness.runtime.workerPid, pid);
		assert.equal((await harness.runtime.status()).skillCount, 5);
	} finally {
		await harness.cleanup();
	}
});

test("Agent configures a native MCP server and calls its tool after automatic activation", { timeout: 120_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const serverPath = join(harness.paths.workspaceDir, "agent-mcp-server.mjs");
		const nodePath = process.execPath.replaceAll("\\", "/");
		const command = `mcp add agent_mcp --exposure direct -- ${shellQuote(nodePath)} ${shellQuote(serverPath.replaceAll("\\", "/"))}`;
		await harness.setScript([
			{ toolCalls: [{ name: "write", id: "write-server", arguments: { path: serverPath, content: MCP_SERVER } }] },
			{ toolCalls: [{ name: "bash", id: "add-mcp", arguments: { command: piCommand(command) } }] },
			{ text: "End the turn to activate the MCP configuration." },
			{ toolCalls: [{ name: "mcp__agent_mcp__echo", id: "call-mcp", arguments: { message: "hello" } }] },
			{ text: "MCP tool returned." },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return findResult(current, "call-mcp") ? current : undefined;
		}, "Agent-configured MCP tool result", 90_000);
		assert.equal(findResult(captures, "write-server")?.isError, false);
		const add = findResult(captures, "add-mcp");
		assert.equal(add?.isError, false);
		assert.match(add?.text ?? "", /Added global MCP server/u);
		const result = findResult(captures, "call-mcp");
		assert.equal(result?.isError, false);
		assert.match(result?.text ?? "", /MCP-OK: hello/u);
		assert.match(result?.text ?? "", /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)$/u);
		const config = JSON.parse(await readFile(join(harness.paths.piAgentDir, "mcp.json"), "utf8"));
		assert.ok(config.mcpServers.agent_mcp);
		assert.equal((await harness.runtime.status()).mcpServerCount, 1);
	} catch (error) {
		console.error(`CAPTURES:\n${JSON.stringify((await harness.captures()).slice(-10), null, 2)}`);
		console.error(`LOGS:\n${harness.logs.join("\n")}`);
		throw error;
	} finally {
		await harness.cleanup();
	}
});
