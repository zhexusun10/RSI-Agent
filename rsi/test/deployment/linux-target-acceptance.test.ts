import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { SystemClock } from "../../src/shared/time.ts";
import { RecoveryNoticeStore } from "../../src/watchdog/notifications.ts";
import {
	TARGET_RSI_ROOT,
	TARGET_WORKER_GID,
	TARGET_WORKER_UID,
	detectTargetPrerequisites,
	forceRemove,
	readJson,
	runSandboxCommand,
	startTargetHarness,
	waitFor,
} from "./linux-target-harness.ts";

const detection = await detectTargetPrerequisites();
const skip = detection.skipReason;
const targetTest = (timeout: number) => ({ timeout, ...(skip === undefined ? {} : { skip }) });

function killWorkerPid(pid: number, signal = "SIGKILL"): void {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") {
			const result = spawnSync("/usr/bin/setpriv", [
				`--reuid=${TARGET_WORKER_UID}`,
				`--regid=${TARGET_WORKER_GID}`,
				"--clear-groups",
				"kill",
				`-${signal.replace(/^SIG/, "")}`,
				String(pid),
			]);
			if (result.status !== 0) {
				throw new Error(`setpriv kill failed: ${result.stderr?.toString() ?? "unknown"}`);
			}
			return;
		}
		throw error;
	}
}

function extensionSource(tool: string, marker: string): string {
	return `export default function targetPlugin(pi) {
	pi.registerTool({
		name: "${tool}",
		label: "${tool}",
		description: "Target validation tool ${tool}.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			return { content: [{ type: "text", text: "${marker}" }], details: { marker: "${marker}" } };
		},
	});
}
`;
}

const SYNTAX_ERROR = `export default function broken( {
	pi.registerTool({ name: "never_loaded" });
}
`;

const TOP_LEVEL_LOOP = `while (true) {
	// Deliberately blocks the Mock import child; the parent deadline must kill it.
}
export default function neverReached(pi) {
	pi.registerTool({ name: "never_loaded_loop" });
}
`;

const DELAYED_CRASH = `setTimeout(() => {
	throw new Error("TARGET-DELAYED-CRASH");
}, 3000);
export default function delayedCrashPlugin(pi) {
	pi.registerTool({
		name: "delayed_crash_tool",
		label: "delayed_crash_tool",
		description: "Registers, then crashes the Worker later.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			return { content: [{ type: "text", text: "DELAYED-CRASH-TOOL" }], details: {} };
		},
	});
}
`;

const DELAYED_HANG = `setTimeout(() => {
	const stop = Date.now() + 600000;
	while (Date.now() < stop) {
		// Deliberately stops the Worker event loop after the candidate is loaded.
	}
}, 3000);
export default function delayedHangPlugin(pi) {
	pi.registerTool({
		name: "delayed_hang_tool",
		label: "delayed_hang_tool",
		description: "Registers, then hangs the Worker later.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			return { content: [{ type: "text", text: "DELAYED-HANG-TOOL" }], details: {} };
		},
	});
}
`;

