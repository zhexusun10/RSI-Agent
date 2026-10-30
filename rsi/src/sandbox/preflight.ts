import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { accessSync, closeSync, constants, openSync } from "node:fs";
import { posix } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { RsiError } from "../shared/errors.ts";
import {
	buildBubblewrapCredentialCommand,
	buildBubblewrapProbeArgv,
	buildSandboxRuntimeProbeScript,
	SANDBOX_RUNTIME_PROBE_HOSTNAME,
	SANDBOX_RUNTIME_PROBE_READY_MARKER,
	SANDBOX_RUNTIME_PROBE_RESULT_MARKER,
} from "./argv.ts";
import { minimalHostEnvironment } from "./environment.ts";
import { createNestedUsernsFilterFile } from "./nested-userns.ts";
import type {
	BubblewrapFeatures,
	BubblewrapPreflightReport,
	BubblewrapRuntimePreflightOptions,
	SandboxPreflightCheck,
	SandboxSysctlReader,
} from "./types.ts";
import { DEFAULT_PROBE_TIMEOUT_MS, EMPTY_BUBBLEWRAP_FEATURES } from "./types.ts";

const PROC_SUPER_MAGIC = 0x9fa0;
const MAX_PROBE_OUTPUT_BYTES = 1_048_576;
const MAX_DESCENDANT_SCAN = 64;

function effectiveUid(): number {
	return typeof process.geteuid === "function" ? process.geteuid() : 0;
}

function effectiveGid(): number {
	return typeof process.getegid === "function" ? process.getegid() : 0;
}

function platformCheck(platform: NodeJS.Platform): SandboxPreflightCheck {
	if (platform === "linux") {
		return { name: "platform", ok: true, message: "Linux platform detected." };
	}
	return {
		name: "platform",
		ok: false,
		message: `bubblewrap is only available on Linux; current platform is ${platform}.`,
		hint: "Run the Supervisor and Worker inside a Linux container or Linux VM. There is no unsandboxed fallback.",
	};
}

function baseReport(input: {
	readonly platform: NodeJS.Platform;
	readonly checks: readonly SandboxPreflightCheck[];
	readonly errors: readonly string[];
	readonly bwrapPath?: string | null;
	readonly bwrapVersion?: string | null;
	readonly features?: BubblewrapFeatures;
	readonly credentialStrategy?: "setpriv" | "spawn-uid" | "none";
	readonly credentialHelperPath?: string | null;
	readonly protectedHardlinksEnabled?: boolean;
	readonly protectedSymlinksEnabled?: boolean;
	readonly workerUidDistinct?: boolean;
	readonly workerGidDistinct?: boolean;
	readonly probeExecuted?: boolean;
	readonly namespaceVerified?: boolean;
	readonly mountVerified?: boolean;
	readonly capEffZero?: boolean;
	readonly supplementaryGroupsCleared?: boolean;
	readonly hostIdentityVerified?: boolean;
	readonly observedHostUid?: number | null;
	readonly observedHostGid?: number | null;
	readonly observedNamespaceUid?: number | null;
	readonly observedNamespaceGid?: number | null;
	readonly probeHostPid?: number | null;
	readonly probeNamespacePid?: number | null;
	readonly nestedUsernsBlocked?: boolean;
	readonly nestedUsernsFilterPath?: string | null;
}): BubblewrapPreflightReport {
	return {
		ok: false,
		errors: [...input.errors],
		protectedHardlinksEnabled: input.protectedHardlinksEnabled ?? false,
		protectedSymlinksEnabled: input.protectedSymlinksEnabled ?? false,
		workerUidDistinct: input.workerUidDistinct ?? false,
		workerGidDistinct: input.workerGidDistinct ?? false,
		aliasRisks: [],
		platform: input.platform,
		bwrapPath: input.bwrapPath ?? null,
		bwrapVersion: input.bwrapVersion ?? null,
		features: input.features ?? EMPTY_BUBBLEWRAP_FEATURES,
		credentialStrategy: input.credentialStrategy ?? "none",
		credentialHelperPath: input.credentialHelperPath ?? null,
		checks: [...input.checks],
		probeExecuted: input.probeExecuted ?? false,
		namespaceVerified: input.namespaceVerified ?? false,
		mountVerified: input.mountVerified ?? false,
		capEffZero: input.capEffZero ?? false,
		supplementaryGroupsCleared: input.supplementaryGroupsCleared ?? false,
		hostIdentityVerified: input.hostIdentityVerified ?? false,
		observedHostUid: input.observedHostUid ?? null,
		observedHostGid: input.observedHostGid ?? null,
		observedNamespaceUid: input.observedNamespaceUid ?? null,
		observedNamespaceGid: input.observedNamespaceGid ?? null,
		probeHostPid: input.probeHostPid ?? null,
		probeNamespacePid: input.probeNamespacePid ?? null,
		nestedUsernsBlocked: input.nestedUsernsBlocked ?? false,
		nestedUsernsFilterPath: input.nestedUsernsFilterPath ?? null,
	};
}

/** Resolve a configured bwrap name/path without ever falling back to PATH-less exec. */
export async function resolveBubblewrapExecutable(
	command: string,
	pathEnv = process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
): Promise<string> {
	if (typeof command !== "string" || command.length === 0 || command.includes("\u0000")) {
		throw new RsiError("SANDBOX_INVALID", "sandbox.bwrapPath must be a non-empty executable name or path.");
	}
	const candidates: string[] = [];
	if (command.includes("/")) {
		if (!posix.isAbsolute(command)) {
			throw new RsiError("SANDBOX_INVALID", "sandbox.bwrapPath with a slash must be absolute.");
		}
		candidates.push(command);
	} else {
		for (const directory of pathEnv.split(":")) {
			if (directory.length === 0) continue;
			candidates.push(posix.join(directory, command));
		}
	}
	for (const candidate of candidates) {
		try {
			const info = await lstat(candidate);
			if (!info.isFile() && !info.isSymbolicLink()) continue;
			accessSync(candidate, constants.X_OK);
			return await realpath(candidate);
		} catch {
			// Try the next PATH entry.
		}
	}
	throw new RsiError(
		"SANDBOX_INVALID",
		`bubblewrap executable was not found or is not executable: ${command}`,
	);
}

