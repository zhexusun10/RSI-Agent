import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, chown, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRsiConfig } from "../../src/shared/config.ts";
import { verifyRuntimeLayout } from "../../src/shared/layout-verify.ts";
import { createBubblewrapLauncherForConfig } from "../../src/sandbox/launcher.ts";
import { inspectBubblewrapRuntime } from "../../src/sandbox/preflight.ts";
import { SupervisorRuntime } from "../../src/integration/runtime.ts";

const RSI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_MODEL = join(RSI_ROOT, "test", "integration", "fixtures", "test-model.ts");
const WORKER_UID = 65_534;
const WORKER_GID = 65_534;

async function detection(): Promise<string | undefined> {
	if (process.platform !== "linux") return `not verified: requires Linux; current platform is ${process.platform}`;
	if (typeof process.geteuid !== "function" || process.geteuid() !== 0) {
		return "not verified: this real-bwrap test requires a root Supervisor able to start the Worker under a distinct host UID";
	}
	const version = spawnSync(process.env.RSI_TEST_BWRAP ?? "bwrap", ["--version"], {
		encoding: "utf8",
		timeout: 5_000,
	});
	if (version.status !== 0) return "not verified: bubblewrap is not installed or executable";
	const report = await inspectBubblewrapRuntime(
		{ workerUid: WORKER_UID, workerGid: WORKER_GID, supervisorUid: 0, probeTimeoutMs: 15_000 },
		process.env.RSI_TEST_BWRAP ?? "bwrap",
	);
	if (!report.ok) {
		return `not verified: bubblewrap namespace/mount preflight failed: ${report.errors.join(" | ")}`;
	}
	return undefined;
}

const skip = await detection();