test(
	"clean volumes start the first real bwrap Worker; raw code/prompt/Memory/candidate writes stay read-only, aliases/proc/fd/caps/PID are checked, and a broker update is visible immediately",
	targetTest(300_000),
	async () => {
		if (skip !== undefined) return;
		const harness = await startTargetHarness({ expectEmptyVolumes: process.env.RSI_TARGET_EXPECT_EMPTY === "1" });
		try {
			const state = await waitFor(async () => {
				const current = await harness.runtime.coordinator.currentState();
				return current.active?.generation === 1 ? current : undefined;
			}, "baseline generation 1");
			const baselineDigest = state.active?.digest;
			assert.ok(baselineDigest);
			const hostWorkerPid = await waitFor(() => harness.runtime.workerPid, "host Worker pid");
			const health = await waitFor(async () => {
				const current = await readJson<Record<string, any>>(join(harness.stateDir, "runtime", "health.json")).catch(
					() => null,
				);
				return current?.worker?.state === "healthy" ? current : undefined;
			}, "healthy baseline health file");
			assert.equal(health.worker.pid, hostWorkerPid);
			assert.equal(health.supervisor.state, "running");

			const watchdog = await waitFor(async () => {
				const current = await readJson<Record<string, any>>(harness.paths.watchdogStateFile).catch(() => null);
				return current?.workerPid === hostWorkerPid ? current : undefined;
			}, "Watchdog records the host bwrap PID rather than the namespace PID");
			assert.equal(watchdog.workerPid, hostWorkerPid);

			const activeGeneration = state.active;
			assert.ok(activeGeneration);
			const relativeCandidate = activeGeneration.path
				.slice(harness.paths.snapshotDir.length + 1)
				.replaceAll("\\", "/");
			const candidateSandboxPath = `/run/rsi-plugins/${relativeCandidate}/candidate.json`;
			const prompt = harness.promptFile;
			const promptBefore = await readFile(prompt, "utf8");
			const memory = harness.paths.memoryFile;
			const piSource = join(harness.paths.piSourceDir, "package.json");
			const rsiSource = join(TARGET_RSI_ROOT, "src", "worker-main.ts");
			const pluginFile = join(harness.paths.pluginSourceDir, "worker-created.ts");
			const workspaceFile = join(harness.paths.workspaceDir, "worker-created.txt");
			const tmpFile = `/tmp/rsi-target-worker-${process.pid}.txt`;
			const probe = [
				"set +e",
				`prompt=${JSON.stringify(prompt)}`,
				`memory=${JSON.stringify(memory)}`,
				`pi_source=${JSON.stringify(piSource)}`,
				`rsi_source=${JSON.stringify(rsiSource)}`,
				`candidate=${JSON.stringify(candidateSandboxPath)}`,
				`plugin=${JSON.stringify(pluginFile)}`,
				`workspace=${JSON.stringify(workspaceFile)}`,
				`tmp=${JSON.stringify(tmpFile)}`,
				"attempt(){ if printf HACK > \"$2\" 2>/dev/null; then echo \"WRITE_OK:$1\"; else echo \"WRITE_FAIL:$1\"; fi; }",
				"cmd(){ label=\"$1\"; shift; if \"$@\" >/dev/null 2>&1; then echo \"CMD_OK:$label\"; else echo \"CMD_FAIL:$label\"; fi; }",
				'attempt prompt "$prompt"',
				'attempt memory "$memory"',
				'attempt pi_source "$pi_source"',
				'attempt rsi_source "$rsi_source"',
				'attempt candidate_target "$candidate"',
				'attempt plugin_edit "$plugin"',
				'attempt workspace "$workspace"',
				'attempt ordinary_tmp "$tmp"',
				'cmd rename_rsi mv ' + JSON.stringify(TARGET_RSI_ROOT) + ' ' + JSON.stringify(`${TARGET_RSI_ROOT}.moved`),
				'ln -sfn ' + JSON.stringify(join(TARGET_RSI_ROOT, "src")) + ' "$workspace/rsi-link"',
				'attempt symlink_rsi "$workspace/rsi-link/worker-main.ts"',
				'ln -sfn "$memory" "$workspace/memory-link"',
				'attempt symlink_memory "$workspace/memory-link"',
				'attempt proc_self_root "/proc/self/root$rsi_source"',
				'attempt proc_pid1_root "/proc/1/root$rsi_source"',
				'exec 9<"$prompt"',
				'if printf HACK >&9 2>/dev/null; then echo WRITE_OK:fd; else echo WRITE_FAIL:fd; fi',
				'exec 9<&-',
				'if mount --bind "$workspace" ' + JSON.stringify(join(TARGET_RSI_ROOT, "src")) + ' 2>/dev/null; then echo CMD_OK:mount_bind; umount ' + JSON.stringify(join(TARGET_RSI_ROOT, "src")) + ' 2>/dev/null; else echo CMD_FAIL:mount_bind; fi',
				'if command -v unshare >/dev/null 2>&1; then if unshare -Ur true 2>/dev/null; then echo NESTED_USERNS:allowed; else echo NESTED_USERNS:denied; fi; else echo NESTED_USERNS:unavailable; fi',
				'echo "UID=$(id -u)"',
				'echo "GID=$(id -g)"',
				'echo "GROUPS=$(id -G)"',
				'echo "CAP:$(grep \'^CapEff:\' /proc/self/status | tr -d "[:space:]")"',
				'echo "NS_PID=$$"',
				'echo "NSPID=$(grep \'^NSpid:\' /proc/self/status | tr -d "[:space:]")"',
				'if test -e "/proc/${RSI_TARGET_SUPERVISOR_PID:-0}/root" && test "${RSI_TARGET_SUPERVISOR_PID:-0}" != "$$" && grep -q "linux-target" "/proc/${RSI_TARGET_SUPERVISOR_PID:-0}/cmdline" 2>/dev/null; then echo EXTERNAL_PROC:visible; else echo EXTERNAL_PROC:hidden; fi',
				"node -e " + JSON.stringify(
					[
						"const fs=require('node:fs');",
						`const paths=${JSON.stringify({ prompt, memory, plugin: pluginFile, workspace: workspaceFile })};`,
						"const out=[];",
						"for (const [name,file] of Object.entries(paths)) { try { fs.writeFileSync(file,'NODE_HACK'); out.push('NODE_OK:'+name); } catch { out.push('NODE_FAIL:'+name); } }",
						"console.log(out.join('\\n'));",
					].join(""),
				),
				"exit 0",
			].join("\n");
			const waitForBroker = [
				`for i in $(seq 1 400); do`,
				`  if grep -q 'TARGET-BROKER-UPDATE-VISIBLE' ${JSON.stringify(memory)} 2>/dev/null; then`,
				"    cat " + JSON.stringify(memory),
				"    exit 0",
				"  fi",
				"  sleep 0.05",
				"done",
				"echo BROKER_TIMEOUT",
				"exit 9",
			].join("\n");
			await harness.setScript([
				{
					toolCalls: [
						{
							name: "bash",
							id: "target-sandbox-probe",
							arguments: { command: probe },
						},
					],
				},
				{ text: "sandbox probe complete" },
				{ toolCalls: [{ name: "bash", id: "target-broker-wait", arguments: { command: waitForBroker } }] },
				{ text: "target baseline complete", stopReason: "error", errorMessage: "stop target baseline" },
			]);
			const brokerUpdate = (async () => {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 4_000));
				const temporary = join(harness.paths.markdownsDir, ".Memory.target.tmp");
				await writeFile(temporary, "TARGET-BROKER-UPDATE-VISIBLE\n", { mode: 0o644 });
				await rename(temporary, memory);
			})();
			const captures = await waitFor(async () => {
				const current = await harness.captures();
				const sandbox = current.some((entry) =>
					entry.messages.some((message) => message.toolCallId === "target-sandbox-probe"),
				);
				const broker = current.some((entry) =>
					entry.messages.some(
						(message) =>
							message.toolCallId === "target-broker-wait" &&
							(message.text ?? "").includes("TARGET-BROKER-UPDATE-VISIBLE"),
					),
				);
				return sandbox && broker ? current : undefined;
			}, "sandbox probe and live broker update", 120_000);
			await brokerUpdate;
			const sandboxResult = captures
				.flatMap((entry) => entry.messages)
				.find((message) => message.toolCallId === "target-sandbox-probe");
			assert.ok(sandboxResult);
			const text = sandboxResult.text ?? "";
			for (const label of ["prompt", "memory", "pi_source", "rsi_source", "candidate_target", "symlink_rsi", "symlink_memory", "proc_self_root", "proc_pid1_root", "fd"]) {
				assert.match(text, new RegExp(`WRITE_FAIL:${label}`), `${label} must be protected`);
			}
			for (const label of ["plugin_edit", "workspace", "ordinary_tmp"]) {
				assert.match(text, new RegExp(`WRITE_OK:${label}`), `${label} must remain writable`);
			}
			assert.match(text, /CMD_FAIL:rename_rsi/);
			assert.match(text, /CMD_FAIL:mount_bind/);
			assert.match(text, /NESTED_USERNS:denied/);
			assert.match(text, /EXTERNAL_PROC:hidden/);
			assert.match(text, /CAP[:=]CapEff:0+$/m);
			assert.match(text, new RegExp(`UID=${TARGET_WORKER_UID}\\b`));
			assert.match(text, new RegExp(`GID=${TARGET_WORKER_GID}\\b`));
			assert.match(text, /NODE_FAIL:prompt/);
			assert.match(text, /NODE_FAIL:memory/);
			assert.match(text, /NODE_OK:plugin/);
			assert.match(text, /NODE_OK:workspace/);
			const namespacePid = /NS_PID=(\d+)/.exec(text)?.[1];
			assert.ok(namespacePid);
			assert.notEqual(Number(namespacePid), hostWorkerPid, "Worker namespace PID must not be used as the host bwrap PID");
			assert.equal(await readFile(prompt, "utf8"), promptBefore);
			assert.equal(await readFile(memory, "utf8"), "TARGET-BROKER-UPDATE-VISIBLE\n");
			assert.equal((await readFile(pluginFile, "utf8")).trim(), "NODE_HACK");
			assert.equal((await readFile(workspaceFile, "utf8")).trim(), "NODE_HACK");
			assert.equal((await readFile(tmpFile, "utf8")).trim(), "HACK");
		} catch (error) {
			console.error(`TARGET LOGS:\n${harness.logs.join("\n")}`);
			throw error;
		} finally {
			await harness.cleanup();
		}
	},
);