/**
 * Parse bwrap --help. `--disable-userns` is kept as a diagnostic flag only;
 * nested user namespaces are blocked by the seccomp filter passed with
 * `--seccomp FD`, which also works when /proc/sys is read-only.
 */
export function parseBubblewrapFeatureSet(helpText: string, setuid: boolean): BubblewrapFeatures {
	const options = new Set(helpText.match(/--[a-z0-9-]+/g) ?? []);
	return {
		disableUserns: options.has("--disable-userns") && !setuid,
		seccompFd: options.has("--seccomp"),
		unshareCgroupTry: options.has("--unshare-cgroup-try"),
	};
}

function runCapture(
	command: string,
	args: readonly string[],
	timeoutMs: number,
): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: string } {
	const result = spawnSync(command, [...args], {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: MAX_PROBE_OUTPUT_BYTES,
		env: minimalHostEnvironment(),
		windowsHide: true,
	});
	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		...(result.error === undefined ? {} : { error: result.error.message }),
	};
}

function userNamespaceHint(stderr: string): string | undefined {
	const lower = stderr.toLowerCase();
	if (
		lower.includes("no permissions to create") ||
		lower.includes("creating new namespace") ||
		lower.includes("operation not permitted") ||
		lower.includes("uid map") ||
		lower.includes("gid map")
	) {
		return "Enable unprivileged user namespaces for the Supervisor, allow bwrap in the container's seccomp/AppArmor profile, and install non-setuid bubblewrap. Check /proc/sys/kernel/unprivileged_userns_clone and kernel.apparmor_restrict_unprivileged_userns.";
	}
	if (lower.includes("mount proc") || lower.includes("/newroot/proc")) {
		return "Mounting an isolated /proc was denied. Check Docker masked paths, AppArmor, and the supplied seccomp profile (deploy/seccomp-bwrap.json).";
	}
	if (lower.includes("disable-userns")) {
		return "The seccomp-based nested-userns block failed. Use a non-setuid bubblewrap with --seccomp support; do not rely on a writable /proc/sys in containers.";
	}
	if (lower.includes("seccomp") || lower.includes("apparmor")) {
		return "Allow the required namespace/mount syscalls to bwrap in the container's seccomp/AppArmor profile; there is no unsandboxed fallback.";
	}
	return undefined;
}

export interface ProtectedSysctlReport {
	readonly checks: readonly SandboxPreflightCheck[];
	readonly errors: readonly string[];
	readonly protectedHardlinksEnabled: boolean;
	readonly protectedSymlinksEnabled: boolean;
}

/**
 * Read the two host sysctls that protect hardlink/symlink exchange. A missing,
 * unreadable, or non-1 value is always a hard failure. The reader is injectable
 * only for tests; production uses the real /proc filesystem.
 */
export async function inspectProtectedSysctls(
	readSysctl: SandboxSysctlReader = async (path) => await readFile(path, "utf8"),
): Promise<ProtectedSysctlReport> {
	const checks: SandboxPreflightCheck[] = [];
	const errors: string[] = [];
	const entries = [
		{
			name: "protected-hardlinks",
			path: "/proc/sys/fs/protected_hardlinks",
			label: "fs.protected_hardlinks",
			message:
				"fs.protected_hardlinks is not 1; the Worker could hardlink protected files through a writable directory.",
			hint: "Set fs.protected_hardlinks=1 on the Docker host/kernel (sysctl -w fs.protected_hardlinks=1).",
		},
		{
			name: "protected-symlinks",
			path: "/proc/sys/fs/protected_symlinks",
			label: "fs.protected_symlinks",
			message:
				"fs.protected_symlinks is not 1; the Worker could follow an attacker-controlled symlink through a writable directory.",
			hint: "Set fs.protected_symlinks=1 on the Docker host/kernel (sysctl -w fs.protected_symlinks=1).",
		},
	] as const;
	let protectedHardlinksEnabled = false;
	let protectedSymlinksEnabled = false;
	for (const entry of entries) {
		let value: string | null = null;
		let readError: string | null = null;
		try {
			value = (await readSysctl(entry.path)).trim();
		} catch (error) {
			readError = error instanceof Error ? error.message : String(error);
		}
		const ok = value === "1";
		if (entry.name === "protected-hardlinks") protectedHardlinksEnabled = ok;
		else protectedSymlinksEnabled = ok;
		const message = ok
			? `${entry.label}=1.`
			: readError === null
				? `${entry.message} (found ${value === null || value.length === 0 ? "empty" : value}).`
				: `${entry.label} is not readable (${readError}); fail closed because an unverified sysctl is not protection.`;
		checks.push({ name: entry.name, ok, message, ...(ok ? {} : { hint: entry.hint }) });
		if (!ok) {
			errors.push(
				readError === null
					? `${entry.label}=1 is required; found ${value === null || value.length === 0 ? "empty" : value}.`
					: `${entry.label} must be readable and equal 1: ${readError}`,
			);
		}
	}
	return { checks, errors, protectedHardlinksEnabled, protectedSymlinksEnabled };
}

export interface SandboxProbeFacts {
	readonly marker: string;
	readonly pid: number;
	readonly ppid: number;
	readonly uid: number;
	readonly gid: number;
	readonly groups: readonly number[];
	readonly capEff: string | null;
	readonly pidNs: string | null;
	readonly mntNs: string | null;
	readonly userNs: string | null;
	readonly hostname: string | null;
	readonly rootMount: boolean;
	readonly procMount: boolean;
	readonly procFsType: number | null;
	readonly nestedUsernsBlocked: boolean | null;
	readonly error: string | null;
}

export interface SandboxRuntimeProbeHostIdentity {
	readonly pid: number;
	readonly uidValues: readonly number[];
	readonly gidValues: readonly number[];
}

export interface SandboxProbeExpectations {
	readonly workerUid: number;
	readonly workerGid: number;
	readonly supervisorUid: number;
	readonly supervisorGid: number;
	readonly marker: string;
	readonly hostPidNamespace: string;
	readonly hostMountNamespace: string;
	readonly hostUserNamespace: string;
}

