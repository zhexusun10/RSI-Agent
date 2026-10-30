import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	chown,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { after, before } from "node:test";
import { parseRsiConfig } from "../../src/shared/config.ts";
import { verifyRuntimeLayout } from "../../src/shared/layout-verify.ts";
import { createBubblewrapLauncherForConfig } from "../../src/sandbox/launcher.ts";
import { collectProcessTree } from "../../src/sandbox/process.ts";
import { inspectBubblewrapRuntime } from "../../src/sandbox/preflight.ts";
import type {
	BubblewrapLauncherOptions,
	SandboxExecutionRequest,
	SandboxProcessHandle,
} from "../../src/sandbox/types.ts";

const WORKER_UID = 65_534;
const WORKER_GID = 65_534;

interface Detection {
	readonly skipReason?: string;
	readonly bwrapPath?: string;
}

async function detectIntegration(): Promise<Detection> {
	if (process.platform !== "linux") {
		return { skipReason: `requires Linux; current platform is ${process.platform}` };
	}
	const uid = typeof process.geteuid === "function" ? process.geteuid() : 1;
	if (uid !== 0) {
		return {
			skipReason:
				"requires a root Supervisor to start bwrap under a distinct host Worker UID (setpriv/spawn uid); unprivileged single-UID user namespaces are not a distinct identity",
		};
	}
	const version = spawnSync(process.env.RSI_TEST_BWRAP ?? "bwrap", ["--version"], {
		encoding: "utf8",
		timeout: 5_000,
	});
	if (version.status !== 0) {
		return { skipReason: "bubblewrap is not installed or not executable on PATH" };
	}
	const report = await inspectBubblewrapRuntime(
		{
			workerUid: WORKER_UID,
			workerGid: WORKER_GID,
			supervisorUid: 0,
			probeTimeoutMs: 15_000,
		},
		process.env.RSI_TEST_BWRAP ?? "bwrap",
	);
	if (!report.ok || report.bwrapPath === null) {
		return { skipReason: `bubblewrap runtime preflight failed: ${report.errors.join(" | ")}` };
	}
	return { bwrapPath: report.bwrapPath };
}

const detection = await detectIntegration();
const skip = detection.skipReason;
const testOptions = skip === undefined ? {} : { skip };

function shQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
	const info = await lstat(path);
	await chown(path, uid, gid);
	if (!info.isDirectory()) return;
	for (const entry of await readdir(path)) {
		await chownTree(join(path, entry), uid, gid);
	}
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

async function processIsRunning(pid: number): Promise<boolean> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		const state = close === -1 ? "?" : stat.slice(close + 2).trim().split(/\s+/)[0];
		return state !== "Z";
	} catch {
		return false;
	}
}

let baseDir = "";
let workspace = "";
let pluginEditing = "";
let memoryFile = "";
let piFile = "";
let rsiFile = "";
let promptFile = "";
let candidateFile = "";
let pluginCandidateDir = "";
let launcher: ReturnType<typeof createBubblewrapLauncherForConfig>["launcher"];
let policy: ReturnType<typeof createBubblewrapLauncherForConfig>["policy"];
let workerHome = "";
let ordinaryTmpFile = "";

async function execute(
	script: string,
	options: {
		readonly timeoutMs?: number;
		readonly maxStdoutBytes?: number;
		readonly maxStderrBytes?: number;
		readonly extraEnv?: Record<string, string>;
	} = {},
): Promise<{ handle: SandboxProcessHandle; exit: Awaited<ReturnType<SandboxProcessHandle["wait"]>> }> {
	const request: SandboxExecutionRequest = {
		policy,
		workerEntry: "/bin/bash",
		args: ["-c", script],
		cwd: workspace,
		env: {
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			HOME: workerHome,
			TMPDIR: "/tmp",
			SUPERVISOR_PID: String(process.pid),
			...options.extraEnv,
		},
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		...(options.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: options.maxStdoutBytes }),
		...(options.maxStderrBytes === undefined ? {} : { maxStderrBytes: options.maxStderrBytes }),
	};
	const handle = await launcher.launch(request);
	const exit = await handle.wait();
	return { handle, exit };
}