test(
	"static syntax and 3-second Mock failures reject syntax and while(true) candidates without touching the active generation",
	{ ...targetTest(180_000), skip: "Legacy test loads Agent-authored Pi extensions, which the current policy forbids." },
	async () => {
		if (skip !== undefined) return;
		const harness = await startTargetHarness();
		try {
			const initial = await waitFor(async () => {
				const state = await harness.runtime.coordinator.currentState();
				return state.active?.generation === 1 ? state : undefined;
			}, "baseline generation 1");
			const baselineDigest = initial.active?.digest;
			const syntaxPath = join(harness.paths.pluginSourceDir, "syntax-bad.ts");
			const loopPath = join(harness.paths.pluginSourceDir, "while-true.ts");
			await harness.setScript([
				{ toolCalls: [{ name: "write", id: "write-syntax", arguments: { path: syntaxPath, content: SYNTAX_ERROR } }] },
				{ text: "syntax extension written" },
				{ toolCalls: [{ name: "pi_control", id: "syntax-reload", arguments: { command: "reload" } }] },
				{ text: "syntax reload rejected" },
				{
					toolCalls: [
						{ name: "write", id: "repair-syntax", arguments: { path: syntaxPath, content: "export default function valid(pi) {}\n" } },
						{ name: "write", id: "write-loop", arguments: { path: loopPath, content: TOP_LEVEL_LOOP } },
					],
				},
				{ text: "loop extension written" },
				{ toolCalls: [{ name: "pi_control", id: "loop-reload", arguments: { command: "reload" } }] },
				{ text: "loop reload rejected", stopReason: "error", errorMessage: "stop target rejection loop" },
			]);
			const captures = await waitFor(async () => {
				const current = await harness.captures();
				const text = current.map((entry) => JSON.stringify(entry)).join("\n");
				return text.includes("Mock load timed out after 3000ms") ? current : undefined;
			}, "syntax and 3-second Mock rejection results", 120_000);
			const text = captures.map((entry) => JSON.stringify(entry)).join("\n");
			assert.match(text, /Static syntax check/);
			assert.match(text, /Real Pi reload was not performed/);
			assert.match(text, /Mock load timed out after 3000ms/);
			assert.match(text, /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)/);
			assert.match(text, /"isError":true/);
			const state = await harness.runtime.coordinator.currentState();
			assert.equal(state.active?.generation, 1);
			assert.equal(state.active?.digest, baselineDigest);
			assert.equal(state.reloading, null);
			assert.equal(state.lkg?.generation, 1);
			const files = await readdir(harness.paths.pluginSourceDir);
			assert.equal(files.includes("while-true.ts"), true);
			const mappedPreflightDir = await stat("/tmp/rsi-preflight");
			assert.equal(mappedPreflightDir.isDirectory(), true);
			assert.equal(mappedPreflightDir.mode & 0o777, 0o777, "mapped preflight result directory must be writable by the Worker uid");
		} catch (error) {
			console.error(`TARGET LOGS:\n${harness.logs.join("\n")}`);
			throw error;
		} finally {
			await harness.cleanup();
		}
	},
);