export interface SandboxProbeAssessment {
	readonly ok: boolean;
	readonly checks: readonly SandboxPreflightCheck[];
	readonly errors: readonly string[];
	readonly namespaceVerified: boolean;
	readonly mountVerified: boolean;
	readonly capEffZero: boolean;
	readonly supplementaryGroupsCleared: boolean;
	readonly hostIdentityVerified: boolean;
	readonly observedHostUid: number | null;
	readonly observedHostGid: number | null;
	readonly observedNamespaceUid: number | null;
	readonly observedNamespaceGid: number | null;
	readonly probeHostPid: number | null;
	readonly probeNamespacePid: number | null;
	readonly nestedUsernsBlocked: boolean;
}

/**
 * Pure verdict for the facts reported from inside the sandbox plus the UID/GID
 * the Supervisor reads from /proc outside the sandbox. Namespace `id -u` alone
 * is never accepted as proof of a distinct host Worker identity.
 */
export function assessSandboxProbeFacts(
	facts: SandboxProbeFacts | null,
	hostIdentity: SandboxRuntimeProbeHostIdentity | null,
	expectations: SandboxProbeExpectations,
	hostIdentityError?: string | null,
): SandboxProbeAssessment {
	const checks: SandboxPreflightCheck[] = [];
	const errors: string[] = [];
	const push = (check: SandboxPreflightCheck): void => {
		checks.push(check);
		if (!check.ok) errors.push(check.message);
	};

	const namespaceUid = facts === null ? null : facts.uid;
	const namespaceGid = facts === null ? null : facts.gid;
	const hostUid = hostIdentity === null ? null : (hostIdentity.uidValues[0] ?? null);
	const hostGid = hostIdentity === null ? null : (hostIdentity.gidValues[0] ?? null);

	const identityIssues: string[] = [];
	if (facts === null) identityIssues.push("no sandbox probe facts were produced");
	else {
		if (facts.marker !== expectations.marker) identityIssues.push("probe marker did not match this invocation");
		if (facts.uid !== expectations.workerUid) {
			identityIssues.push(`namespace uid ${facts.uid} is not the configured Worker uid ${expectations.workerUid}`);
		}
		if (facts.gid !== expectations.workerGid) {
			identityIssues.push(`namespace gid ${facts.gid} is not the configured Worker gid ${expectations.workerGid}`);
		}
	}
	if (hostIdentity === null) {
		identityIssues.push(
			hostIdentityError === undefined || hostIdentityError === null
				? "host UID/GID could not be read from /proc outside the sandbox"
				: `host UID/GID could not be read from /proc outside the sandbox: ${hostIdentityError}`,
		);
	} else {
		if (hostIdentity.uidValues.length === 0 || hostIdentity.uidValues.some((value) => value !== expectations.workerUid)) {
			identityIssues.push(
				`host UID values ${hostIdentity.uidValues.join("/") || "unavailable"} do not all equal the Worker uid ${expectations.workerUid}`,
			);
		}
		if (hostIdentity.gidValues.length === 0 || hostIdentity.gidValues.some((value) => value !== expectations.workerGid)) {
			identityIssues.push(
				`host GID values ${hostIdentity.gidValues.join("/") || "unavailable"} do not all equal the Worker gid ${expectations.workerGid}`,
			);
		}
	}
	if (expectations.workerUid === 0 || expectations.workerUid === expectations.supervisorUid) {
		identityIssues.push("Worker uid is not a non-root host uid distinct from the Supervisor");
	}
	if (expectations.workerGid === 0 || expectations.workerGid === expectations.supervisorGid) {
		identityIssues.push("Worker gid is not a non-root host gid distinct from the Supervisor");
	}
	const hostIdentityVerified = identityIssues.length === 0;
	push({
		name: "worker-identity",
		ok: hostIdentityVerified,
		message: hostIdentityVerified
			? `Host Worker identity verified outside the sandbox: host uid=${hostUid} gid=${hostGid}; namespace uid=${namespaceUid} gid=${namespaceGid}.`
			: `Host Worker identity is not verified: ${identityIssues.join("; ")}.`,
		...(hostIdentityVerified
			? {}
			: {
					hint: "Start bwrap through the production setpriv/spawn UID switch as the dedicated Worker host UID/GID. A namespace-only uid is not a distinct host identity.",
				}),
	});

	const groups = facts === null ? [] : facts.groups;
	const supplementaryGroupsCleared =
		facts !== null && groups.every((group) => group === expectations.workerGid);
	if (facts !== null && facts.error !== null) {
		push({
			name: "probe-facts",
			ok: false,
			message: `The sandbox probe reported a read error: ${facts.error}`,
			hint: "Every probe fact must be readable; an unverified fact is not protection.",
		});
	}
	push({
		name: "supplementary-groups",
		ok: supplementaryGroupsCleared,
		message: supplementaryGroupsCleared
			? groups.length === 0
				? "Supplementary groups are empty."
				: `Supplementary groups contain only the Worker gid ${expectations.workerGid}.`
			: `Supplementary groups were not cleared: ${groups.join(",") || "unavailable"}.`,
		...(supplementaryGroupsCleared
			? {}
			: { hint: "Launch bwrap through setpriv --clear-groups (or an equivalent trusted helper)." }),
	});

	let capEffZero = false;
	if (facts !== null && facts.capEff !== null && /^[0-9a-fA-F]+$/.test(facts.capEff)) {
		try {
			capEffZero = BigInt(`0x${facts.capEff}`) === 0n;
		} catch {
			capEffZero = false;
		}
	}
	push({
		name: "capabilities",
		ok: capEffZero,
		message: capEffZero
			? "CapEff is 0 inside the sandbox /proc."
			: `CapEff is not zero or could not be read (${facts?.capEff ?? "unavailable"}).`,
		...(capEffZero ? {} : { hint: "Do not grant the Worker capabilities and keep --cap-drop ALL." }),
	});

	const nestedUsernsBlocked = facts !== null && facts.nestedUsernsBlocked === true;
	push({
		name: "nested-userns",
		ok: nestedUsernsBlocked,
		message: nestedUsernsBlocked
			? "Nested user-namespace creation is blocked inside the sandbox by the seccomp filter."
			: facts === null
				? "Nested user-namespace blocking could not be verified: no probe facts."
				: facts.nestedUsernsBlocked === null
					? "Nested user-namespace blocking could not be verified: /usr/bin/unshare is unavailable inside the sandbox."
					: "Nested user-namespace creation succeeded inside the sandbox; protected mounts could be remounted.",
		...(nestedUsernsBlocked
			? {}
			: {
					hint: "Launch bwrap with the shipped nested-userns seccomp filter (--seccomp FD); do not rely on a writable /proc/sys in containers.",
				}),
	});

	let namespaceVerified = false;
	if (facts !== null && hostIdentity !== null) {
		namespaceVerified =
			facts.pid !== hostIdentity.pid &&
			facts.pidNs !== null &&
			facts.pidNs !== expectations.hostPidNamespace &&
			facts.userNs !== null &&
			facts.userNs !== expectations.hostUserNamespace;
	}
	push({
		name: "namespace",
		ok: namespaceVerified,
		message: namespaceVerified
			? `PID and user namespaces verified: namespace pid=${facts?.pid}, host pid=${hostIdentity?.pid}; pidns/user-ns differ from the Supervisor.`
			: "PID/user namespace isolation was not verified; namespace-local uid/pid is not proof of a distinct host process.",
		...(namespaceVerified
			? {}
			: {
					hint: "Require a real bwrap --unshare-user --unshare-pid run and verify it from /proc on the host side.",
				}),
	});

	let mountVerified = false;
	if (facts !== null) {
		mountVerified =
			facts.mntNs !== null &&
			facts.mntNs !== expectations.hostMountNamespace &&
			facts.rootMount &&
			facts.procMount &&
			facts.procFsType === PROC_SUPER_MAGIC &&
			facts.hostname === SANDBOX_RUNTIME_PROBE_HOSTNAME;
	}
	push({
		name: "mount",
		ok: mountVerified,
		message: mountVerified
			? "Mount namespace verified with a pivoted root, an isolated procfs, and the probe UTS hostname."
			: `Mount namespace/procfs/UTS verification failed (mnt-ns=${facts?.mntNs ?? "unavailable"}, root=${facts?.rootMount ?? false}, proc=${facts?.procMount ?? false}, procfs=${facts?.procFsType ?? "unavailable"}, hostname=${facts?.hostname ?? "unavailable"}).`,
		...(mountVerified
			? {}
			: { hint: "Require a real bwrap mount namespace with --proc /proc and --unshare-uts." }),
	});

	return {
		ok: errors.length === 0,
		checks,
		errors,
		namespaceVerified,
		mountVerified,
		capEffZero,
		nestedUsernsBlocked,
		supplementaryGroupsCleared,
		hostIdentityVerified,
		observedHostUid: hostUid,
		observedHostGid: hostGid,
		observedNamespaceUid: namespaceUid,
		observedNamespaceGid: namespaceGid,
		probeHostPid: hostIdentity === null ? null : hostIdentity.pid,
		probeNamespacePid: facts === null ? null : facts.pid,
	};
}