before(async () => {
	if (skip !== undefined) return;
	baseDir = await mkdtemp(join(tmpdir(), "rsi-bwrap-os-"));
	await chmod(baseDir, 0o755);
	workspace = join(baseDir, "workspace");
	const dataDir = join(baseDir, "data");
	const stateDir = join(baseDir, "state");
	const markdownsDir = join(dataDir, "markdowns");
	workerHome = join(dataDir, "worker-home");
	pluginEditing = join(dataDir, "plugin-editing");
	const piSourceDir = join(baseDir, "pi");
	const rsiSourceDir = join(baseDir, "rsi");
	promptFile = join(baseDir, "system-prompt.txt");
	pluginCandidateDir = join(stateDir, "snapshots", "g1");
	candidateFile = join(pluginCandidateDir, "extensions", "index.js");
	memoryFile = join(markdownsDir, "Memory.md");
	piFile = join(piSourceDir, "pi-source.txt");
	rsiFile = join(rsiSourceDir, "supervisor-source.txt");
	ordinaryTmpFile = `/tmp/rsi-bwrap-ordinary-${process.pid}.txt`;

	for (const directory of [
		workspace,
		markdownsDir,
		workerHome,
		pluginEditing,
		join(dataDir, "pi-agent"),
		join(dataDir, "pi-sessions"),
		piSourceDir,
		rsiSourceDir,
		join(stateDir, "snapshots", "g1", "extensions"),
		join(stateDir, "control"),
		join(stateDir, "run"),
		join(stateDir, "plugins"),
		join(stateDir, "read-stats"),
		join(stateDir, "logs"),
	]) {
		await mkdir(directory, { recursive: true, mode: 0o755 });
	}
	await writeFile(memoryFile, "memory-old\n", { mode: 0o644 });
	await writeFile(join(markdownsDir, "index.md"), "# Index\n", { mode: 0o644 });
	await writeFile(piFile, "PI_SOURCE_MARKER\n", { mode: 0o644 });
	await writeFile(rsiFile, "RSI_SOURCE_MARKER\n", { mode: 0o644 });
	await writeFile(promptFile, "HUMAN_PROMPT_MARKER\n", { mode: 0o644 });
	await writeFile(candidateFile, "CANDIDATE_MARKER\n", { mode: 0o644 });

	await chownTree(workspace, WORKER_UID, WORKER_GID);
	await chownTree(pluginEditing, WORKER_UID, WORKER_GID);
	await chownTree(workerHome, WORKER_UID, WORKER_GID);
	await chownTree(join(dataDir, "pi-agent"), WORKER_UID, WORKER_GID);
	await chownTree(join(dataDir, "pi-sessions"), WORKER_UID, WORKER_GID);

	const config = parseRsiConfig({
		version: 1,
		timeZone: "UTC",
		paths: {
			workspaceDir: workspace,
			dataDir,
			stateDir,
			piSourceDir,
			rsiSourceDir,
			systemPromptFile: promptFile,
			markdownsDir,
		},
		sandbox: {
			bwrapPath: detection.bwrapPath ?? "bwrap",
			network: "unrestricted",
			workerUid: WORKER_UID,
			workerGid: WORKER_GID,
		},
	});
	const verified = await verifyRuntimeLayout(config.paths);
	const configured = createBubblewrapLauncherForConfig(config, verified, {
		readOnlyMounts: [
			{
				source: pluginCandidateDir,
				target: "/run/rsi-plugins/g1",
				mode: "ro",
			},
		],
		writableMounts: [
			{
				source: pluginEditing,
				target: pluginEditing,
				mode: "rw",
			},
		],
		terminationGraceMs: 300,
		killWaitMs: 1_500,
		maxStdoutBytes: 1_048_576,
		maxStderrBytes: 1_048_576,
	} satisfies Partial<BubblewrapLauncherOptions>);
	launcher = configured.launcher;
	policy = configured.policy;
});

