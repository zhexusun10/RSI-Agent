import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { isPathWithin } from "../../src/shared/paths.ts";
import type { SandboxHandle, SandboxLauncher, SandboxPolicy } from "../../src/shared/sandbox.ts";
import type { SandboxExecutionRequest } from "../../src/sandbox/types.ts";
import { ImmutableCandidateStore } from "../../src/reload/candidate-store.ts";
import { MappedPreflightLauncher } from "../../src/integration/reload-service.ts";
import {
	LocalProcessGroupLauncher,
} from "../../src/reload/process-tree.ts";
import { ReloadPreflight, SandboxLauncherPreflight } from "../../src/reload/preflight-runner.ts";
import type { ReloadCandidate } from "../../src/reload/types.ts";
import {
	PREFLIGHT_KIND_ENV,
	PREFLIGHT_MANIFEST_ENV,
	PREFLIGHT_RESULT_ENV,
} from "../../src/reload/workers/child-protocol.ts";
import { CHILD_STDERR_PATH_ENV } from "../../src/reload/process-tree.ts";
import {
	FakeClock,
	cleanupRoot,
	makeTempRoot,
	simplePackage,
	writeFiles,
} from "../reload/helpers.ts";

const RSI_ROOT = resolve(".");
const STATIC_ENTRY = join(RSI_ROOT, "src", "reload", "workers", "static-check-worker.ts");

function testPolicy(): SandboxPolicy {
	return {
		kind: "bubblewrap",
		bwrapPath: "bwrap",
		network: "unrestricted",
		capabilities: [],
		noNewPrivileges: true,
		unsharePid: true,
		unshareIpc: true,
		unshareUts: true,
		procfs: "isolated",
		rootFilesystem: "container-root",
		protected: [],
		canonicalProtected: [],
		hidden: [],
		writable: [],
		ipc: {
			transport: "unix",
			hostSocketPath: "/state/run/worker.sock",
			workerSocketPath: "/run/rsi/worker.sock",
			stdoutIsProtocol: false,
		},
		hardlinkPolicy: "broker-owned-nlink-1-and-protected-hardlinks",
	};
}

function fakeHandle(): SandboxHandle {
	return {
		pid: 1,
		startedAtMs: 0,
		async wait() {
			return { exitCode: 0, signal: null };
		},
		async terminate() {},
	};
}

async function assertUsableSafeCwd(cwd: string, workerEntry: string): Promise<void> {
	assert.equal((await stat(cwd)).isDirectory(), true, "cwd must exist");
	assert.equal(isPathWithin(RSI_ROOT, cwd), false, "cwd must be outside the protected RSI source tree");
	assert.equal(isPathWithin(dirname(workerEntry), cwd), false, "cwd must not be the worker source directory");
}

test("SandboxLauncherPreflight uses Node+argv and an existing safe cwd", async () => {
	const requests: SandboxExecutionRequest[] = [];
	const underlying: SandboxLauncher = {
		async launch(request) {
			requests.push(request as SandboxExecutionRequest);
			return fakeHandle();
		},
	};
	const launcher = new SandboxLauncherPreflight(underlying, testPolicy());
	await launcher.launch({
		workerEntry: STATIC_ENTRY,
		cwd: dirname(STATIC_ENTRY),
		env: {},
	});
	assert.equal(requests.length, 1);
	const request = requests[0]!;
	assert.equal(request.executable, process.execPath);
	assert.deepEqual(request.args, [STATIC_ENTRY]);
	await assertUsableSafeCwd(request.cwd, STATIC_ENTRY);
});

