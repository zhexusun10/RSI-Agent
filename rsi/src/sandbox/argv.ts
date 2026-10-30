import type { BubblewrapFeatures, SandboxPlan } from "./types.ts";
import { SANDBOX_SECCOMP_FD } from "./nested-userns.ts";

export const SANDBOX_RUNTIME_PROBE_READY_MARKER = "RSI_PREFLIGHT_READY";
export const SANDBOX_RUNTIME_PROBE_RESULT_MARKER = "RSI_PREFLIGHT_RESULT";
export const SANDBOX_RUNTIME_PROBE_HOSTNAME = "rsi-preflight";

function appendMount(argv: string[], option: "--bind" | "--ro-bind", source: string, target: string): void {
	argv.push(option, source, target);
}

/**
 * Build bubblewrap's argv as an array. There is no shell, no string
 * concatenation, and every path/argument remains a distinct argv element.
 *
 * The network namespace is deliberately not unshared, and the root filesystem
 * is not made read-only. Broad container-disk write access is preserved; only
 * the protected mounts, hidden control state, and sensitive sockets are
 * overlaid. Protected mounts are applied after writable mounts so a broad
 * writable bind cannot re-expose protected content.
 */
export function buildBubblewrapArgv(plan: SandboxPlan): string[] {
	const argv: string[] = [
		"--die-with-parent",
		"--new-session",
		"--unshare-user",
	];
	if (plan.nestedUsernsFilterPath !== null) argv.push("--seccomp", String(SANDBOX_SECCOMP_FD));
	argv.push(
		"--uid",
		String(plan.workerUid),
		"--gid",
		String(plan.workerGid),
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
	);
	if (plan.features.unshareCgroupTry) argv.push("--unshare-cgroup-try");
	argv.push(
		"--hostname",
		plan.hostname,
		// bwrap always sets PR_SET_NO_NEW_PRIVS; the explicit drop keeps the
		// capability bounding set empty inside the sandbox.
		"--cap-drop",
		"ALL",
		"--clearenv",
	);
	for (const key of Object.keys(plan.env).sort((left, right) => left.localeCompare(right, "en"))) {
		argv.push("--setenv", key, plan.env[key] ?? "");
	}
	argv.push(
		"--chdir",
		plan.cwd,
		// Preserve the ordinary container/VM disk. This is not a
		// workspace-only or whole-filesystem-read-only sandbox.
		"--bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		// /sys and host /dev metadata are not part of the Agent's usable disk.
		"--tmpfs",
		"/sys",
		// Node and common tools need a private shared-memory device.
		"--tmpfs",
		"/dev/shm",
	);

	for (const mount of plan.writableMounts) {
		appendMount(argv, mount.mode === "rw" ? "--bind" : "--ro-bind", mount.source, mount.target);
	}
	for (const mount of plan.readOnlyMounts) {
		appendMount(argv, "--ro-bind", mount.source, mount.target);
	}
	for (const target of plan.fileMasks) {
		// /dev/null comes from bwrap's minimal /dev, never from a host bind.
		appendMount(argv, "--ro-bind", "/dev/null", target);
	}
	for (const hidden of plan.hidden) {
		if (hidden.kind === "directory") {
			argv.push("--tmpfs", hidden.target);
		} else {
			appendMount(argv, "--ro-bind", "/dev/null", hidden.target);
		}
	}

	argv.push(plan.executable, ...plan.args);
	return argv;
}

/** The exact system-level probe invocation, with no user/plugin code. */
export function buildBubblewrapProbeArgv(input: {
	readonly bwrapPath: string;
	readonly workerUid: number;
	readonly workerGid: number;
	readonly nodePath: string;
	readonly features: BubblewrapFeatures;
	readonly nestedUsernsFilterPath?: string | null;
	readonly probeCode?: string;
}): string[] {
	const argv = [
		input.bwrapPath,
		"--die-with-parent",
		"--new-session",
		"--unshare-user",
	];
	if (input.nestedUsernsFilterPath !== undefined && input.nestedUsernsFilterPath !== null) {
		argv.push("--seccomp", String(SANDBOX_SECCOMP_FD));
	}
	argv.push(
		"--uid",
		String(input.workerUid),
		"--gid",
		String(input.workerGid),
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
	);
	if (input.features.unshareCgroupTry) argv.push("--unshare-cgroup-try");
	argv.push(
		"--hostname",
		SANDBOX_RUNTIME_PROBE_HOSTNAME,
		"--cap-drop",
		"ALL",
		"--clearenv",
		"--setenv",
		"PATH",
		"/usr/bin:/bin",
		"--chdir",
		"/",
		"--bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/sys",
		"--tmpfs",
		"/dev/shm",
		input.nodePath,
		"-e",
		input.probeCode ?? "process.exit(0)",
	);
	return argv;
}