after(async () => {
	if (baseDir.length > 0) await rm(baseDir, { recursive: true, force: true });
	if (ordinaryTmpFile.length > 0) await rm(ordinaryTmpFile, { force: true });
});

test("bash cannot alter Pi/RSI/prompt/Memory/candidate, aliases, renames, proc/fd; normal disk/plugin writes and network still work", testOptions, async () => {
	if (skip !== undefined) return;
	const pluginEditFile = join(pluginEditing, "bash-edit.txt");
	const workspaceFile = join(workspace, "bash-ordinary.txt");
	const script = `
set +e
pi_dir=${shQuote(join(baseDir, "pi"))}
pi_file=${shQuote(piFile)}
rsi_dir=${shQuote(join(baseDir, "rsi"))}
rsi_file=${shQuote(rsiFile)}
prompt_file=${shQuote(promptFile)}
memory_file=${shQuote(memoryFile)}
candidate_file=${shQuote(candidateFile)}
candidate_target=${shQuote("/run/rsi-plugins/g1/extensions/index.js")}
plugin_file=${shQuote(pluginEditFile)}
workspace_file=${shQuote(workspaceFile)}
tmp_file=${shQuote(ordinaryTmpFile)}
workspace_dir=${shQuote(workspace)}
base_dir=${shQuote(baseDir)}
write_test() {
  label="$1"; file="$2"
  if printf 'HACKED\\n' > "$file" 2>/dev/null; then echo "WRITE_OK:$label"; else echo "WRITE_FAIL:$label"; fi
}
cmd_test() {
  label="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "CMD_OK:$label"; else echo "CMD_FAIL:$label"; fi
}
write_test pi "$pi_file"
write_test rsi "$rsi_file"
write_test prompt "$prompt_file"
write_test memory "$memory_file"
write_test candidate_backing "$candidate_file"
write_test candidate_target "$candidate_target"
echo "CANDIDATE_READ:$(cat "$candidate_target" 2>/dev/null)"
write_test plugin_edit "$plugin_file"
write_test workspace "$workspace_file"
write_test ordinary_disk "$tmp_file"
cmd_test rename_pi mv "$pi_dir" "$pi_dir.moved"
cmd_test delete_pi rm -rf "$pi_dir"
cmd_test rename_prompt mv "$prompt_file" "$prompt_file.moved"
cmd_test delete_prompt rm -f "$prompt_file"
cmd_test rename_base mv "$base_dir" "$base_dir.moved"
ln -sfn "$pi_dir" "$workspace_dir/pi-link"
write_test symlink_pi "$workspace_dir/pi-link/pi-source.txt"
ln -sfn "$memory_file" "$workspace_dir/memory-link"
write_test symlink_memory "$workspace_dir/memory-link"
write_test proc_self_root "/proc/self/root$pi_file"
write_test proc_pid1_root "/proc/1/root$pi_file"
exec 9<"$prompt_file" 2>/dev/null
if printf 'HACKED\\n' >&9 2>/dev/null; then echo "WRITE_OK:fd"; else echo "WRITE_FAIL:fd"; fi
if printf 'HACKED\\n' > "/proc/self/fd/9" 2>/dev/null; then echo "WRITE_OK:procfd"; else echo "WRITE_FAIL:procfd"; fi
exec 9<&-
if mount --bind "$workspace_dir" "$pi_dir" 2>/dev/null; then
  echo "CMD_OK:mount_bind"
  umount "$pi_dir" 2>/dev/null
else
  echo "CMD_FAIL:mount_bind"
fi
if command -v unshare >/dev/null 2>&1; then
  if unshare -Ur true 2>/dev/null; then echo "CMD_OK:nested_userns"; else echo "CMD_FAIL:nested_userns"; fi
else
  echo "CMD_SKIP:nested_userns"
fi
if test -e "/proc/$SUPERVISOR_PID/root"; then echo "EXTERNAL_PROC:visible"; else echo "EXTERNAL_PROC:hidden"; fi
echo "NETNS:$(readlink /proc/self/ns/net)"
echo "CAP:$(grep '^CapEff:' /proc/self/status | tr -d '[:space:]')"
exit 0
`;
	const { handle, exit } = await execute(script);
	assert.equal(exit.exitCode, 0, `sandbox script failed: ${exit.signal ?? ""}`);
	const stdout = handle.output().stdout;
	for (const label of ["pi", "rsi", "prompt", "memory", "candidate_backing", "candidate_target"]) {
		assert.match(stdout, new RegExp(`WRITE_FAIL:${label}`), `protected write ${label} must fail`);
	}
	assert.match(stdout, /CANDIDATE_READ:CANDIDATE_MARKER/);
	for (const label of ["plugin_edit", "workspace", "ordinary_disk"]) {
		assert.match(stdout, new RegExp(`WRITE_OK:${label}`), `${label} must remain writable`);
	}
	for (const label of ["symlink_pi", "symlink_memory", "proc_self_root", "proc_pid1_root", "fd", "procfd"]) {
		assert.match(stdout, new RegExp(`WRITE_FAIL:${label}`), `${label} must not bypass the read-only mount`);
	}
	for (const label of ["rename_pi", "delete_pi", "rename_prompt", "delete_prompt", "rename_base", "mount_bind", "nested_userns"]) {
		assert.match(stdout, new RegExp(`CMD_FAIL:${label}`), `${label} must be denied`);
	}
	assert.match(stdout, /EXTERNAL_PROC:hidden/);
	assert.match(stdout, /CAP:CapEff:0+$/m);
	const hostNetNs = await readlink("/proc/self/ns/net");
	const match = stdout.match(/NETNS:(net:\[\d+\])/);
	assert.ok(match !== null);
	assert.equal(match[1], hostNetNs, "network namespace must remain the container namespace");

	assert.equal(await readFile(piFile, "utf8"), "PI_SOURCE_MARKER\n");
	assert.equal(await readFile(rsiFile, "utf8"), "RSI_SOURCE_MARKER\n");
	assert.equal(await readFile(promptFile, "utf8"), "HUMAN_PROMPT_MARKER\n");
	assert.equal(await readFile(candidateFile, "utf8"), "CANDIDATE_MARKER\n");
	assert.equal(await readFile(memoryFile, "utf8"), "memory-old\n");
	assert.equal((await readFile(pluginEditFile, "utf8")).trim(), "HACKED");
	assert.equal((await readFile(ordinaryTmpFile, "utf8")).trim(), "HACKED");
});