test(
	"a valid reload mounts a real tool, calls it, keeps the exact digest through three healthy turns, and promotes the same digest to external LKG",
	{ ...targetTest(240_000), skip: "Legacy test loads Agent-authored Pi extensions, which the current policy forbids." },
	async () => {
		if (skip !== undefined) return;
		const harness = await startTargetHarness();
		try {
			const initial = await waitFor(async () => {
				const state = await harness.runtime.coordinator.currentState();
				return state.active?.generation === 1 ? state : undefined;
			}, "baseline generation 1");
			const baselineDigest = initial.active?.digest;
			const pluginPath = join(harness.paths.pluginSourceDir, "target-reload.ts");
			await harness.setScript([
				{
					toolCalls: [
						{
							name: "write",
							id: "write-target-reload",
							arguments: { path: pluginPath, content: extensionSource("target_reload_tool", "TARGET-RELOAD-TOOL-OK") },
						},
					],
				},
				{ text: "target reload candidate written" },
				{ toolCalls: [{ name: "pi_control", id: "target-reload", arguments: { command: "reload" } }] },
				{ text: "target reload requested" },
				{ toolCalls: [{ name: "target_reload_tool", id: "target-reload-call", arguments: {} }] },
				{ text: "target reload tool called" },
				{ text: "target healthy turn one" },
				{ text: "target healthy turn two" },
				{ text: "target healthy turn three", stopReason: "error", errorMessage: "stop target reload loop" },
			]);
			const captures = await waitFor(async () => {
				const current = await harness.captures();
				const text = current.map((entry) => JSON.stringify(entry)).join("\n");
				return text.includes("TARGET-RELOAD-TOOL-OK") && text.includes("target healthy turn three")
					? current
					: undefined;
			}, "validated reload tool call and three post-reload turns", 180_000);
			const captureText = captures.map((entry) => JSON.stringify(entry)).join("\n");
			assert.match(captureText, /TARGET-RELOAD-TOOL-OK/);
			const loaded = await waitFor(async () => {
				const state = await harness.runtime.coordinator.currentState();
				return state.active?.generation === 2 ? state : undefined;
			}, "reload generation 2");
			const reloadDigest = loaded.active?.digest;
			assert.ok(reloadDigest);
			assert.notEqual(reloadDigest, baselineDigest);
			assert.equal(loaded.health?.digest, reloadDigest);
			const promoted = await waitFor(async () => {
				const state = await harness.runtime.coordinator.currentState();
				return state.active?.phase === "promoted" && state.lkg?.generation === 2 ? state : undefined;
			}, "three-healthy-turn LKG promotion", 120_000);
			assert.equal(promoted.active?.digest, reloadDigest);
			assert.equal(promoted.health?.digest, reloadDigest);
			assert.equal(promoted.health?.healthyTurns, 3);
			assert.equal(promoted.lkg?.digest, reloadDigest);
			const promotion = promoted.history.find((entry) => entry.phase === "promoted" && entry.generation === 2);
			assert.ok(promotion);
			assert.equal(promotion.digest, reloadDigest);
			const status = await harness.runtime.status();
			assert.equal((status.extensionPaths ?? []).some((path) => path.includes("target-reload")), true);
		} catch (error) {
			console.error(`TARGET LOGS:\n${harness.logs.join("\n")}`);
			throw error;
		} finally {
			await harness.cleanup();
		}
	},
);