test("MappedPreflightLauncher maps candidate/result/stderr paths and keeps a usable host cwd", async () => {
	const root = await makeTempRoot("preflight-map");
	try {
		const snapshotDir = join(root, "state", "snapshots");
		const candidateRoot = join(snapshotDir, "gen-000001-mapcheck");
		const tempHost = join(root, "preflight", randomUUID());
		await mkdir(candidateRoot, { recursive: true });
		await mkdir(tempHost, { recursive: true });
		const manifestPath = join(candidateRoot, "candidate.json");
		const resultPath = join(tempHost, "result.json");
		const stderrPath = join(tempHost, "stderr.log");
		await writeFile(manifestPath, "{}\n");
		const requests: SandboxExecutionRequest[] = [];
		const underlying: SandboxLauncher = {
			async launch(request) {
				requests.push(request as SandboxExecutionRequest);
				return fakeHandle();
			},
		};
		const launcher = new MappedPreflightLauncher({
			launcher: underlying,
			policy: testPolicy(),
			snapshotDir,
			sandboxPathMapping: true,
		});
		await launcher.launch({
			workerEntry: STATIC_ENTRY,
			cwd: dirname(STATIC_ENTRY),
			env: {
				[PREFLIGHT_MANIFEST_ENV]: manifestPath,
				[PREFLIGHT_RESULT_ENV]: resultPath,
				[CHILD_STDERR_PATH_ENV]: stderrPath,
				[PREFLIGHT_KIND_ENV]: "static",
			},
		});
		const request = requests[0]!;
		assert.equal(request.executable, process.execPath);
		assert.deepEqual(request.args, [STATIC_ENTRY]);
		assert.equal(
			request.env?.[PREFLIGHT_MANIFEST_ENV],
			"/run/rsi-plugins/gen-000001-mapcheck/candidate.json",
		);
		assert.equal(
			request.env?.[PREFLIGHT_RESULT_ENV],
			`/run/rsi-preflight/${basename(tempHost)}/result.json`,
		);
		assert.equal(
			request.env?.[CHILD_STDERR_PATH_ENV],
			`/run/rsi-preflight/${basename(tempHost)}/stderr.log`,
		);
		assert.deepEqual(request.readOnlyMounts, [
			{ source: snapshotDir, target: "/run/rsi-plugins", mode: "ro" },
		]);
		assert.deepEqual(request.writableMounts, [
			{ source: tempHost, target: `/run/rsi-preflight/${basename(tempHost)}`, mode: "rw" },
		]);
		assert.equal(request.cwd, tempHost, "unsafe caller cwd falls back to the dedicated staging parent");
		await assertUsableSafeCwd(request.cwd, STATIC_ENTRY);
	} finally {
		await cleanupRoot(root);
	}
});

test("real static and Mock preflight children run from a dedicated staging cwd that is cleaned up", { timeout: 60_000 }, async () => {
	const root = await makeTempRoot("preflight-cwd");
	try {
		const source = join(root, "plugins", "demo");
		await writeFiles(source, simplePackage());
		const store = new ImmutableCandidateStore({
			snapshotDir: join(root, "state", "snapshots"),
			forbiddenRoots: [join(root, "state")],
			trustedDependencyRoots: [join(RSI_ROOT, "node_modules")],
		});
		const candidate: ReloadCandidate = await store.prepareCandidate({
			generation: 1,
			sourceRoots: [{ id: "demo", path: source, discovery: "extension" }],
			now: new FakeClock().now(),
		});
		const tempRoot = join(root, "preflight-tmp");
		const local = new LocalProcessGroupLauncher();
		const observed: SandboxExecutionRequest[] = [];
		const recording: SandboxLauncher = {
			async launch(request, signal) {
				const execution = request as SandboxExecutionRequest;
				await assertUsableSafeCwd(execution.cwd, execution.args?.[0] ?? STATIC_ENTRY);
				assert.equal(isPathWithin(tempRoot, execution.cwd), true);
				observed.push(execution);
				return await local.launch(execution, signal);
			},
		};
		const preflight = new ReloadPreflight({
			candidateStore: store,
			launcher: new SandboxLauncherPreflight(recording, testPolicy()),
			clock: new FakeClock(),
			tempRoot,
		});
		const outcome = await preflight.run(candidate);
		assert.equal(outcome.report.ok, true, JSON.stringify(outcome.report, null, 2));
		assert.equal(observed.length, 2, "both static and Mock children must launch");
		assert.match(observed[0]?.args?.[0] ?? "", /static-check-worker\.ts$/);
		assert.match(observed[1]?.args?.[0] ?? "", /mock-load-worker\.ts$/);
		for (const execution of observed) {
			assert.equal(execution.executable, process.execPath);
			assert.equal(execution.args?.length, 1);
			await assert.rejects(stat(execution.cwd), /ENOENT/);
		}
	} finally {
		await cleanupRoot(root);
	}
});