export interface SandboxRuntimeProbeInput {
	readonly command: string;
	readonly args: readonly string[];
	readonly spawnUid?: number;
	readonly spawnGid?: number;
	readonly timeoutMs: number;
	readonly marker: string;
	readonly readyMarker: string;
	readonly resultMarker: string;
	readonly nodePath: string;
	readonly seccompFilterPath?: string | null;
}

export interface SandboxRuntimeProbeResult {
	readonly status: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly error: string | null;
	readonly hostIdentity: SandboxRuntimeProbeHostIdentity | null;
	readonly hostIdentityError: string | null;
}

function parseStatusIds(status: string, key: "Uid" | "Gid"): number[] | null {
	const match = new RegExp(`^${key}:\\s+(.+)$`, "m").exec(status);
	if (match === null || match[1] === undefined) return null;
	const values = match[1]
		.trim()
		.split(/\s+/)
		.map((value) => Number(value));
	if (values.length === 0) return null;
	for (const value of values) {
		if (!Number.isSafeInteger(value) || value < 0) return null;
	}
	return values;
}

async function readChildPids(pid: number): Promise<number[]> {
	try {
		const text = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
		return text
			.trim()
			.split(/\s+/)
			.filter((value) => value.length > 0)
			.map((value) => Number(value))
			.filter((value) => Number.isSafeInteger(value) && value > 0);
	} catch {
		return [];
	}
}

async function collectDescendantPids(rootPid: number): Promise<number[]> {
	const descendants: number[] = [];
	const seen = new Set<number>([rootPid]);
	const queue = [rootPid];
	while (queue.length > 0 && descendants.length < MAX_DESCENDANT_SCAN) {
		const current = queue.shift();
		if (current === undefined) break;
		for (const child of await readChildPids(current)) {
			if (seen.has(child)) continue;
			seen.add(child);
			descendants.push(child);
			queue.push(child);
			if (descendants.length >= MAX_DESCENDANT_SCAN) break;
		}
	}
	return descendants;
}

async function readHostProbeIdentity(
	spawnedPid: number,
	marker: string,
	nodePath: string,
): Promise<{ identity: SandboxRuntimeProbeHostIdentity | null; error: string | null }> {
	let descendants: number[];
	try {
		descendants = await collectDescendantPids(spawnedPid);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { identity: null, error: `could not enumerate /proc descendants: ${message}` };
	}
	for (const pid of descendants) {
		let cmdline: string;
		try {
			cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
		} catch {
			continue;
		}
		const argv = cmdline.split("\u0000").filter((part) => part.length > 0);
		if (argv[0] !== nodePath || !cmdline.includes(marker)) continue;
		let status: string;
		try {
			status = await readFile(`/proc/${pid}/status`, "utf8");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { identity: null, error: `could not read /proc/${pid}/status: ${message}` };
		}
		const uidValues = parseStatusIds(status, "Uid");
		const gidValues = parseStatusIds(status, "Gid");
		if (uidValues === null || gidValues === null) {
			return { identity: null, error: `could not parse Uid/Gid from /proc/${pid}/status` };
		}
		return { identity: { pid, uidValues, gidValues }, error: null };
	}
	return {
		identity: null,
		error: `could not locate the sandboxed probe process below host pid ${spawnedPid} in /proc`,
	};
}