test(
	"an Agent-written Pi extension remains unavailable and pi /reload is forbidden inside real bwrap",
	targetTest(240_000),
	async () => {
		if (skip !== undefined) return;
		const harness = await startTargetHarness();
		try {
			const initial = await waitFor(async () => {
				const state = await harness.runtime.coordinator.currentState();
				return state.active?.generation === 1 ? state : undefined;
			}, "baseline generation 1");
			const pluginPath = join(harness.paths.pluginSourceDir, "agent-cli-reload.ts");
			await harness.setScript([
				{ toolCalls: [{ name: "write", id: "agent-cli-write", arguments: { path: pluginPath, content: extensionSource("agent_cli_tool", "TARGET-AGENT-CLI-TOOL-OK") } }] },
				{ text: "Agent extension written." },
				{ toolCalls: [{ name: "bash", id: "agent-cli-reload", arguments: { command: "pi /reload" } }] },
				{ text: "Agent requested the deferred reload." },
				{ toolCalls: [{ name: "agent_cli_tool", id: "agent-cli-call", arguments: {} }] },
				{ text: "The unplanned tool was not available." },
				{ text: "Agent CLI healthy turn one." },
				{ text: "Agent CLI healthy turn two." },
				{ text: "Agent CLI healthy turn three." },
			]);
			const captures = await waitFor(async () => {
				const current = await harness.captures();
				return current.some((request) => request.messages.some((message) => message.toolCallId === "agent-cli-call"))
					? current
					: undefined;
			}, "Agent-written tool rejected after bash pi /reload", 180_000);
			const messages = captures.flatMap((request) => request.messages);
			const write = messages.find((message) => message.toolCallId === "agent-cli-write");
			const reload = messages.find((message) => message.toolCallId === "agent-cli-reload");
			const call = messages.find((message) => message.toolCallId === "agent-cli-call");
			assert.ok(write);
			assert.equal(write.isError, false);
			assert.ok(reload);
			assert.equal(reload.isError, true);
			assert.match(reload.text ?? "", /forbidden/iu);
			assert.ok(call);
			assert.equal(call.toolName, "agent_cli_tool");
			assert.equal(call.isError, true);
			assert.match(call.text ?? "", /not found|not available/iu);
			for (const result of [write, reload, call]) {
				assert.match(result.text ?? "", /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)$/u);
			}
			const status = await harness.runtime.status();
			assert.equal(status.generation, initial.active?.generation);
			assert.equal((status.extensionPaths ?? []).some((path) => path.includes("agent-cli-reload")), false);
		} catch (error) {
			console.error(`TARGET LOGS:\n${harness.logs.join("\n")}`);
			throw error;
		} finally {
			await harness.cleanup();
		}
	},
);

test(
	"an Agent-written Skill is discovered after automatic activation inside real bwrap",
	targetTest(180_000),
	async () => {
		if (skip !== undefined) return;
		const harness = await startTargetHarness();
		try {
			const skillPath = join(harness.paths.piAgentDir, "skills", "target-skill", "SKILL.md");
			await harness.setScript([
				{ toolCalls: [{ name: "write", id: "target-skill-write", arguments: {
					path: skillPath,
					content: "---\nname: target-skill\ndescription: TARGET-SKILL-DESCRIPTION\n---\n\nSkill body.\n",
				} }] },
				{ text: "Skill files are ready." },
				{ text: "Skill available on this turn." },
			]);
			const captures = await waitFor(async () => {
				const current = await harness.captures();
				return current.some((capture) => capture.system.includes("TARGET-SKILL-DESCRIPTION")) ? current : undefined;
			}, "automatic Skill activation in real bwrap", 120_000);
			assert.equal(captures.flatMap((capture) => capture.messages).find((message) => message.toolCallId === "target-skill-write")?.isError, false);
			assert.equal((await harness.runtime.status()).skillCount, 1);
		} finally {
			await harness.cleanup();
		}
	},
);

test(
	"an Agent-configured MCP server exposes a callable tool after automatic activation inside real bwrap",
	targetTest(180_000),
	async () => {
		if (skip !== undefined) return;
		const harness = await startTargetHarness();
		try {
			const serverPath = join(harness.paths.workspaceDir, "target-mcp.mjs");
			const server = `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "target", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }] }
      : { content: [{ type: "text", text: "TARGET-MCP-OK: " + request.params.arguments.message }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`;
			await harness.setScript([
				{ toolCalls: [{ name: "write", id: "target-mcp-write", arguments: { path: serverPath, content: server } }] },
				{ toolCalls: [{ name: "bash", id: "target-mcp-add", arguments: { command: `pi mcp add target_mcp --exposure direct -- node '${serverPath}'` } }] },
				{ text: "Activate the MCP configuration after this turn." },
				{ toolCalls: [{ name: "mcp__target_mcp__echo", id: "target-mcp-call", arguments: { message: "hello" } }] },
				{ text: "MCP tool returned." },
			]);
			const captures = await waitFor(async () => {
				const current = await harness.captures();
				return current.some((request) => request.messages.some((message) => message.toolCallId === "target-mcp-call")) ? current : undefined;
			}, "Agent-configured MCP result inside bwrap", 120_000);
			const messages = captures.flatMap((capture) => capture.messages);
			for (const id of ["target-mcp-write", "target-mcp-add", "target-mcp-call"]) {
				assert.equal(messages.find((message) => message.toolCallId === id)?.isError, false, id);
			}
			assert.match(messages.find((message) => message.toolCallId === "target-mcp-call")?.text ?? "", /TARGET-MCP-OK: hello/u);
			assert.equal((await harness.runtime.status()).mcpServerCount, 1);
		} catch (error) {
			console.error(`TARGET LOGS:\n${harness.logs.join("\n")}`);
			throw error;
		} finally {
			await harness.cleanup();
		}
	},
);