test("local launcher honors explicit executable/argv without double-wrapping Node or losing arguments", async () => {
	const root = await makeTempRoot("preflight-local");
	try {
		const script = join(root, "argv-probe.mjs");
		const output = join(root, "argv.json");
		await writeFile(
			script,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\n`,
			"utf8",
		);
		const args = ["alpha", "two words", "--flag=value", ""];
		const launcher = new LocalProcessGroupLauncher();
		const explicit = await launcher.launch({
			policy: testPolicy(),
			workerEntry: script,
			executable: process.execPath,
			args: [script, ...args],
			cwd: root,
		} as SandboxExecutionRequest);
		assert.deepEqual(await explicit.wait(), { exitCode: 0, signal: null });
		assert.deepEqual(JSON.parse(await readFile(output, "utf8")), args);

		const legacy = await launcher.launch({
			policy: testPolicy(),
			workerEntry: script,
			args,
			cwd: root,
		});
		assert.deepEqual(await legacy.wait(), { exitCode: 0, signal: null });
		assert.deepEqual(JSON.parse(await readFile(output, "utf8")), args);
	} finally {
		await cleanupRoot(root);
	}
});

test("Mock timeout kills the complete candidate process tree", { timeout: 60_000 }, async () => {
	const root = await makeTempRoot("preflight-tree");
	try {
		const pidFile = join(root, "grandchild.pid");
		const source = join(root, "plugins", "demo");
		await writeFiles(source, {
			"package.json": JSON.stringify({ name: "tree-plugin", version: "1.0.0", type: "module" }),
			"index.ts": [
				'import { spawn } from "node:child_process";',
				'import { writeFileSync } from "node:fs";',
				'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
				`writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
				"while (true) {}",
				"export default function extension(): void {}",
				"",
			].join("\n"),
		});
		const store = new ImmutableCandidateStore({
			snapshotDir: join(root, "state", "snapshots"),
			forbiddenRoots: [join(root, "state")],
			trustedDependencyRoots: [join(RSI_ROOT, "node_modules")],
		});
		const candidate = await store.prepareCandidate({
			generation: 1,
			sourceRoots: [{ id: "demo", path: source, discovery: "extension" }],
			now: new FakeClock().now(),
		});
		const preflight = new ReloadPreflight({
			candidateStore: store,
			launcher: new SandboxLauncherPreflight(new LocalProcessGroupLauncher(), testPolicy()),
			clock: new FakeClock(),
			tempRoot: join(root, "preflight-tmp"),
		});
		const outcome = await preflight.run(candidate);
		assert.equal(outcome.report.ok, false);
		assert.equal(outcome.diagnostics.mockLoad.timedOut, true);
		assert.match(outcome.report.mockLoad.errors.join("\n"), /timed out after 3000ms/i);

		const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
		assert.ok(Number.isSafeInteger(pid) && pid > 1, "the candidate must have started a child process");
		const deadline = Date.now() + 5_000;
		let alive = true;
		while (Date.now() < deadline) {
			try {
				process.kill(pid, 0);
			} catch {
				alive = false;
				break;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
		assert.equal(alive, false, `candidate grandchild ${pid} survived the preflight deadline`);
	} finally {
		await cleanupRoot(root);
	}
});