function killProcessTree(pid: number | undefined, child: { kill: (signal?: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
	if (pid !== undefined) {
		try {
			process.kill(-pid, signal);
		} catch {
			// Fall through to the direct child kill below.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// The process may already have exited.
	}
}

/**
 * Run the real bwrap credential command, read the sandboxed process's host
 * UID/GID from /proc, and return raw facts. This is the only namespace/mount
 * probe used by CLI, deployment, and launcher preflight.
 */
export async function runSandboxRuntimeProbe(
	input: SandboxRuntimeProbeInput,
): Promise<SandboxRuntimeProbeResult> {
	return await new Promise<SandboxRuntimeProbeResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let error: string | null = null;
		let hostIdentity: SandboxRuntimeProbeHostIdentity | null = null;
		let hostIdentityError: string | null = null;
		let readySeen = false;
		let resultSeen = false;
		let identityStarted = false;
		let identitySettled = false;
		let finished = false;
		let timer: NodeJS.Timeout | undefined;
		let child: ChildProcess;
		const seccompFd =
			input.seccompFilterPath === undefined || input.seccompFilterPath === null
				? null
				: openSync(input.seccompFilterPath, "r");
		try {
			child = spawn(input.command, [...input.args], {
				cwd: "/",
				detached: process.platform !== "win32",
				stdio:
					seccompFd === null
						? ["pipe", "pipe", "pipe"]
						: ["pipe", "pipe", "pipe", seccompFd],
				env: minimalHostEnvironment(),
				windowsHide: true,
				...(input.spawnUid === undefined ? {} : { uid: input.spawnUid }),
				...(input.spawnGid === undefined ? {} : { gid: input.spawnGid }),
			});
		} catch (spawnError) {
			if (seccompFd !== null) closeSync(seccompFd);
			resolve({
				status: null,
				signal: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				error: `could not start probe command: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`,
				hostIdentity: null,
				hostIdentityError: null,
			});
			return;
		}
		if (seccompFd !== null) closeSync(seccompFd);
		child.stdin?.on("error", () => undefined);
		const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
			if (finished) return;
			finished = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve({ status, signal, stdout, stderr, timedOut, error, hostIdentity, hostIdentityError });
		};
		const terminate = (signal: NodeJS.Signals): void => {
			killProcessTree(child.pid, child, signal);
		};
		const releaseProbe = (): void => {
			try {
				child.stdin?.end("go\n");
			} catch {
				// The probe may already have exited.
			}
		};
		const startHostIdentityRead = (): void => {
			if (identityStarted) return;
			identityStarted = true;
			if (child.pid === undefined) {
				hostIdentityError = "spawned probe has no host pid";
				identitySettled = true;
				releaseProbe();
				return;
			}
			void readHostProbeIdentity(child.pid, input.marker, input.nodePath)
				.then(
					(read) => {
						hostIdentity = read.identity;
						hostIdentityError = read.error;
					},
					(readError: unknown) => {
						hostIdentityError = readError instanceof Error ? readError.message : String(readError);
					},
				)
				.finally(() => {
					identitySettled = true;
					releaseProbe();
				});
		};
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
			if (stdout.length > MAX_PROBE_OUTPUT_BYTES) {
				error = "probe stdout exceeded the 1 MiB limit";
				terminate("SIGKILL");
				return;
			}
			if (!readySeen && stdout.includes(input.readyMarker)) {
				readySeen = true;
				startHostIdentityRead();
			}
			if (!resultSeen && stdout.includes(input.resultMarker)) {
				resultSeen = true;
				if (identitySettled) releaseProbe();
			}
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			if (stderr.length < MAX_PROBE_OUTPUT_BYTES) stderr += chunk.toString();
		});
		child.once("error", (spawnError: Error) => {
			error = `could not start probe command: ${spawnError.message}`;
			finish(null, null);
		});
		child.once("close", (status, signal) => {
			if (timedOut) {
				error = error ?? `probe timed out after ${input.timeoutMs}ms`;
			}
			finish(status, signal);
		});
		timer = setTimeout(() => {
			timedOut = true;
			error = error ?? `probe timed out after ${input.timeoutMs}ms`;
			terminate("SIGKILL");
		}, input.timeoutMs);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number | null): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function booleanOrFalse(value: unknown): boolean {
	return value === true;
}

export function parseSandboxProbeFacts(
	stdout: string,
	resultMarker: string,
): { facts: SandboxProbeFacts | null; error: string | null } {
	const line = stdout
		.split("\n")
		.filter((entry) => entry.startsWith(`${resultMarker} `))
		.at(-1);
	if (line === undefined) {
		return { facts: null, error: `probe did not report ${resultMarker} facts` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.slice(resultMarker.length + 1));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { facts: null, error: `probe facts were not valid JSON: ${message}` };
	}
	if (!isRecord(parsed)) return { facts: null, error: "probe facts were not an object" };
	const rawGroups = parsed.groups;
	let groups: number[] | null = null;
	if (Array.isArray(rawGroups)) {
		const filtered = rawGroups.filter(
			(value): value is number =>
				typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
		);
		if (filtered.length === rawGroups.length) groups = filtered;
	}
	if (groups === null) {
		return { facts: null, error: "probe facts did not contain a valid supplementary-group list" };
	}
	const uid = numberOr(parsed.uid, -1);
	const gid = numberOr(parsed.gid, -1);
	const pid = numberOr(parsed.pid, -1);
	const ppid = numberOr(parsed.ppid, -1);
	if (uid === null || uid < 0 || gid === null || gid < 0 || pid === null || pid < 0 || ppid === null || ppid < 0) {
		return { facts: null, error: "probe facts did not contain valid uid/gid/pid/ppid" };
	}
	return {
		facts: {
			marker: typeof parsed.marker === "string" ? parsed.marker : "",
			pid,
			ppid,
			uid,
			gid,
			groups,
			capEff: stringOrNull(parsed.capEff),
			pidNs: stringOrNull(parsed.pidNs),
			mntNs: stringOrNull(parsed.mntNs),
			userNs: stringOrNull(parsed.userNs),
			hostname: stringOrNull(parsed.hostname),
			rootMount: booleanOrFalse(parsed.rootMount),
			procMount: booleanOrFalse(parsed.procMount),
			procFsType: numberOr(parsed.procFsType, null),
			nestedUsernsBlocked:
				typeof parsed.nestedUsernsBlocked === "boolean" ? parsed.nestedUsernsBlocked : null,
			error: stringOrNull(parsed.error),
		},
		error: null,
	};
}