test(
	"a post-reload delayed crash restores the exact external LKG and reports the rollback in the first recovery turn",
	{ ...targetTest(180_000), skip: "Legacy crash fixture requires loading an Agent-authored Pi extension." },
	async () => {
		if (skip !== undefined) return;
		const harness = await startTargetHarness();
		try {
			const initial = await waitFor(async () => {
				const state = await harness.runtime.coordinator.currentState();
				return state.active?.generation === 1 && state.lkg?.generation === 1 ? state : undefined;
			}, "baseline LKG generation 1");
			const baselineDigest = initial.lkg?.digest;
			const initialPid = await waitFor(() => harness.runtime.workerPid, "initial host Worker pid");
			const crashPath = join(harness.paths.pluginSourceDir, "delayed-crash.ts");
			const memoryPath = harness.paths.memoryFile;
			const taskPath = join(harness.paths.workspaceDir, "target-crash-state.txt");
			await harness.setScript({
				steps: [
					{
						toolCalls: [
							{ name: "write", id: "write-crash", arguments: { path: crashPath, content: DELAYED_CRASH } },
							{ name: "write", id: "write-memory", arguments: { path: memoryPath, content: "TARGET-ROLLBACK-SURVIVES-MEMORY" } },
							{ name: "write", id: "write-task", arguments: { path: taskPath, content: "TARGET-ROLLBACK-SURVIVES-TASK" } },
						],
					},
					{ text: "crash extension written" },
					{ toolCalls: [{ name: "pi_control", id: "load-crash", arguments: { command: "reload" } }] },
					{ text: "crash extension reload requested" },
					{ text: "keep the turn loop alive", stopReason: "error", errorMessage: "stop before crash" },
				],
				postRecovery: [
					{ text: "after target rollback" },
					{ text: "post target recovery turn", stopReason: "error", errorMessage: "stop target recovery" },
				],
			});
			await waitFor(async () => {
				const state = await harness.runtime.coordinator.currentState();
				return state.active?.generation === 2 ? state : undefined;
			}, "delayed crash candidate generation 2", 120_000);
			const restartedPid = await waitFor(async () => {
				const pid = harness.runtime.workerPid;
				return pid !== null && pid !== initialPid ? pid : undefined;
			}, "Watchdog restart after delayed crash", 120_000);
			assert.notEqual(restartedPid, initialPid);
			const recovered = await waitFor(async () => {
				const current = await harness.captures();
				const text = current.map((entry) => JSON.stringify(entry)).join("\n");
				return text.includes("after target rollback") ? current : undefined;
			}, "post-recovery provider turn", 120_000);
			const text = recovered.map((entry) => JSON.stringify(entry)).join("\n");
			assert.match(text, /检测到 Pi Worker 崩溃，已回滚到上一个已知安全快照。/);
			assert.match(text, /TARGET-DELAYED-CRASH/);
			const final = await harness.runtime.coordinator.currentState();
			assert.equal(final.active?.generation, 1);
			assert.equal(final.active?.digest, baselineDigest);
			assert.equal(final.lkg?.generation, 1);
			assert.equal(final.lkg?.digest, baselineDigest);
			const files = await readdir(harness.paths.pluginSourceDir);
			assert.equal(files.includes("delayed-crash.ts"), false);
			assert.match((await harness.runtime.knowledgeService.readCurrentMemory()).content, /TARGET-ROLLBACK-SURVIVES-MEMORY/);
			assert.equal(await readFile(taskPath, "utf8"), "TARGET-ROLLBACK-SURVIVES-TASK");
		} catch (error) {
			console.error(`TARGET LOGS:\n${harness.logs.join("\n")}`);
			throw error;
		} finally {
			await harness.cleanup();
		}
	},
);

test(
	"a post-reload event-loop hang expires the heartbeat lease, kills the host bwrap tree, and restores the external LKG",
	{ ...targetTest(180_000), skip: "Legacy hang fixture requires loading an Agent-authored Pi extension." },
	async () => {
		if (skip !== undefined) return;
		const harness = await startTargetHarness();
		try {
			const initial = await waitFor(async () => {
				const state = await harness.runtime.coordinator.currentState();
				return state.active?.generation === 1 && state.lkg?.generation === 1 ? state : undefined;
			}, "baseline LKG generation 1");
			const baselineDigest = initial.lkg?.digest;
			const initialPid = await waitFor(() => harness.runtime.workerPid, "initial host Worker pid");
			const hangPath = join(harness.paths.pluginSourceDir, "delayed-hang.ts");
			await harness.setScript({
				steps: [
					{ toolCalls: [{ name: "write", id: "write-hang", arguments: { path: hangPath, content: DELAYED_HANG } }] },
					{ text: "hang extension written" },
					{ toolCalls: [{ name: "pi_control", id: "load-hang", arguments: { command: "reload" } }] },
					{ text: "hang extension reload requested" },
					{ text: "keep the turn loop alive", stopReason: "error", errorMessage: "stop before hang" },
				],
				postRecovery: [
					{ text: "after target hang rollback" },
					{ text: "post target hang recovery turn", stopReason: "error", errorMessage: "stop target hang recovery" },
				],
			});
			await waitFor(async () => {
				const state = await harness.runtime.coordinator.currentState();
				return state.active?.generation === 2 ? state : undefined;
			}, "hang candidate generation 2", 120_000);
			const restartedPid = await waitFor(async () => {
				const pid = harness.runtime.workerPid;
				return pid !== null && pid !== initialPid ? pid : undefined;
			}, "Watchdog restart after heartbeat lease expiry", 150_000);
			assert.notEqual(restartedPid, initialPid);
			const recovered = await waitFor(async () => {
				const current = await harness.captures();
				const text = current.map((entry) => JSON.stringify(entry)).join("\n");
				return text.includes("after target hang rollback") ? current : undefined;
			}, "post-hang recovery provider turn", 120_000);
			const text = recovered.map((entry) => JSON.stringify(entry)).join("\n");
			assert.match(text, /检测到 Pi Worker 崩溃，已回滚到上一个已知安全快照。/);
			const final = await harness.runtime.coordinator.currentState();
			assert.equal(final.active?.generation, 1);
			assert.equal(final.active?.digest, baselineDigest);
			assert.equal(final.lkg?.digest, baselineDigest);
			assert.equal((await readdir(harness.paths.pluginSourceDir)).includes("delayed-hang.ts"), false);
		} catch (error) {
			console.error(`TARGET LOGS:\n${harness.logs.join("\n")}`);
			throw error;
		} finally {
			await harness.cleanup();
		}
	},
);

