import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	MAX_MANAGED_DOCUMENTS,
	REQUIRED_PLUGIN_SPECS,
	countWords,
	parseRsiConfig,
} from "../../src/shared/index.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const rsiRoot = resolve(testDir, "../..");
const repoRoot = resolve(rsiRoot, "..");

function runNode(script: string, args: string[], env: Record<string, string | undefined> = {}) {
	return spawnSync(process.execPath, [join(rsiRoot, script), ...args], {
		cwd: rsiRoot,
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 60_000,
	});
}

function runNodeAsync(script: string, args: string[], env: Record<string, string | undefined> = {}) {
	return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise) => {
		const child = spawn(process.execPath, [join(rsiRoot, script), ...args], {
			cwd: rsiRoot,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
		child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
	});
}

async function tempDir(prefix: string) {
	return mkdtemp(join(tmpdir(), prefix));
}

async function startLiveProcess() {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(child, "spawn");
	return child;
}

async function stopProcess(child: ReturnType<typeof spawn>) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
}

async function writeJson(path: string, value: unknown) {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("Docker deployment limits container capabilities and pins plugin installation", async () => {
	const dockerfile = await readFile(join(rsiRoot, "Dockerfile"), "utf8");
	assert.match(dockerfile, /node:22\.19/);
	assert.match(dockerfile, /npm ci --ignore-scripts/);
	assert.doesNotMatch(dockerfile, /\bnpm install\b/);
	assert.match(dockerfile, /install-plugins\.mjs/);
	assert.match(dockerfile, /chmod -R a-w \/opt\/rsi\/pi-agent-base/);
	assert.match(dockerfile, /\/state\/snapshots\/candidates/);
	assert.match(dockerfile, /\/state\/snapshots\/lkg/);
	assert.match(dockerfile, /chmod 2770 \/state\/run/);
	assert.match(dockerfile, /RSI_SUPERVISOR_ENTRY=\/opt\/rsi\/src\/main\.ts/);
	assert.doesNotMatch(dockerfile, /\nUSER\s/);
	assert.match(dockerfile, /ENTRYPOINT \["\/opt\/rsi\/scripts\/container-entrypoint\.sh"\]/);
	assert.doesNotMatch(dockerfile, /privileged|docker\.sock|pi\/packages/);

	assert.match(dockerfile, /COPY markdowns\/ \/opt\/rsi\/seed-markdowns\//);
	assert.match(dockerfile, /chmod -R a-w \/opt\/rsi\/seed-markdowns/);

	const entrypoint = await readFile(join(rsiRoot, "scripts/container-entrypoint.sh"), "utf8");
	assert.match(entrypoint, /seed-markdowns\.mjs \/opt\/rsi\/seed-markdowns \/data\/markdowns/);
	assert.match(entrypoint, /chown root:"\$WORKER_GID" \/data\/pi-agent\/settings\.json/);
	assert.match(entrypoint, /chmod 0640 \/data\/pi-agent\/settings\.json/);

	const launcherSource = await readFile(join(rsiRoot, "src/sandbox/launcher.ts"), "utf8");
	assert.match(launcherSource, /operatorPiConfigReadOnlyMounts/);
	const runtimeSource = await readFile(join(rsiRoot, "src/integration/runtime.ts"), "utf8");
	assert.match(runtimeSource, /assertOperatorPiConfigUnchanged/);
	assert.match(runtimeSource, /ensureOperatorPiConfigBaseline/);

	const installScript = await readFile(join(rsiRoot, "scripts/install-plugins.mjs"), "utf8");
	assert.match(installScript, /"install", spec/);
	assert.match(installScript, /npm_config_ignore_scripts: "true"/);
	assert.match(installScript, /REQUIRED_PLUGIN_PINS/);

	const compose = await readFile(join(rsiRoot, "compose.yaml"), "utf8");
	assert.match(compose, /restart: unless-stopped/);
	assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
	assert.match(compose, /cap_add:\s*\r?\n\s*- SETUID\r?\n\s*- SETGID\r?\n\s*- CHOWN/);
	assert.match(compose, /RSI_SUPERVISOR_ENTRY:.*\/opt\/rsi\/src\/main\.ts/);
	assert.match(compose, /seccomp=\.\/deploy\/seccomp-bwrap\.json/);
	assert.match(compose, /healthcheck:/);
	assert.match(compose, /rsi-data:\/data/);
	assert.match(compose, /rsi-state:\/state/);
	assert.match(compose, /max-size: "10m"/);
	assert.doesNotMatch(compose, /privileged|docker\.sock|\n\s+ports:|\n\s+network_mode:/);
	assert.doesNotMatch(compose, /\n {4}read_only:\s*true/);

	const dockerignore = await readFile(join(repoRoot, ".dockerignore"), "utf8");
	for (const pattern of ["pi", "node_modules", ".env", "secrets"]) {
		assert.match(dockerignore, new RegExp(pattern.replace(".", "\\.")));
	}
	assert.doesNotMatch(dockerignore, /^markdowns$/m, "root knowledge Markdown must be available to the image seed");

	const seccomp = JSON.parse(await readFile(join(rsiRoot, "deploy/seccomp-bwrap.json"), "utf8"));
	assert.equal(seccomp.defaultAction, "SCMP_ACT_ERRNO");
	const allowed = new Set(seccomp.syscalls.flatMap((entry: { names?: string[] }) => entry.names ?? []));
	for (const name of ["clone", "clone3", "unshare", "mount", "umount2", "pivot_root"]) {
		assert.ok(allowed.has(name), `seccomp profile must allow ${name}`);
	}
});

test("deployment samples contain no prompt or credentials and use the shared config schema", async () => {
	const deployDir = join(rsiRoot, "deploy");
	const files = await readdir(deployDir);
	assert.equal(files.some((name) => name.endsWith(".md") || name.endsWith(".txt")), false);
	assert.equal(files.includes("Memory.md"), false);

	const sample = JSON.parse(await readFile(join(deployDir, "rsi.config.example.json"), "utf8"));
	const parsed = parseRsiConfig(sample);
	assert.equal(parsed.sandbox.network, "unrestricted");
	assert.equal(parsed.sandbox.workerUid, 10002);
	assert.equal(parsed.sandbox.workerGid, 10002);
	assert.ok(parsed.paths.systemPromptFile.endsWith("system-prompt.txt"));
	assert.equal(parsed.paths.rsiSourceDir.endsWith("opt\\rsi") || parsed.paths.rsiSourceDir.endsWith("opt/rsi"), true);

	const template = await readFile(join(deployDir, "rsi.config.template.json"), "utf8");
	assert.match(template, /\$\{RSI_TIME_ZONE\}/);
	assert.match(template, /\$\{RSI_WORKER_UID\}/);
	assert.match(template, /\$\{RSI_WORKER_GID\}/);

	const envExample = await readFile(join(deployDir, "rsi.env.example"), "utf8");
	assert.doesNotMatch(envExample, /sk-[A-Za-z0-9]/);
	assert.doesNotMatch(envExample, /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/);
	assert.match(envExample, /RSI_SYSTEM_PROMPT_FILE=\/absolute\/path/);
});

test("rendered config respects TZ and worker uid/gid and rejects invalid time zones", async () => {
	const dir = await tempDir("rsi-render-");
	try {
		const out = join(dir, "nested/config.json");
		const result = runNode("scripts/deployment-render-config.mjs", ["--out", out], {
			RSI_TIME_ZONE: "Asia/Shanghai",
			RSI_WORKER_UID: "10002",
			RSI_WORKER_GID: "10002",
		});
		assert.equal(result.status, 0, result.stderr);
		const rendered = JSON.parse(await readFile(out, "utf8"));
		assert.equal(rendered.timeZone, "Asia/Shanghai");
		assert.equal(rendered.sandbox.workerUid, 10002);
		assert.equal(parseRsiConfig(rendered).timeZone, "Asia/Shanghai");
		const info = await stat(out);
		if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);

		const bad = runNode("scripts/deployment-render-config.mjs", ["--out", join(dir, "bad.json")], {
			RSI_TIME_ZONE: "Not/AZone",
		});
		assert.notEqual(bad.status, 0);
		assert.match(bad.stderr, /Invalid IANA time zone/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("preflight validates the external prompt and fails closed when bubblewrap is unavailable", async () => {
	const root = await tempDir("rsi-preflight-");
	try {
		for (const name of ["workspace", "data", "data/markdowns", "state", "pi", "rsi"]) {
			await mkdir(join(root, name), { recursive: true });
		}
		const prompt = join(root, "prompt.txt");
		await writeFile(prompt, "external fixture; not an agent prompt\n", "utf8");
		const configPath = join(root, "config.json");
		const config = {
			version: 1,
			timeZone: "UTC",
			paths: {
				workspaceDir: join(root, "workspace"),
				dataDir: join(root, "data"),
				stateDir: join(root, "state"),
				piSourceDir: join(root, "pi"),
				rsiSourceDir: join(root, "rsi"),
				systemPromptFile: prompt,
			},
			sandbox: { bwrapPath: join(root, "missing-bwrap"), network: "unrestricted" },
		};
		await writeJson(configPath, config);
		const ok = runNode("scripts/deployment-preflight.mjs", ["--config", configPath, "--config-only"]);
		assert.equal(ok.status, 0, ok.stderr);

		await rm(prompt);
		const missing = runNode("scripts/deployment-preflight.mjs", ["--config", configPath, "--config-only"]);
		assert.notEqual(missing.status, 0);
		assert.match(missing.stderr, /PROMPT_MISSING/);

		await writeFile(prompt, "external fixture; not an agent prompt\n", "utf8");
		const noSandbox = runNode("scripts/deployment-preflight.mjs", ["--config", configPath]);
		assert.notEqual(noSandbox.status, 0);
		assert.match(noSandbox.stderr, /bubblewrap|no unsandboxed fallback/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("healthcheck reads real processes and accepts explicit sleep but rejects stale or degraded state", async () => {
	const dir = await tempDir("rsi-health-");
	const supervisor = await startLiveProcess();
	try {
		const healthPath = join(dir, "health.json");
		const health = {
			version: 1,
			updatedAtMs: Date.now(),
			supervisor: { pid: supervisor.pid, state: "running" },
			worker: { pid: supervisor.pid, state: "healthy", generation: 1 },
			sleep: { active: false, deadlineMs: null },
			watchdog: { phase: "healthy" },
		};
		await writeJson(healthPath, health);
		const healthy = runNode("scripts/container-healthcheck.mjs", [], { RSI_HEALTH_FILE: healthPath });
		assert.equal(healthy.status, 0, healthy.stderr);

		await writeJson(healthPath, {
			...health,
			worker: { pid: null, state: "sleeping", generation: 1 },
			sleep: { active: true, deadlineMs: Date.now() + 3_600_000 },
		});
		const sleeping = runNode("scripts/container-healthcheck.mjs", [], { RSI_HEALTH_FILE: healthPath });
		assert.equal(sleeping.status, 0, sleeping.stderr);

		await writeJson(healthPath, { ...health, updatedAtMs: Date.now() - 120_000 });
		const stale = runNode("scripts/container-healthcheck.mjs", [], { RSI_HEALTH_FILE: healthPath });
		assert.notEqual(stale.status, 0);
		assert.match(stale.stderr, /stale/);

		await writeJson(healthPath, { ...health, watchdog: { phase: "rollback" } });
		const rollback = runNode("scripts/container-healthcheck.mjs", [], { RSI_HEALTH_FILE: healthPath });
		assert.notEqual(rollback.status, 0);
		assert.match(rollback.stderr, /watchdog/);

		const missing = runNode("scripts/container-healthcheck.mjs", [], {
			RSI_HEALTH_FILE: join(dir, "missing.json"),
		});
		assert.notEqual(missing.status, 0);
		assert.match(missing.stderr, /cannot read/);
	} finally {
		await stopProcess(supervisor);
		await rm(dir, { recursive: true, force: true });
	}
});

test("log rotation is bounded and keeps retained files", async () => {
	const dir = await tempDir("rsi-logs-");
	try {
		const log = join(dir, "runtime.log");
		await writeFile(log, "x".repeat(1_000), "utf8");
		await writeFile(join(dir, "keep.txt"), "not a log", "utf8");
		const first = runNode("scripts/deployment-log-rotate.mjs", ["--once", "--dir", dir, "--max-bytes", "100", "--keep", "3"]);
		assert.equal(first.status, 0, first.stderr);
		assert.equal((await stat(log)).size, 0);
		assert.equal((await stat(`${log}.1`)).size, 1_000);

		await writeFile(log, "y".repeat(1_000), "utf8");
		const second = runNode("scripts/deployment-log-rotate.mjs", ["--once", "--dir", dir, "--max-bytes", "100", "--keep", "3"]);
		assert.equal(second.status, 0, second.stderr);
		const names = (await readdir(dir)).filter((name) => name.startsWith("runtime.log")).sort();
		assert.deepEqual(names, ["runtime.log", "runtime.log.1", "runtime.log.2"]);
		assert.equal((await stat(`${log}.2`)).size, 1_000);
		assert.equal((await stat(join(dir, "keep.txt"))).size, 9);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("control status and Unix-socket client use the documented private contract", async () => {
	const dir = await tempDir("rsi-control-");
	const server = createServer();
	try {
		const healthPath = join(dir, "health.json");
		await writeJson(healthPath, {
			version: 1,
			updatedAtMs: Date.now(),
			supervisor: { pid: process.pid, state: "running" },
			worker: { pid: process.pid, state: "healthy", generation: 2 },
			sleep: { active: false, deadlineMs: null },
			plugin: { generation: 2, healthTurns: 3, lkgGeneration: 2 },
			watchdog: { phase: "healthy" },
		});
		const status = runNode("scripts/container-control.mjs", ["status"], { RSI_HEALTH_FILE: healthPath });
		assert.equal(status.status, 0, status.stderr);
		assert.match(status.stdout, /worker pid=/);
		assert.match(status.stdout, /generation=2/);

		const socketPath =
			process.platform === "win32"
				? `\\\\.\\pipe\\rsi-control-${process.pid}-${Date.now()}`
				: join(dir, "operator.sock");
		let received: Record<string, unknown> | undefined;
		server.on("connection", (socket) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				const request = JSON.parse(buffer.slice(0, newline));
				received = request;
				socket.write(
					`${JSON.stringify({
						protocol: "rsi-control",
						version: 1,
						type: "response",
						requestId: request.requestId,
						ok: true,
						result: { detail: "queued", generation: null },
					})}\n`,
				);
			});
		});
		await new Promise<void>((resolvePromise) => server.listen(socketPath, resolvePromise));
		const client = await runNodeAsync(
			"scripts/container-control.mjs",
			["reload", "--candidate", "sha256:test", "--reason", "deployment-test"],
			{ RSI_CONTROL_SOCKET: socketPath },
		);
		assert.equal(client.status, 0, client.stderr);
		assert.equal(received?.protocol, "rsi-control");
		assert.equal(received?.source, "supervisor");
		assert.equal((received?.command as { kind?: string } | undefined)?.kind, "reload");
		assert.equal((received?.command as { candidateId?: string } | undefined)?.candidateId, "sha256:test");
		assert.match(client.stdout, /queued/);

		const unavailable = runNode("scripts/container-control.mjs", ["shutdown"], {
			RSI_CONTROL_SOCKET: join(dir, "absent.sock"),
		});
		assert.notEqual(unavailable.status, 0);
		assert.match(unavailable.stderr, /socket is unavailable/);
	} finally {
		server.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("Pi discovery loads exactly the two pinned packages from a verified agent home", { timeout: 60_000 }, async () => {
	const dir = await tempDir("rsi-plugin-verify-");
	try {
		const agentDir = join(dir, "agent");
		const sourceRoot = rsiRoot;
		for (const name of ["pi-continuity", "pi-better-web-search"]) {
			await cp(join(sourceRoot, "node_modules", name), join(agentDir, "npm", "node_modules", name), {
				recursive: true,
			});
		}
		await writeJson(join(agentDir, "settings.json"), { packages: REQUIRED_PLUGIN_SPECS });
		const ok = runNode("scripts/install-plugins.mjs", [
			"--verify-only",
			"--agent-dir",
			agentDir,
			"--source-root",
			sourceRoot,
		]);
		assert.equal(ok.status, 0, ok.stderr);
		assert.match(ok.stdout, /loaded 2 extensions/);

		const manifestPath = join(agentDir, "npm", "node_modules", "pi-continuity", "package.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		manifest.version = "0.0.0-tampered";
		await writeJson(manifestPath, manifest);
		const tampered = runNode("scripts/install-plugins.mjs", [
			"--verify-only",
			"--agent-dir",
			agentDir,
			"--source-root",
			sourceRoot,
		]);
		assert.notEqual(tampered.status, 0);
		assert.match(tampered.stderr, /manifest mismatch/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("root deployment Markdown stays within the word and document caps without touching the index", async () => {
	const markdowns = join(repoRoot, "markdowns");
	const names = (await readdir(markdowns)).filter((name) => name.endsWith(".md"));
	assert.ok(names.length <= MAX_MANAGED_DOCUMENTS);
	for (const name of ["operations.md", "security.md"]) {
		const content = await readFile(join(markdowns, name), "utf8");
		assert.ok(countWords(content) <= 1_000, `${name} exceeds 1000 words`);
	}
	const operations = await readFile(join(markdowns, "operations.md"), "utf8");
	assert.match(operations, /pi mcp/);
	assert.match(operations, /docker compose/);
	assert.match(operations, /bwrap/);
	const security = await readFile(join(markdowns, "security.md"), "utf8");
	assert.match(security, /bubblewrap/);
	assert.match(security, /插件/);
	assert.match(security, /Markdown/);
	assert.match(security, /网络/);
});