test(
	"real bwrap Worker cannot write the manual prompt, managed Markdown, RSI/Pi source or active candidate while plugin/workflow files stay writable",
	{ skip, timeout: 180_000 },
	async () => {
		if (skip !== undefined) return;
		const root = await mkdtemp(join(tmpdir(), "rsi-bwrap-int-"));
		const workspace = join(root, "workspace");
		const dataDir = join(root, "data");
		const stateDir = join(root, "state");
		const markdowns = join(dataDir, "markdowns");
		const plugins = join(dataDir, "plugins");
		const piAgent = join(dataDir, "pi-agent");
		const sessions = join(dataDir, "pi-sessions");
		const workerHome = join(dataDir, "worker-home");
		const prompt = join(root, "manual-prompt.txt");
		const script = join(root, "script.json");
		const capture = join(root, "capture.jsonl");
		for (const dir of [workspace, markdowns, plugins, piAgent, sessions, workerHome, stateDir]) {
			await mkdir(dir, { recursive: true });
		}
		await chmod(root, 0o755);
		await writeFile(prompt, "REAL-BWRAP-MANUAL-PROMPT\n", { mode: 0o644 });
		await writeFile(script, "[]\n", { mode: 0o644 });
		await writeFile(capture, "", { mode: 0o644 });
		await chmod(capture, 0o666);
		for (const dir of [workspace, plugins, piAgent, sessions, workerHome]) {
			try {
				await chown(dir, 0, 0);
			} catch {}
			try {
				await chmod(dir, 0o777);
			} catch {}
			await chown(dir, WORKER_UID, WORKER_GID);
		}
		const config = parseRsiConfig({
			version: 1,
			timeZone: "UTC",
			paths: {
				workspaceDir: workspace,
				dataDir,
				stateDir,
				markdownsDir: markdowns,
				pluginSourceDir: plugins,
				piSourceDir: join(RSI_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"),
				rsiSourceDir: RSI_ROOT,
				systemPromptFile: prompt,
				hostIpcSocketPath: join(stateDir, "run", "worker.sock"),
			},
			ipc: {
				heartbeatIntervalMs: 1_000,
				heartbeatTimeoutMs: 30_000,
				requestTimeoutMs: 15_000,
				preflightTimeoutMs: 20_000,
			},
			sandbox: {
				bwrapPath: process.env.RSI_TEST_BWRAP ?? "bwrap",
				network: "unrestricted",
				workerUid: WORKER_UID,
				workerGid: WORKER_GID,
			},
		});
		const verified = await verifyRuntimeLayout(config.paths);
		const configured = createBubblewrapLauncherForConfig(config, verified, {
			readOnlyMounts: [{ source: config.paths.snapshotDir, target: "/run/rsi-plugins", mode: "ro" }],
			terminationGraceMs: 1_000,
			killWaitMs: 2_000,
			maxStdoutBytes: 1_048_576,
			maxStderrBytes: 1_048_576,
		});
		const runtime = new SupervisorRuntime({
			config,
			verified,
			launcher: configured.launcher,
			policy: configured.policy,
			sandboxed: true,
			hostIpcEndpoint: join(stateDir, "run", "worker.sock"),
			workerIpcEndpoint: "/run/rsi/worker.sock",
			controlEndpoint: join(stateDir, "run", "control.sock"),
			operatorEndpoint: join(stateDir, "control", "operator.sock"),
			healthFile: join(stateDir, "runtime", "health.json"),
			controlToken: "bwrap-integration-token",
			testModelModule: TEST_MODEL,
			testWorkerEnv: { RSI_TEST_SCRIPT_FILE: script, RSI_TEST_CAPTURE_FILE: capture },
			installSignalHandlers: false,
			onLog: () => undefined,
		});
		try {
			await runtime.start();
			const active = await runtime.coordinator.currentState();
			assert.ok(active.active);
			const relativeCandidate = active.active.path
				.slice(config.paths.snapshotDir.length + 1)
				.replaceAll("\\", "/");
			const candidateSandboxPath = `/run/rsi-plugins/${relativeCandidate}/candidate.json`;
			const nodeMemory = [
				"const fs=require('node:fs');",
				`try{fs.writeFileSync(${JSON.stringify(join(markdowns, "Memory.md"))},'X');`,
				"console.log('NODE_OK:memory')}catch{console.log('NODE_FAIL:memory')}",
			].join("");
			const nodePlugin = [
				"const fs=require('node:fs');",
				`try{fs.writeFileSync(${JSON.stringify(join(plugins, "node-created.ts"))},'export default function(){}');`,
				"console.log('NODE_OK:plugin')}catch{console.log('NODE_FAIL:plugin')}",
			].join("");
			const bash = [
				"set +e",
				"attempt(){ if printf HACK > \"$2\" 2>/dev/null; then echo \"WRITE_OK:$1\"; else echo \"WRITE_FAIL:$1\"; fi; }",
				`attempt prompt ${JSON.stringify(prompt)}`,
				`attempt memory ${JSON.stringify(join(markdowns, "Memory.md"))}`,
				`attempt rsi_source ${JSON.stringify(join(RSI_ROOT, "src", "worker-main.ts"))}`,
				`attempt pi_source ${JSON.stringify(join(config.paths.piSourceDir, "package.json"))}`,
				`attempt candidate ${JSON.stringify(candidateSandboxPath)}`,
				`attempt plugin_edit ${JSON.stringify(join(plugins, "created.ts"))}`,
				`attempt workspace ${JSON.stringify(join(workspace, "created.txt"))}`,
				`attempt tmp ${JSON.stringify(`/tmp/rsi-bwrap-worker-${process.pid}.txt`)}`,
				`node -e ${JSON.stringify(nodeMemory)}`,
				`node -e ${JSON.stringify(nodePlugin)}`,
				"grep '^CapEff:' /proc/self/status",
			].join("\n");
			await writeFile(
				script,
				JSON.stringify([
					{ toolCalls: [{ name: "bash", id: "bwrap-writes", arguments: { command: bash } }] },
					{ text: "sandbox writes checked", stopReason: "error", errorMessage: "stop" },
				]),
			);
			let records: Array<{ messages: Array<{ role?: string; toolName?: string; text?: string }> }> = [];
			const deadline = Date.now() + 90_000;
			while (Date.now() < deadline) {
				const text = await readFile(capture, "utf8");
				records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
				if (records.some((record) => record.messages.some((message) => message.toolName === "bash"))) break;
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
			}
			const result = records
				.flatMap((record) => record.messages)
				.find((message) => message.toolName === "bash");
			assert.ok(result);
			for (const label of ["prompt", "memory", "rsi_source", "pi_source", "candidate"]) {
				assert.match(result.text ?? "", new RegExp(`WRITE_FAIL:${label}`), `${label} must be protected`);
			}
			for (const label of ["plugin_edit", "workspace", "tmp"]) {
				assert.match(result.text ?? "", new RegExp(`WRITE_OK:${label}`), `${label} must remain writable`);
			}
			assert.match(result.text ?? "", /NODE_FAIL:memory/);
			assert.match(result.text ?? "", /NODE_OK:plugin/);
			assert.match(result.text ?? "", /CapEff:\s*0+$/m);
			assert.equal(await readFile(join(markdowns, "Memory.md"), "utf8"), "");
			assert.equal(await readFile(prompt, "utf8"), "REAL-BWRAP-MANUAL-PROMPT\n");
		} finally {
			await runtime.stop("bwrap integration cleanup").catch(() => undefined);
			await rm(root, { recursive: true, force: true });
		}
	},
);