test(
	"explicit sleep health stays sleeping, a Worker restart preserves the original deadline, and the wake resumes once after it",
	targetTest(180_000),
	async () => {
		if (skip !== undefined) return;
		const harness = await startTargetHarness();
		try {
			await harness.setScript([
				{ toolCalls: [{ name: "sleep", id: "target-sleep", arguments: { duration: "15s" } }] },
				{ text: "awake after target sleep" },
				{ text: "next target autonomous turn", stopReason: "error", errorMessage: "stop target sleep loop" },
			]);
			const initialPid = await waitFor(() => harness.runtime.workerPid ?? undefined, "initial host Worker pid");
			const active = await waitFor(async () => {
				const state = await readJson<Record<string, any>>(harness.paths.sleepStateFile).catch(() => null);
				return state?.sleep?.status === "active" ? state : undefined;
			}, "active explicit sleep", 60_000);
			const deadlineMs = active.sleep.deadlineMs as number;
			assert.ok(deadlineMs > Date.now());
			const sleepHealth = await waitFor(async () => {
				const health = await readJson<Record<string, any>>(join(harness.stateDir, "runtime", "health.json")).catch(
					() => null,
				);
				return health?.worker?.state === "sleeping" && health?.sleep?.active === true ? health : undefined;
			}, "sleeping health file with an active future deadline", 30_000);
			assert.equal(sleepHealth.sleep.deadlineMs, deadlineMs);
			await waitFor(async () => {
				const text = await readFile(join(harness.paths.logsDir, "watchdog.log"), "utf8").catch(() => "");
				return /"state":"sleeping"/.test(text);
			}, "sleeping heartbeat while the lease is suspended", 30_000);

			await harness.setScript([
				{ text: "awake after target sleep" },
				{ text: "next target autonomous turn", stopReason: "error", errorMessage: "stop target sleep loop" },
			]);
			killWorkerPid(initialPid, "SIGKILL");
			const restartedPid = await waitFor(async () => {
				const pid = harness.runtime.workerPid;
				return pid !== null && pid !== initialPid ? pid : undefined;
			}, "Worker restart during explicit sleep", 120_000);
			assert.notEqual(restartedPid, initialPid);
			await waitFor(async () => {
				const state = await readJson<Record<string, any>>(harness.paths.watchdogStateFile).catch(() => null);
				return state?.workerHeartbeatState === "sleeping" ? state : undefined;
			}, "restarted Worker reports authoritative sleeping heartbeat", 60_000);
			const completed = await waitFor(async () => {
				const state = await readJson<Record<string, any>>(harness.paths.sleepStateFile).catch(() => null);
				return state?.sleep?.status === "completed" ? state : undefined;
			}, "sleep completion after restart", 60_000);
			assert.equal(completed.sleep.deadlineMs, deadlineMs);
			assert.ok(completed.sleep.wakeNotifiedAtMs >= deadlineMs);
			assert.ok(Date.now() - deadlineMs < 30_000, "wake should be prompt after the persisted deadline");
			const captures = await waitFor(async () => {
				const current = await harness.captures();
				return current.some((capture) => JSON.stringify(capture).includes("awake after target sleep"))
					? current
					: undefined;
			}, "post-sleep provider request", 60_000);
			const after = captures.find((capture) => JSON.stringify(capture).includes("awake after target sleep"));
			assert.ok(after);
			assert.ok(after.atMs >= deadlineMs, "the next provider request must not occur before the deadline");
			assert.match(after.system, /TARGET-VALIDATION-HUMAN-PROMPT-FIXTURE/);
			assert.match(JSON.stringify(after), /检测到 Pi Worker 崩溃，已回滚到上一个已知安全快照。/);
		} catch (error) {
			console.error(`TARGET LOGS:\n${harness.logs.join("\n")}`);
			throw error;
		} finally {
			await harness.cleanup();
		}
	},
);