async function readHostNamespaceIdentities(): Promise<{
	readonly pid: string;
	readonly mnt: string;
	readonly user: string;
}> {
	const read = async (name: "pid" | "mnt" | "user"): Promise<string> => {
		const info = await stat(`/proc/self/ns/${name}`);
		return `${info.dev}:${info.ino}`;
	};
	return { pid: await read("pid"), mnt: await read("mnt"), user: await read("user") };
}

/**
 * Fail-closed host preflight for bubblewrap, user/mount/pid namespaces, the
 * distinct host Worker UID/GID, cleared supplementary groups, an empty
 * capability set, and protected hardlinks/symlinks. A zero exit status alone is
 * never sufficient; the Supervisor verifies the facts and the host identity.
 */
export async function inspectBubblewrapRuntime(
	options: BubblewrapRuntimePreflightOptions,
	bwrapCommand = "bwrap",
): Promise<BubblewrapPreflightReport> {
	const platform = platformCheck(process.platform);
	const checks: SandboxPreflightCheck[] = [platform];
	const errors: string[] = [];
	if (!platform.ok) {
		errors.push(platform.message);
		return baseReport({ platform: process.platform, checks, errors });
	}

	const supervisorUid = options.supervisorUid ?? effectiveUid();
	const supervisorGid = options.supervisorGid ?? effectiveGid();
	// A single-UID unprivileged user namespace maps every sandbox UID back to
	// the Supervisor's host UID. That is NOT a distinct Worker identity. The
	// Supervisor must be able to start bwrap as the Worker host UID/GID (root
	// with setpriv, or root spawn(uid/gid)); otherwise hardlink/ownership
	// isolation cannot be claimed.
	const supervisorCanSwitchUid = supervisorUid === 0;
	const workerUidDistinct =
		supervisorCanSwitchUid && options.workerUid !== supervisorUid && options.workerUid !== 0;
	const workerGidDistinct =
		supervisorCanSwitchUid && options.workerGid !== supervisorGid && options.workerGid !== 0;
	checks.push({
		name: "worker-uid",
		ok: workerUidDistinct,
		message: workerUidDistinct
			? `bubblewrap will run as Worker host UID ${options.workerUid} (Supervisor UID ${supervisorUid}).`
			: `Worker UID ${options.workerUid} is not a distinct host UID (Supervisor UID ${supervisorUid}).`,
		hint: supervisorCanSwitchUid
			? "Configure a non-root sandbox.workerUid distinct from the Supervisor and chown writable directories to it."
			: "Run the trusted Supervisor as root inside a constrained container so it can start bwrap under a dedicated non-root Worker UID, or provide an equivalent trusted uid-switch helper. A single-UID unprivileged userns is not distinct.",
	});
	checks.push({
		name: "worker-gid",
		ok: workerGidDistinct,
		message: workerGidDistinct
			? `bubblewrap will run as Worker host GID ${options.workerGid} (Supervisor GID ${supervisorGid}).`
			: `Worker GID ${options.workerGid} is not a distinct host GID (Supervisor GID ${supervisorGid}).`,
		hint: "Configure a non-root sandbox.workerGid distinct from the Supervisor GID.",
	});
	if (!workerUidDistinct) {
		errors.push(
			`Worker UID ${options.workerUid} must be a non-root host UID distinct from Supervisor UID ${supervisorUid}; start the Supervisor as root or provide a trusted uid-switch helper.`,
		);
	}
	if (!workerGidDistinct) {
		errors.push(
			`Worker GID ${options.workerGid} must be a non-root host GID distinct from Supervisor GID ${supervisorGid}.`,
		);
	}

	let credentialStrategy: "setpriv" | "spawn-uid" | "none" = "none";
	let credentialHelperPath: string | null = null;
	const credentialIdentityOk = workerUidDistinct && workerGidDistinct;
	if (credentialIdentityOk) {
		try {
			credentialHelperPath = await resolveBubblewrapExecutable(
				options.credentialHelperPath ?? "setpriv",
			);
			credentialStrategy = "setpriv";
			checks.push({
				name: "credential-helper",
				ok: true,
				message: `bwrap will be started through ${credentialHelperPath} with --clear-groups.`,
			});
		} catch (error) {
			if (options.credentialHelperPath !== undefined) {
				const message = error instanceof Error ? error.message : String(error);
				checks.push({ name: "credential-helper", ok: false, message });
				errors.push(message);
			} else {
				credentialStrategy = "spawn-uid";
				checks.push({
					name: "credential-helper",
					ok: true,
					message:
						"setpriv is unavailable; using spawn(uid,gid) and requiring the real probe to show cleared supplementary groups and the correct host identity.",
				});
			}
		}
	}

	const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	let bwrapPath: string | null = null;
	let bwrapVersion: string | null = null;
	let features: BubblewrapFeatures = EMPTY_BUBBLEWRAP_FEATURES;
	try {
		bwrapPath = await resolveBubblewrapExecutable(bwrapCommand);
		checks.push({ name: "bubblewrap", ok: true, message: `Found bubblewrap at ${bwrapPath}.` });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		checks.push({
			name: "bubblewrap",
			ok: false,
			message,
			hint: "Install bubblewrap (for example apt-get install bubblewrap) and set sandbox.bwrapPath to its absolute path.",
		});
		errors.push(message);
	}

	if (bwrapPath !== null) {
		const info = await lstat(bwrapPath);
		const setuid = (info.mode & 0o6000) !== 0;
		if (setuid) {
			checks.push({
				name: "bubblewrap-setuid",
				ok: false,
				message: "bubblewrap is setuid/setgid; the Supervisor must launch a non-setuid bwrap as the distinct Worker UID.",
				hint: "Remove the setuid bit and enable unprivileged user namespaces for the Supervisor container/user.",
			});
			errors.push("bubblewrap must not be setuid/setgid.");
		} else {
			checks.push({ name: "bubblewrap-setuid", ok: true, message: "bubblewrap is not setuid/setgid." });
		}

		const version = runCapture(bwrapPath, ["--version"], Math.min(timeoutMs, 5_000));
		if (version.status === 0) {
			bwrapVersion = version.stdout.trim().split("\n")[0] ?? null;
			checks.push({
				name: "bubblewrap-version",
				ok: true,
				message: bwrapVersion === null ? "bubblewrap version available." : bwrapVersion,
			});
		} else {
			const message = `bubblewrap --version failed: ${(version.stderr || version.error || "").trim()}`;
			checks.push({ name: "bubblewrap-version", ok: false, message });
			errors.push(message);
		}

		const help = runCapture(bwrapPath, ["--help"], Math.min(timeoutMs, 5_000));
		const helpText = `${help.stdout}\n${help.stderr}`;
		if (help.status !== 0 && helpText.length === 0) {
			const message = `bubblewrap --help failed: ${(help.error ?? "").trim()}`;
			checks.push({ name: "bubblewrap-options", ok: false, message });
			errors.push(message);
		} else {
			features = parseBubblewrapFeatureSet(helpText, setuid);
			if (!features.seccompFd) {
				const message =
					"bubblewrap --seccomp FD is unavailable; there is no way to block nested user namespaces inside the sandbox.";
				checks.push({
					name: "seccomp-fd",
					ok: false,
					message,
					hint: "Install bubblewrap with --seccomp support (0.12+). There is no unsafe fallback.",
				});
				errors.push(message);
			} else {
				checks.push({
					name: "seccomp-fd",
					ok: true,
					message: "bubblewrap can load the nested-userns seccomp filter from an FD.",
				});
			}
			if (features.disableUserns) {
				checks.push({
					name: "disable-userns",
					ok: true,
					message: "bubblewrap also advertises --disable-userns (not used: /proc/sys is read-only in containers).",
				});
			}
		}
	}

	const sysctls = await inspectProtectedSysctls(options.readSysctl);
	checks.push(...sysctls.checks);
	errors.push(...sysctls.errors);

	let nestedUsernsFilterPath: string | null = null;
	if (bwrapPath !== null && features.seccompFd) {
		try {
			nestedUsernsFilterPath = createNestedUsernsFilterFile();
			checks.push({
				name: "nested-userns-filter",
				ok: true,
				message: "Prepared the nested-userns seccomp filter for bwrap --seccomp FD.",
			});
		} catch (error) {
			const message = `could not prepare the nested-userns seccomp filter: ${error instanceof Error ? error.message : String(error)}`;
			checks.push({
				name: "nested-userns-filter",
				ok: false,
				message,
				hint: "The filter is generated at runtime; ensure the Supervisor can write to its private temporary directory.",
			});
			errors.push(message);
		}
	}

	const canProbe =
		bwrapPath !== null &&
		features.seccompFd &&
		nestedUsernsFilterPath !== null &&
		credentialIdentityOk &&
		credentialStrategy !== "none";
	let assessment: SandboxProbeAssessment | null = null;
	let probeExecuted = false;
	if (canProbe && bwrapPath !== null && nestedUsernsFilterPath !== null) {
		probeExecuted = true;
		const marker = `rsi-preflight-${randomUUID()}`;
		const probeArgv = buildBubblewrapProbeArgv({
			bwrapPath,
			workerUid: options.workerUid,
			workerGid: options.workerGid,
			nodePath: process.execPath,
			features,
			nestedUsernsFilterPath,
			probeCode: buildSandboxRuntimeProbeScript({
				workerUid: options.workerUid,
				workerGid: options.workerGid,
				marker,
			}),
		});
		let credential: ReturnType<typeof buildBubblewrapCredentialCommand>;
		try {
			credential = buildBubblewrapCredentialCommand({
				bwrapPath,
				bwrapArgs: probeArgv.slice(1),
				workerUid: options.workerUid,
				workerGid: options.workerGid,
				strategy: credentialStrategy === "spawn-uid" ? "spawn-uid" : "setpriv",
				credentialHelperPath,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			checks.push({ name: "namespace-probe", ok: false, message });
			errors.push(message);
			return baseReport({
				platform: process.platform,
				checks,
				errors,
				bwrapPath,
				bwrapVersion,
				features,
				credentialStrategy,
				credentialHelperPath,
				protectedHardlinksEnabled: sysctls.protectedHardlinksEnabled,
				protectedSymlinksEnabled: sysctls.protectedSymlinksEnabled,
				workerUidDistinct,
				workerGidDistinct,
				probeExecuted,
				nestedUsernsFilterPath,
			});
		}
		const probe = await runSandboxRuntimeProbe({
			command: credential.command,
			args: credential.args,
			...(credential.spawnUid === undefined ? {} : { spawnUid: credential.spawnUid }),
			...(credential.spawnGid === undefined ? {} : { spawnGid: credential.spawnGid }),
			timeoutMs,
			marker,
			readyMarker: SANDBOX_RUNTIME_PROBE_READY_MARKER,
			resultMarker: SANDBOX_RUNTIME_PROBE_RESULT_MARKER,
			nodePath: process.execPath,
			seccompFilterPath: nestedUsernsFilterPath,
		});
		if (probe.timedOut) {
			const message = `bubblewrap namespace/mount probe timed out after ${timeoutMs}ms; refusing to launch.`;
			checks.push({ name: "namespace-probe", ok: false, message });
			errors.push(message);
		} else if (probe.error !== null) {
			const message = `bubblewrap namespace/mount probe failed: ${probe.error}`;
			checks.push({ name: "namespace-probe", ok: false, message });
			errors.push(message);
		} else if (probe.status !== 0) {
			const detail = (probe.stderr || probe.stdout || "").trim();
			const message = `bubblewrap namespace/mount probe exited with ${String(probe.status)}${probe.signal === null ? "" : ` (${probe.signal})`}: ${detail}`;
			checks.push({
				name: "namespace-probe",
				ok: false,
				message,
				hint: userNamespaceHint(detail),
			});
			errors.push(message);
		} else {
			const parsed = parseSandboxProbeFacts(probe.stdout, SANDBOX_RUNTIME_PROBE_RESULT_MARKER);
			if (parsed.facts === null) {
				const message = `bubblewrap namespace/mount probe facts are unusable: ${parsed.error ?? "unknown parse error"}`;
				checks.push({ name: "namespace-probe", ok: false, message });
				errors.push(message);
			} else {
				let hostNamespaces: { pid: string; mnt: string; user: string } | null = null;
				let namespaceReadError: string | null = null;
				try {
					hostNamespaces = await readHostNamespaceIdentities();
				} catch (error) {
					namespaceReadError = error instanceof Error ? error.message : String(error);
				}
				if (hostNamespaces === null) {
					const message = `host namespace identities could not be read: ${namespaceReadError ?? "unknown error"}; refusing to launch.`;
					checks.push({ name: "namespace-probe", ok: false, message });
					errors.push(message);
				} else {
					assessment = assessSandboxProbeFacts(
						parsed.facts,
						probe.hostIdentity,
						{
							workerUid: options.workerUid,
							workerGid: options.workerGid,
							supervisorUid,
							supervisorGid,
							marker,
							hostPidNamespace: hostNamespaces.pid,
							hostMountNamespace: hostNamespaces.mnt,
							hostUserNamespace: hostNamespaces.user,
						},
						probe.hostIdentityError,
					);
					checks.push(...assessment.checks);
					errors.push(...assessment.errors);
				}
			}
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		protectedHardlinksEnabled: sysctls.protectedHardlinksEnabled,
		protectedSymlinksEnabled: sysctls.protectedSymlinksEnabled,
		workerUidDistinct,
		workerGidDistinct,
		aliasRisks: [],
		platform: process.platform,
		bwrapPath,
		bwrapVersion,
		features,
		credentialStrategy,
		credentialHelperPath,
		checks,
		probeExecuted,
		nestedUsernsFilterPath,
		nestedUsernsBlocked: assessment?.nestedUsernsBlocked ?? false,
		namespaceVerified: assessment?.namespaceVerified ?? false,
		mountVerified: assessment?.mountVerified ?? false,
		capEffZero: assessment?.capEffZero ?? false,
		supplementaryGroupsCleared: assessment?.supplementaryGroupsCleared ?? false,
		hostIdentityVerified: assessment?.hostIdentityVerified ?? false,
		observedHostUid: assessment?.observedHostUid ?? null,
		observedHostGid: assessment?.observedHostGid ?? null,
		observedNamespaceUid: assessment?.observedNamespaceUid ?? null,
		observedNamespaceGid: assessment?.observedNamespaceGid ?? null,
		probeHostPid: assessment?.probeHostPid ?? null,
		probeNamespacePid: assessment?.probeNamespacePid ?? null,
	};
}

export interface SandboxPreflightConfig {
	readonly sandbox: {
		readonly bwrapPath: string;
		readonly workerUid?: number;
		readonly workerGid?: number;
	};
}

/**
 * The one configured-runtime preflight entrypoint. CLI --check, the deployment
 * wrapper, and tests all consume this exact report; none of them run an extra
 * hand-written probe from another host identity.
 */
export async function inspectConfiguredSandboxPreflight(
	config: SandboxPreflightConfig,
	options: Omit<BubblewrapRuntimePreflightOptions, "workerUid" | "workerGid"> = {},
): Promise<BubblewrapPreflightReport> {
	if (config.sandbox.workerUid === undefined || config.sandbox.workerGid === undefined) {
		const message = "sandbox.workerUid and sandbox.workerGid are required; there is no unsandboxed fallback.";
		return baseReport({
			platform: process.platform,
			checks: [{ name: "worker-identity", ok: false, message }],
			errors: [message],
		});
	}
	return await inspectBubblewrapRuntime(
		{ ...options, workerUid: config.sandbox.workerUid, workerGid: config.sandbox.workerGid },
		config.sandbox.bwrapPath,
	);
}

/** Throw an actionable SANDBOX_INVALID error rather than degrading to no sandbox. */
export function assertPreflightOk(report: BubblewrapPreflightReport): void {
	if (report.ok) return;
	throw new RsiError("SANDBOX_INVALID", `Sandbox preflight failed: ${report.errors.join(" | ")}`, {
		details: {
			errors: [...report.errors],
			checks: report.checks.map((check) => ({
				name: check.name,
				ok: check.ok,
				message: check.message,
				...(check.hint === undefined ? {} : { hint: check.hint }),
			})),
		},
	});
}

export function formatPreflightReport(report: BubblewrapPreflightReport): string {
	const lines = [
		`Sandbox preflight: ${report.ok ? "PASS" : "FAIL"} (${report.platform})`,
		`bubblewrap: ${report.bwrapPath ?? "not found"}${report.bwrapVersion === null ? "" : ` (${report.bwrapVersion})`}`,
		`protected_hardlinks=${report.protectedHardlinksEnabled} protected_symlinks=${report.protectedSymlinksEnabled === true} worker_uid_distinct=${report.workerUidDistinct} worker_gid_distinct=${report.workerGidDistinct === true}`,
		`probe_executed=${report.probeExecuted === true} namespace_verified=${report.namespaceVerified === true} mount_verified=${report.mountVerified === true} cap_eff_zero=${report.capEffZero === true} nested_userns_blocked=${report.nestedUsernsBlocked === true} supplementary_groups_cleared=${report.supplementaryGroupsCleared === true} host_identity_verified=${report.hostIdentityVerified === true}`,
		`host_uid=${report.observedHostUid ?? "unverified"} host_gid=${report.observedHostGid ?? "unverified"} namespace_uid=${report.observedNamespaceUid ?? "unverified"} namespace_gid=${report.observedNamespaceGid ?? "unverified"} probe_host_pid=${report.probeHostPid ?? "unverified"} probe_namespace_pid=${report.probeNamespacePid ?? "unverified"}`,
	];
	for (const check of report.checks) {
		lines.push(`- ${check.ok ? "ok" : "FAIL"} ${check.name}: ${check.message}`);
		if (!check.ok && check.hint !== undefined) lines.push(`  hint: ${check.hint}`);
	}
	for (const error of report.errors) lines.push(`error: ${error}`);
	return lines.join("\n");
}