test("Node direct filesystem calls cannot write protected trees, but plugin editing and normal disk work", testOptions, async () => {
	if (skip !== undefined) return;
	const nodeScript = `
const fs = require("node:fs");
const paths = JSON.parse(process.env.RSI_TEST_PATHS);
const result = [];
function attempt(label, fn) {
  try { fn(); result.push("WRITE_OK:" + label); }
  catch { result.push("WRITE_FAIL:" + label); }
}
attempt("pi", () => fs.writeFileSync(paths.pi, "NODE_HACK\\n"));
attempt("rsi", () => fs.writeFileSync(paths.rsi, "NODE_HACK\\n"));
attempt("prompt", () => fs.writeFileSync(paths.prompt, "NODE_HACK\\n"));
attempt("memory", () => fs.writeFileSync(paths.memory, "NODE_HACK\\n"));
attempt("candidate", () => fs.writeFileSync(paths.candidate, "NODE_HACK\\n"));
attempt("parent_rename", () => fs.renameSync(paths.piDir, paths.piDir + ".moved"));
attempt("symlink_pi", () => {
  const link = paths.workspace + "/node-pi-link";
  try { fs.rmSync(link, { force: true }); } catch {}
  fs.symlinkSync(paths.piDir, link);
  fs.writeFileSync(link + "/pi-source.txt", "NODE_HACK\\n");
});
attempt("proc_self_root", () => fs.writeFileSync("/proc/self/root" + paths.pi, "NODE_HACK\\n"));
attempt("plugin_edit", () => fs.writeFileSync(paths.pluginEditing + "/node-edit.txt", "NODE_EDIT_OK\\n"));
attempt("workspace", () => fs.writeFileSync(paths.workspace + "/node-ordinary.txt", "NODE_ORDINARY_OK\\n"));
result.push("NETNS:" + fs.readlinkSync("/proc/self/ns/net"));
console.log(result.join("\\n"));
`;
	const request: SandboxExecutionRequest = {
		policy,
		workerEntry: process.execPath,
		args: ["-e", nodeScript],
		cwd: workspace,
		env: {
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			HOME: workerHome,
			TMPDIR: "/tmp",
			RSI_TEST_PATHS: JSON.stringify({
				pi: piFile,
				piDir: join(baseDir, "pi"),
				rsi: rsiFile,
				prompt: promptFile,
				memory: memoryFile,
				candidate: candidateFile,
				candidateTarget: "/run/rsi-plugins/g1/extensions/index.js",
				workspace,
				pluginEditing,
			}),
		},
	};
	const handle = await launcher.launch(request);
	const exit = await handle.wait();
	assert.equal(exit.exitCode, 0, handle.output().stderr);
	const stdout = handle.output().stdout;
	for (const label of ["pi", "rsi", "prompt", "memory", "candidate_backing", "candidate_target", "parent_rename", "symlink_pi", "proc_self_root"]) {
		assert.match(stdout, new RegExp(`WRITE_FAIL:${label}`), `Node ${label} write must fail`);
	}
	assert.match(stdout, /WRITE_OK:plugin_edit/);
	assert.match(stdout, /WRITE_OK:workspace/);
	const hostNetNs = await readlink("/proc/self/ns/net");
	assert.match(stdout, new RegExp(`NETNS:${hostNetNs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.equal(await readFile(piFile, "utf8"), "PI_SOURCE_MARKER\n");
	assert.equal(await readFile(rsiFile, "utf8"), "RSI_SOURCE_MARKER\n");
	assert.equal(await readFile(promptFile, "utf8"), "HUMAN_PROMPT_MARKER\n");
	assert.equal(await readFile(candidateFile, "utf8"), "CANDIDATE_MARKER\n");
	assert.equal(await readFile(memoryFile, "utf8"), "memory-old\n");
	assert.equal(await readFile(join(pluginEditing, "node-edit.txt"), "utf8"), "NODE_EDIT_OK\n");
});

test("Memory directory is a live read-only directory mount: broker atomic update is immediately visible", testOptions, async () => {
	if (skip !== undefined) return;
	const script = `
for i in $(seq 1 400); do
  if grep -q 'broker-update-marker' ${shQuote(memoryFile)} 2>/dev/null; then
    cat ${shQuote(memoryFile)}
    exit 0
  fi
  sleep 0.02
done
echo TIMEOUT
exit 9
`;
	const handle = await launcher.launch({
		policy,
		workerEntry: "/bin/bash",
		args: ["-c", script],
		cwd: workspace,
		env: {
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			HOME: workerHome,
			TMPDIR: "/tmp",
		},
	});
	const temporary = join(join(memoryFile, ".."), ".Memory.broker.tmp");
	await writeFile(temporary, "broker-update-marker\n", { mode: 0o644 });
	await rename(temporary, memoryFile);
	const exit = await handle.wait();
	assert.equal(exit.exitCode, 0, handle.output().stderr);
	assert.match(handle.output().stdout, /broker-update-marker/);
	assert.equal(await readFile(memoryFile, "utf8"), "broker-update-marker\n");
});

test("Supervisor stays alive and terminate kills the full ignored-TERM process tree", testOptions, async () => {
	if (skip !== undefined) return;
	const script = `
trap '' TERM
( trap '' TERM; while :; do sleep 1; done ) &
( trap '' TERM; while :; do sleep 1; done ) &
while :; do sleep 1; done
`;
	const handle = await launcher.launch({
		policy,
		workerEntry: "/bin/bash",
		args: ["-c", script],
		cwd: workspace,
		env: {
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			HOME: workerHome,
			TMPDIR: "/tmp",
		},
	});
	assert.equal(
		await waitFor(async () => (await handle.descendants()).length >= 3, 3_000),
		true,
		"sandbox process tree did not start",
	);
	const tracked = await collectProcessTree(handle.pid, handle.processGroupId);
	assert.ok(tracked.length >= 3);
	assert.doesNotThrow(() => process.kill(process.pid, 0), "Supervisor must remain alive");
	await handle.terminate("SIGTERM");
	const exit = await handle.wait();
	assert.equal(exit.terminated, true);
	assert.doesNotThrow(() => process.kill(process.pid, 0), "Supervisor must survive Worker termination");
	const gone = await waitFor(
		async () => {
			for (const identity of tracked) {
				if (await processIsRunning(identity.pid)) return false;
			}
			return true;
		},
		3_000,
	);
	assert.equal(gone, true, "all descendant host PIDs must be gone");
});

test("timeout and abort use TERM then KILL and clean up descendants", testOptions, async () => {
	if (skip !== undefined) return;
	const script = `trap '' TERM; while :; do sleep 1; done`;
	const timed = await launcher.launch({
		policy,
		workerEntry: "/bin/bash",
		args: ["-c", script],
		cwd: workspace,
		env: {
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			HOME: workerHome,
			TMPDIR: "/tmp",
		},
		timeoutMs: 400,
	});
	const timedExit = await timed.wait();
	assert.equal(timedExit.timedOut, true);
	assert.ok(timedExit.durationMs < 10_000);
	assert.equal(await waitFor(async () => !(await processIsRunning(timed.pid)), 3_000), true);

	const controller = new AbortController();
	const aborted = await launcher.launch({
		policy,
		workerEntry: "/bin/bash",
		args: ["-c", script],
		cwd: workspace,
		env: {
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			HOME: workerHome,
			TMPDIR: "/tmp",
		},
	}, controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 150));
	controller.abort();
	const abortedExit = await aborted.wait();
	assert.equal(abortedExit.aborted, true);
	assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test("exit code is attributed and stdout/stderr collection is bounded", testOptions, async () => {
	if (skip !== undefined) return;
	const exited = await execute("exit 42");
	assert.equal(exited.exit.exitCode, 42);
	assert.equal(exited.exit.signal, null);

	const outputHandle = await launcher.launch({
		policy,
		workerEntry: "/bin/bash",
		args: ["-c", "for i in $(seq 1 200); do printf '0123456789'; done; printf 'stderr-bytes' >&2"],
		cwd: workspace,
		env: {
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			HOME: workerHome,
			TMPDIR: "/tmp",
		},
		maxStdoutBytes: 64,
		maxStderrBytes: 8,
	});
	const outputExit = await outputHandle.wait();
	assert.equal(outputExit.exitCode, 0);
	const output = outputHandle.output();
	assert.equal(output.stdoutBytes, 2_000);
	assert.equal(output.stderrBytes, 12);
	assert.equal(output.stdoutTruncated, true);
	assert.equal(output.stderrTruncated, true);
	assert.ok(Buffer.byteLength(output.stdout, "utf8") <= 64);
	assert.ok(Buffer.byteLength(output.stderr, "utf8") <= 8);
});