test(
	"read statistics and a pending recovery notice survive a full Supervisor restart on the same /data and /state volumes",
	targetTest(180_000),
	async () => {
		if (skip !== undefined) return;
		const first = await startTargetHarness();
		let second: Awaited<ReturnType<typeof startTargetHarness>> | undefined;
		try {
			const initial = await waitFor(async () => {
				const state = await first.runtime.coordinator.currentState();
				return state.active?.generation === 1 && state.lkg?.generation === 1 ? state : undefined;
			}, "baseline LKG before restart");
			const lkg = initial.lkg;
			assert.ok(lkg);
			const indexReadsBefore = await first.runtime.knowledgeService.recordRead(
				"index.md",
				new Date(),
			);
			assert.equal(indexReadsBefore, 1);
			const beforeCounts = await first.runtime.knowledgeService.readStatsCounts(new Date());
			// Stop the first runtime before enqueueing the notice so it cannot
			// consume/acknowledge the notice before the restart phase.
			await first.stop();
			const notices = new RecoveryNoticeStore({
				path: join(first.paths.controlDir, "recovery-notices.json"),
				clock: new SystemClock(),
			});
			await notices.enqueueCrash({
				incident: {
					incidentId: "target-restart-incident",
					reason: "TARGET-RESTART-RECOVERY-NOTICE",
					atMs: Date.now(),
					generation: 1,
					candidateId: lkg.candidateId,
					exitCode: null,
					signal: "SIGKILL",
					stderrTail: "fixture crash before Supervisor restart",
				},
				lkg,
				kind: "crash-rollback",
			});
			second = await startTargetHarness({
				root: first.root,
				stateDir: first.stateDir,
				promptFile: first.promptFile,
			});
			const afterCounts = await second.runtime.knowledgeService.readStatsCounts(new Date());
			assert.equal(afterCounts.get("index.md") ?? 0, beforeCounts.get("index.md") ?? 0);
			assert.ok((afterCounts.get("index.md") ?? 0) >= 1);
			await second.setScript([
				{ text: "target restart online" },
				{ text: "target restart idle", stopReason: "error", errorMessage: "stop target restart loop" },
			]);
			const captures = await waitFor(async () => {
				const current = await second!.captures();
				const text = current.map((entry) => JSON.stringify(entry)).join("\n");
				return text.includes("TARGET-RESTART-RECOVERY-NOTICE") ? current : undefined;
			}, "persisted recovery notice delivery after restart", 120_000);
			assert.match(
				captures.map((entry) => JSON.stringify(entry)).join("\n"),
				/TARGET-RESTART-RECOVERY-NOTICE/,
			);
		} catch (error) {
			console.error(`TARGET FIRST LOGS:\n${first.logs.join("\n")}`);
			if (second !== undefined) console.error(`TARGET SECOND LOGS:\n${second.logs.join("\n")}`);
			throw error;
		} finally {
			await first.cleanup();
			if (second !== undefined) {
				await second.cleanup();
			} else {
				await forceRemove(first.root);
				await forceRemove(first.stateDir);
			}
		}
	},
);

test(
	"the pinned web-search plugin uses only a local mock HTTP endpoint under the real target Worker",
	targetTest(180_000),
	async () => {
		if (skip !== undefined) return;
		let requests = 0;
		const server = createServer((_request, response) => {
			requests += 1;
			const item = {
				type: "web_search_call",
				id: "ws_target_1",
				status: "completed",
				action: {
					query: "target local mock search",
					sources: [{ url: "https://example.test/target", title: "Target fixture" }],
				},
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
								content: [{ type: "output_text", text: "target local fixture answer", annotations: [] }],
							},
						],
					},
				},
			];
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(events.map((event) => `data: ${JSON.stringify(event)}

`).join(""));
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("local mock HTTP server has no port");
		const harness = await startTargetHarness({ openAiBaseUrl: `http://127.0.0.1:${address.port}` });
		try {
			await harness.setScript([
				{ toolCalls: [{ name: "web_search", id: "target-web-search", arguments: { query: "target local mock search" } }] },
				{ text: "target web search complete" },
				{ text: "stop target web search loop", stopReason: "error", errorMessage: "stop target web search loop" },
			]);
			const captures = await waitFor(async () => {
				const current = await harness.captures();
				return current.some((entry) =>
					entry.messages.some((message) => message.toolCallId === "target-web-search"),
				)
					? current
					: undefined;
			}, "local mock web_search tool result", 120_000);
			const result = captures
				.flatMap((entry) => entry.messages)
				.find((message) => message.toolCallId === "target-web-search");
			assert.ok(result);
			assert.match(result.text ?? "", /ws_target_1|target local mock search/);
			assert.ok(requests >= 1, "the pinned web-search plugin must call the local mock HTTP endpoint");
		} finally {
			await harness.cleanup();
			server.closeAllConnections?.();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
	},
);

test(
	"the real target sandbox reports its actual bubblewrap version, empty capabilities and PID namespace",
	{ timeout: 60_000, ...(skip === undefined ? {} : { skip }) },
	async () => {
		if (skip !== undefined) return;
		const harness = await startTargetHarness();
		try {
			const result = await runSandboxCommand(
				harness,
				"printf 'BWRAP_PROBE_OK\\n'; bwrap --version; grep '^CapEff:' /proc/self/status; grep '^NSpid:' /proc/self/status",
			);
			assert.equal(result.exitCode, 0, result.stderr);
			assert.match(result.stdout, /BWRAP_PROBE_OK/);
			assert.match(result.stdout, /bubblewrap/i);
			assert.match(result.stdout, /CapEff:\s*0+$/m);
		} finally {
			await harness.cleanup();
		}
	},
);