/**
 * Script executed inside the real bwrap namespace probe. It reports facts only;
 * the trusted Supervisor makes the pass/fail decision and also reads the host
 * UID/GID from /proc outside the sandbox. The short hold keeps the process
 * alive while that host-side read happens.
 */
export function buildSandboxRuntimeProbeScript(input: {
	readonly workerUid: number;
	readonly workerGid: number;
	readonly marker: string;
	readonly holdMs?: number;
}): string {
	const expectedUid = String(input.workerUid);
	const expectedGid = String(input.workerGid);
	const holdMs = input.holdMs ?? 3_000;
	return `(() => {
  const fs = require("node:fs");
  const os = require("node:os");
  const facts = { marker: ${JSON.stringify(input.marker)}, expectedUid: ${expectedUid}, expectedGid: ${expectedGid} };
  facts.pid = process.pid;
  facts.ppid = process.ppid;
  facts.uid = process.getuid();
  facts.gid = process.getgid();
  facts.groups = process.getgroups();
  let status = "";
  try { status = fs.readFileSync("/proc/self/status", "utf8"); }
  catch (error) { facts.error = String(error && error.message ? error.message : error); }
  const cap = /^CapEff:\\s*([0-9a-fA-F]+)$/m.exec(status);
  facts.capEff = cap ? cap[1] : null;
  const ns = (name) => {
    try { const info = fs.statSync("/proc/self/ns/" + name); return String(info.dev) + ":" + String(info.ino); }
    catch { return null; }
  };
  facts.pidNs = ns("pid");
  facts.mntNs = ns("mnt");
  facts.userNs = ns("user");
  try { facts.hostname = os.hostname(); } catch { facts.hostname = null; }
  let mountinfo = "";
  try { mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8"); }
  catch (error) { facts.error = facts.error || String(error && error.message ? error.message : error); }
  facts.rootMount = mountinfo.split("\\n").some((line) => {
    const fields = line.split(" ");
    return fields[4] === "/";
  });
  facts.procMount = mountinfo.split("\\n").some((line) => {
    const fields = line.split(" ");
    return fields[4] === "/proc" && / - proc /.test(line);
  });
  try { facts.procFsType = fs.statfsSync("/proc").type; } catch { facts.procFsType = null; }
  let nestedUsernsBlocked = null;
  try {
    const cp = require("node:child_process");
    const attempt = cp.spawnSync("/usr/bin/unshare", ["--user", "true"], { stdio: "ignore", timeout: 2000 });
    if (!attempt.error) nestedUsernsBlocked = attempt.status !== 0;
  } catch {}
  facts.nestedUsernsBlocked = nestedUsernsBlocked;
  process.stdout.write(${JSON.stringify(SANDBOX_RUNTIME_PROBE_READY_MARKER)} + "\\n");
  process.stdout.write(${JSON.stringify(SANDBOX_RUNTIME_PROBE_RESULT_MARKER)} + " " + JSON.stringify(facts) + "\\n");
  let released = false;
  const done = () => { if (released) return; released = true; process.exit(0); };
  try {
    process.stdin.once("data", done);
    process.stdin.resume();
  } catch {}
  setTimeout(done, ${holdMs});
})();
`;
}

/**
 * Build the exact credential-switch command used by both the runtime probe and
 * the production launcher. The probe must exercise the real switch, not merely
 * compare argv strings.
 */
export interface BubblewrapCredentialCommand {
	readonly command: string;
	readonly args: readonly string[];
	readonly spawnUid?: number;
	readonly spawnGid?: number;
}

export function buildBubblewrapCredentialCommand(input: {
	readonly bwrapPath: string;
	readonly bwrapArgs: readonly string[];
	readonly workerUid: number;
	readonly workerGid: number;
	readonly strategy: "setpriv" | "spawn-uid";
	readonly credentialHelperPath?: string | null;
}): BubblewrapCredentialCommand {
	if (input.strategy === "setpriv") {
		if (input.credentialHelperPath === undefined || input.credentialHelperPath === null) {
			throw new Error("setpriv credential strategy requires a resolved helper path.");
		}
		return {
			command: input.credentialHelperPath,
			args: [
				"--reuid",
				String(input.workerUid),
				"--regid",
				String(input.workerGid),
				"--clear-groups",
				"--",
				input.bwrapPath,
				...input.bwrapArgs,
			],
		};
	}
	return {
		command: input.bwrapPath,
		args: [...input.bwrapArgs],
		spawnUid: input.workerUid,
		spawnGid: input.workerGid,
	};
}
