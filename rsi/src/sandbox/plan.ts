import { lstat, readFile, realpath } from "node:fs/promises";
import { posix } from "node:path";
import { RsiError } from "../shared/errors.ts";
import type { SandboxMount } from "../shared/sandbox.ts";
import { buildSandboxEnvironment } from "./environment.ts";
import {
	assertNoHiddenWritableOverlap,
	assertNoProtectedHiddenOverlap,
	assertNoProtectedWritableOverlap,
	assertTargetOutsideProtectedAndHidden,
	findMountAliasTargets,
	isPosixWithin,
	minimalRoots,
	normalizeSandboxPath,
	parseMountInfo,
	pathIsRoot,
	pathsOverlap,
} from "./path-safety.ts";
import {
	DEFAULT_KILL_WAIT_MS,
	DEFAULT_MAX_OUTPUT_BYTES,
	DEFAULT_PROBE_TIMEOUT_MS,
	DEFAULT_SENSITIVE_PATHS,
	DEFAULT_TERMINATION_GRACE_MS,
	EMPTY_BUBBLEWRAP_FEATURES,
	type BubblewrapLauncherOptions,
	type HiddenMount,
	type PlannedMount,
	type SandboxExecutionRequest,
	type SandboxPlan,
	type SandboxPlanContext,
} from "./types.ts";

export interface InspectedPath {
	readonly configured: string;
	readonly canonical: string;
	readonly kind: "file" | "directory";
	readonly uid: number;
	readonly gid: number;
	readonly mode: number;
	readonly nlink: number;
}

function effectiveUid(): number {
	return typeof process.geteuid === "function" ? process.geteuid() : 0;
}

function effectiveGid(): number {
	return typeof process.getegid === "function" ? process.getegid() : 0;
}

export function supervisorUid(options: Pick<BubblewrapLauncherOptions, "supervisorUid">): number {
	return options.supervisorUid ?? effectiveUid();
}

export function supervisorGid(options: Pick<BubblewrapLauncherOptions, "supervisorGid">): number {
	return options.supervisorGid ?? effectiveGid();
}

/** Validate numeric UID/GID input before it reaches bwrap. */
export function assertSandboxIdentity(options: {
	readonly workerUid: number;
	readonly workerGid: number;
	readonly supervisorUid: number;
}): void {
	for (const [label, value] of [
		["workerUid", options.workerUid],
		["workerGid", options.workerGid],
		["supervisorUid", options.supervisorUid],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0 || value > 4_294_967_294) {
			throw new RsiError("SANDBOX_INVALID", `${label} must be a non-negative 32-bit integer.`);
		}
	}
	if (options.workerUid === options.supervisorUid) {
		throw new RsiError(
			"SANDBOX_INVALID",
			"Worker UID must differ from the Supervisor UID; distinct UIDs are required for protected hardlink and state ownership checks.",
		);
	}
}

function pathKind(info: { isFile(): boolean; isDirectory(): boolean }, label: string): "file" | "directory" {
	if (info.isFile()) return "file";
	if (info.isDirectory()) return "directory";
	throw new RsiError("SANDBOX_INVALID", `${label} must be a regular file or directory.`);
}

/** Canonicalize a mount source. Final symlinks and non-file/non-directory sources fail closed. */
export async function inspectMountSource(source: string, label: string): Promise<InspectedPath> {
	const normalized = normalizeSandboxPath(source, label);
	let info;
	try {
		info = await lstat(normalized);
	} catch (error) {
		throw new RsiError("SANDBOX_INVALID", `${label} does not exist: ${normalized}`, { cause: error });
	}
	if (info.isSymbolicLink()) {
		throw new RsiError("SANDBOX_ALIAS_RISK", `${label} must not be a symlink: ${normalized}`);
	}
	const kind = pathKind(info, label);
	const canonical = await realpath(normalized);
	const canonicalInfo = await lstat(canonical);
	if (canonicalInfo.isSymbolicLink()) {
		throw new RsiError("SANDBOX_ALIAS_RISK", `${label} canonical path is a symlink: ${canonical}`);
	}
	const canonicalKind = pathKind(canonicalInfo, label);
	if (canonicalKind !== kind) {
		throw new RsiError("SANDBOX_ALIAS_RISK", `${label} changed type during canonicalization.`);
	}
	return {
		configured: normalized,
		canonical,
		kind,
		uid: canonicalInfo.uid,
		gid: canonicalInfo.gid,
		mode: canonicalInfo.mode & 0o7777,
		nlink: canonicalInfo.nlink,
	};
}

/** Executables may be symlinks (for example /bin/sh); resolve them to a canonical file. */
export async function inspectExecutablePath(source: string): Promise<InspectedPath> {
	const normalized = normalizeSandboxPath(source, "Worker executable");
	try {
		await lstat(normalized);
	} catch (error) {
		throw new RsiError("SANDBOX_INVALID", `Worker executable does not exist: ${normalized}`, { cause: error });
	}
	const canonical = await realpath(normalized);
	const canonicalInfo = await lstat(canonical);
	if (!canonicalInfo.isFile()) {
		throw new RsiError("SANDBOX_INVALID", `Worker executable must be a regular file: ${normalized}`);
	}
	return {
		configured: normalized,
		canonical,
		kind: "file",
		uid: canonicalInfo.uid,
		gid: canonicalInfo.gid,
		mode: canonicalInfo.mode & 0o7777,
		nlink: canonicalInfo.nlink,
	};
}

/**
 * Canonicalize an existing target or its nearest existing ancestor. This
 * follows parent symlinks that exist in the Supervisor mount namespace so a
 * mount cannot silently land on a different protected path.
 */
export async function canonicalizeMountTarget(target: string, label: string): Promise<string> {
	const normalized = normalizeSandboxPath(target, label);
	let current = normalized;
	const missing: string[] = [];
	for (;;) {
		let info;
		try {
			info = await lstat(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new RsiError("SANDBOX_INVALID", `${label} is not accessible: ${normalized}`, { cause: error });
			}
			if (pathIsRoot(current)) {
				throw new RsiError("SANDBOX_INVALID", `${label} has no existing ancestor: ${normalized}`);
			}
			missing.unshift(posix.basename(current));
			current = posix.dirname(current);
			continue;
		}
		if (info.isSymbolicLink()) {
			const canonical = await realpath(current);
			const canonicalInfo = await lstat(canonical);
			if (canonicalInfo.isSymbolicLink()) {
				throw new RsiError("SANDBOX_ALIAS_RISK", `${label} target is a symlink: ${normalized}`);
			}
			return missing.length === 0 ? canonical : posix.join(canonical, ...missing);
		}
		if (missing.length === 0) {
			const canonical = await realpath(current);
			return canonical;
		}
		const canonical = await realpath(current);
		return posix.join(canonical, ...missing);
	}
}

function assertProtectedRootOwnership(path: InspectedPath, workerUid: number, workerGid: number): void {
	if (path.kind === "file" && path.nlink !== 1) {
		throw new RsiError(
			"SANDBOX_ALIAS_RISK",
			`Protected file ${path.canonical} must have exactly one hardlink; found ${path.nlink}.`,
		);
	}
	if (path.uid === workerUid) {
		throw new RsiError(
			"SANDBOX_ALIAS_RISK",
			`Protected path ${path.canonical} is owned by the Worker UID; the Worker could change its mode or content.`,
		);
	}
	if ((path.mode & 0o002) !== 0) {
		throw new RsiError("SANDBOX_ALIAS_RISK", `Protected path ${path.canonical} is world-writable.`);
	}
	if (path.gid === workerGid && (path.mode & 0o020) !== 0) {
		throw new RsiError("SANDBOX_ALIAS_RISK", `Protected path ${path.canonical} is writable by the Worker GID.`);
	}
}

async function assertParentChainSafety(
	canonical: string,
	workerUid: number,
	workerGid: number,
	label: string,
): Promise<void> {
	let current = posix.dirname(canonical);
	while (!pathIsRoot(current)) {
		let info;
		try {
			info = await lstat(current);
		} catch (error) {
			throw new RsiError("SANDBOX_INVALID", `${label} parent is not accessible: ${current}`, {
				cause: error,
			});
		}
		if (!info.isDirectory()) {
			throw new RsiError("SANDBOX_ALIAS_RISK", `${label} parent is not a directory: ${current}`);
		}
		const mode = info.mode & 0o7777;
		const sticky = (mode & 0o1000) !== 0;
		if (info.uid === workerUid) {
			throw new RsiError(
				"SANDBOX_ALIAS_RISK",
				`${label} parent ${current} is Worker-owned; the Worker can change its mode and manipulate entries.`,
			);
		}
		if (!sticky && (mode & 0o002) !== 0) {
			throw new RsiError("SANDBOX_ALIAS_RISK", `${label} parent ${current} is world-writable and not sticky.`);
		}
		if (!sticky && info.gid === workerGid && (mode & 0o020) !== 0) {
			throw new RsiError(
				"SANDBOX_ALIAS_RISK",
				`${label} parent ${current} is writable by the Worker GID and not sticky.`,
			);
		}
		current = posix.dirname(current);
	}
}

function modeAllows(
	mode: number,
	ownerUid: number,
	ownerGid: number,
	workerUid: number,
	workerGid: number,
	bits: { readonly read: number; readonly execute: number },
): boolean {
	if (workerUid === 0) return true;
	if (ownerUid === workerUid) return (mode & bits.read) !== 0 && (mode & bits.execute) !== 0;
	if (ownerGid === workerGid) return (mode & (bits.read >> 3)) !== 0 && (mode & (bits.execute >> 3)) !== 0;
	return (mode & (bits.read >> 6)) !== 0 && (mode & (bits.execute >> 6)) !== 0;
}

function modePermission(
	mode: number,
	ownerUid: number,
	ownerGid: number,
	workerUid: number,
	workerGid: number,
	ownerBit: number,
	groupBit: number,
	otherBit: number,
): boolean {
	if (workerUid === 0) return true;
	if (ownerUid === workerUid) return (mode & ownerBit) !== 0;
	if (ownerGid === workerGid) return (mode & groupBit) !== 0;
	return (mode & otherBit) !== 0;
}

async function assertWorkerCanReadPath(
	path: InspectedPath,
	workerUid: number,
	workerGid: number,
	label: string,
): Promise<void> {
	const canRead = modePermission(path.mode, path.uid, path.gid, workerUid, workerGid, 0o400, 0o040, 0o004);
	const canExecute = modePermission(path.mode, path.uid, path.gid, workerUid, workerGid, 0o100, 0o010, 0o001);
	if (!canRead || (path.kind === "directory" && !canExecute)) {
		throw new RsiError(
			"SANDBOX_INVALID",
			`${label} is not readable by Worker UID ${workerUid}: ${path.canonical}`,
		);
	}
	let current = posix.dirname(path.canonical);
	while (true) {
		const info = await lstat(current);
		if (
			!modePermission(info.mode & 0o7777, info.uid, info.gid, workerUid, workerGid, 0o100, 0o010, 0o001)
		) {
			throw new RsiError(
				"SANDBOX_INVALID",
				`${label} parent is not traversable by Worker UID ${workerUid}: ${current}`,
			);
		}
		if (pathIsRoot(current)) break;
		current = posix.dirname(current);
	}
}

async function assertExecutableForWorker(executable: string, workerUid: number, workerGid: number): Promise<void> {
	const info = await lstat(executable);
	const mode = info.mode & 0o7777;
	if (!modeAllows(mode, info.uid, info.gid, workerUid, workerGid, { read: 0o400, execute: 0o100 })) {
		throw new RsiError(
			"SANDBOX_INVALID",
			`Worker executable is not readable/executable by the Worker UID: ${executable}`,
		);
	}
}

function asReason(mount: SandboxMount, index: number): PlannedMount["reason"] {
	if (mount.mode === "ro") {
		return mount.target.startsWith("/run/") ? "run" : "extra-read-only";
	}
	return index === 0 ? "workspace" : "plugin-edit";
}

function assertSystemTargetAllowed(target: string, label: string): void {
	for (const protectedPrefix of ["/proc", "/sys", "/dev"]) {
		if (isPosixWithin(protectedPrefix, target) || target === protectedPrefix) {
			throw new RsiError("SANDBOX_INVALID", `${label} must not mount over ${protectedPrefix}: ${target}`);
		}
	}
}

function uniqueSorted(paths: readonly string[]): string[] {
	return [...new Set(paths)].sort((left, right) => left.localeCompare(right, "en"));
}

function appendMount(
	mounts: PlannedMount[],
	source: string,
	target: string,
	mode: "ro" | "rw",
	reason: PlannedMount["reason"],
): void {
	if (mounts.some((entry) => entry.source === source && entry.target === target && entry.mode === mode)) return;
	mounts.push({ source, target, mode, reason });
}

/**
 * Build a complete, validated sandbox plan. This performs all path, alias,
 * mount-order, identity, and environment checks before bwrap is spawned.
 */
export async function createSandboxPlan(
	request: SandboxExecutionRequest,
	options: BubblewrapLauncherOptions,
	context: SandboxPlanContext = {},
): Promise<SandboxPlan> {
	const policy = request.policy;
	if (policy.kind !== "bubblewrap") {
		throw new RsiError("SANDBOX_INVALID", "Only the bubblewrap sandbox policy is supported.");
	}
	if (policy.network !== "unrestricted") {
		throw new RsiError("SANDBOX_INVALID", "Sandbox policy must preserve the container network namespace.");
	}
	if (policy.capabilities.length !== 0) {
		throw new RsiError("SANDBOX_INVALID", "Sandbox policy must not grant capabilities.");
	}
	if (!policy.noNewPrivileges || !policy.unsharePid || !policy.unshareIpc || !policy.unshareUts) {
		throw new RsiError("SANDBOX_INVALID", "Sandbox policy is missing required namespace/no-new-privileges flags.");
	}
	if (policy.procfs !== "isolated" || policy.rootFilesystem !== "container-root") {
		throw new RsiError("SANDBOX_INVALID", "Sandbox policy must use an isolated /proc and the container root filesystem.");
	}
	if (policy.ipc.transport !== "unix" || policy.ipc.stdoutIsProtocol) {
		throw new RsiError("SANDBOX_INVALID", "IPC must use a Unix socket; stdout/stderr are logs only.");
	}

	const uid = options.workerUid;
	const gid = options.workerGid;
	const supervisor = supervisorUid(options);
	assertSandboxIdentity({ workerUid: uid, workerGid: gid, supervisorUid: supervisor });
	if (uid === 0) {
		throw new RsiError(
			"SANDBOX_INVALID",
			"Worker UID 0 inside the sandbox is not permitted; use a dedicated non-root UID.",
		);
	}

	// --- Protected roots -----------------------------------------------------
	const protectedInputs = [
		...policy.protected.map((entry) => entry.source),
		...(options.additionalProtectedPaths ?? []),
		...(options.requiredProtectedPaths ?? []),
	];
	if (protectedInputs.length === 0) {
		throw new RsiError("SANDBOX_INVALID", "Sandbox policy has no protected paths.");
	}
	const protectedInspections: InspectedPath[] = [];
	const seenProtected = new Set<string>();
	for (const source of protectedInputs) {
		const inspected = await inspectMountSource(source, "Protected path");
		if (seenProtected.has(inspected.canonical)) continue;
		seenProtected.add(inspected.canonical);
		if (pathIsRoot(inspected.canonical)) {
			throw new RsiError("SANDBOX_ALIAS_RISK", "A protected path must not be the filesystem root.");
		}
		if (["/proc", "/sys", "/dev"].some((prefix) => isPosixWithin(prefix, inspected.canonical))) {
			throw new RsiError("SANDBOX_ALIAS_RISK", `Protected path is on a pseudo filesystem: ${inspected.canonical}`);
		}
		assertProtectedRootOwnership(inspected, uid, gid);
		await assertParentChainSafety(inspected.canonical, uid, gid, "Protected path");
		await assertWorkerCanReadPath(inspected, uid, gid, "Protected path");
		protectedInspections.push(inspected);
	}
	const protectedRoots = uniqueSorted(protectedInspections.map((entry) => entry.canonical));

	// --- Hidden control state ------------------------------------------------
	const hiddenInputs = minimalRoots(
		[...policy.hidden, ...(options.additionalHiddenPaths ?? [])].map((path) =>
			normalizeSandboxPath(path, "Hidden control path"),
		),
	);
	const hiddenInspections: InspectedPath[] = [];
	for (const source of hiddenInputs) {
		const inspected = await inspectMountSource(source, "Hidden control path");
		if (pathIsRoot(inspected.canonical)) {
			throw new RsiError("SANDBOX_ALIAS_RISK", "Hidden control state must not be the filesystem root.");
		}
		if (["/proc", "/sys", "/dev"].some((prefix) => isPosixWithin(prefix, inspected.canonical))) {
			throw new RsiError("SANDBOX_ALIAS_RISK", `Hidden state is on a pseudo filesystem: ${inspected.canonical}`);
		}
		assertProtectedRootOwnership(inspected, uid, gid);
		await assertParentChainSafety(inspected.canonical, uid, gid, "Hidden control path");
		hiddenInspections.push(inspected);
	}
	const hiddenRoots = minimalRoots(hiddenInspections.map((entry) => entry.canonical));

	// Mount aliases in the Supervisor namespace are also visible under the
	// recursive root bind; discover and protect/hide them explicitly.
	const mountInfoText =
		context.mountInfoText ??
		(process.platform === "linux" ? await readFile("/proc/self/mountinfo", "utf8") : "");
	const mountInfo = parseMountInfo(mountInfoText);
	const protectedAliasTargets = findMountAliasTargets(protectedRoots, mountInfo);
	const hiddenAliasTargets = findMountAliasTargets(hiddenRoots, mountInfo);
	const allProtectedPaths = uniqueSorted([...protectedRoots, ...protectedAliasTargets]);
	const allHiddenPaths = minimalRoots([...hiddenRoots, ...hiddenAliasTargets]);

	assertNoProtectedHiddenOverlap(allProtectedPaths, allHiddenPaths);

	for (const required of options.requiredProtectedPaths ?? []) {
		const canonical = await realpath(required).catch((error: unknown) => {
			throw new RsiError("SANDBOX_INVALID", `Required protected path does not exist: ${required}`, {
				cause: error,
			});
		});
		if (!allProtectedPaths.some((root) => isPosixWithin(root, canonical))) {
			throw new RsiError(
				"SANDBOX_ALIAS_RISK",
				`Required runtime path is not covered by a protected mount: ${required}`,
			);
		}
	}
	for (const required of options.requiredHiddenPaths ?? []) {
		const normalized = normalizeSandboxPath(required, "Required hidden path");
		let canonical = normalized;
		try {
			canonical = await realpath(normalized);
		} catch {
			// State files may be created later; their existing parent must still be hidden.
			try {
				canonical = await canonicalizeMountTarget(normalized, "Required hidden path");
			} catch {
				canonical = normalized;
			}
		}
		if (
			!allHiddenPaths.some(
				(root) =>
					root === normalized ||
					isPosixWithin(root, normalized) ||
					root === canonical ||
					isPosixWithin(root, canonical),
			)
		) {
			throw new RsiError("SANDBOX_ALIAS_RISK", `Required control path is not hidden: ${required}`);
		}
	}

	// --- Workspace / plugin / IPC mounts ------------------------------------
	const writableInputs: Array<{ mount: SandboxMount; index: number }> = [
		...policy.writable.map((mount, index) => ({ mount, index })),
		...(options.writableMounts ?? []).map((mount, index) => ({ mount, index: index + policy.writable.length })),
		...(request.writableMounts ?? []).map((mount, index) => ({ mount, index: index + policy.writable.length })),
	];
	const writableMounts: PlannedMount[] = [];
	for (const { mount, index } of writableInputs) {
		if (mount.mode !== "rw" && mount.mode !== "ro") {
			throw new RsiError("SANDBOX_INVALID", "Mount mode must be 'rw' or 'ro'.");
		}
		const source = await inspectMountSource(mount.source, "Writable mount source");
		await assertWorkerCanReadPath(source, uid, gid, "Writable mount source");
		const target = await canonicalizeMountTarget(mount.target, "Writable mount target");
		assertSystemTargetAllowed(target, "Writable mount target");
		if (mount.mode === "rw") {
			assertTargetOutsideProtectedAndHidden(target, allProtectedPaths, allHiddenPaths, "Writable mount");
		} else {
			for (const hidden of allHiddenPaths) {
				if (isPosixWithin(hidden, target)) {
					throw new RsiError(
						"SANDBOX_ALIAS_RISK",
						`Read-only mount target ${target} is inside hidden control state ${hidden}.`,
					);
				}
			}
		}
		appendMount(writableMounts, source.canonical, target, mount.mode, asReason(mount, index));
	}

	const readOnlyInputs: SandboxMount[] = [
		...(options.readOnlyMounts ?? []),
		...(request.readOnlyMounts ?? []),
	];
	const readOnlyMounts: PlannedMount[] = [];
	for (const mount of readOnlyInputs) {
		if (mount.mode !== "ro") {
			throw new RsiError("SANDBOX_INVALID", "Extra read-only mounts must use mode 'ro'.");
		}
		const source = await inspectMountSource(mount.source, "Read-only mount source");
		await assertWorkerCanReadPath(source, uid, gid, "Read-only mount source");
		const target = await canonicalizeMountTarget(mount.target, "Read-only mount target");
		assertSystemTargetAllowed(target, "Read-only mount target");
		assertTargetOutsideProtectedAndHidden(target, allProtectedPaths, allHiddenPaths, "Read-only mount");
		if (
			source.canonical !== target &&
			!allProtectedPaths.some((root) => isPosixWithin(root, source.canonical)) &&
			!allHiddenPaths.some((root) => isPosixWithin(root, source.canonical))
		) {
			throw new RsiError(
				"SANDBOX_ALIAS_RISK",
				`Read-only mount source ${source.canonical} is neither protected nor hidden; its writable backing path would remain accessible.`,
			);
		}
		appendMount(readOnlyMounts, source.canonical, target, "ro", "plugin-candidate");
	}

	// Protected mounts come last among binds so they win over any broad or
	// duplicate writable mount. Bind every canonical root and every alias.
	for (const root of protectedRoots) {
		appendMount(readOnlyMounts, root, root, "ro", "protected");
	}
	for (const root of protectedRoots) {
		for (const target of findMountAliasTargets([root], mountInfo)) {
			if (target === root || protectedRoots.includes(target)) continue;
			appendMount(readOnlyMounts, root, target, "ro", "protected-alias");
		}
	}
	// Preserve the policy's configured target aliases as well.
	for (const entry of policy.protected) {
		const inspectedSource = await inspectMountSource(entry.source, "Protected policy source");
		const inspectedTarget = await canonicalizeMountTarget(entry.target, "Protected policy target");
		if (inspectedTarget !== inspectedSource.canonical) {
			if (!allProtectedPaths.some((root) => isPosixWithin(root, inspectedTarget))) {
				throw new RsiError(
					"SANDBOX_ALIAS_RISK",
					`Protected policy target ${inspectedTarget} is not an alias of a canonical protected root.`,
				);
			}
			appendMount(readOnlyMounts, inspectedSource.canonical, inspectedTarget, "ro", "protected-alias");
		}
	}

	// --- Hidden state, sensitive sockets -----------------------------------
	const hidden: HiddenMount[] = hiddenRoots.map((root) => {
		const inspection = hiddenInspections.find((entry) => entry.canonical === root);
		return { target: root, kind: inspection?.kind ?? "directory" } satisfies HiddenMount;
	});
	for (const target of hiddenAliasTargets) {
		if (hidden.some((entry) => entry.target === target)) continue;
		if (allHiddenPaths.includes(target)) {
			let info;
			try {
				info = await lstat(target);
			} catch {
				continue;
			}
			if (info.isDirectory()) hidden.push({ target, kind: "directory" });
			else if (info.isFile() || info.isSocket() || info.isSymbolicLink()) hidden.push({ target, kind: "file" });
		}
	}
	const fileMasks: string[] = [];
	for (const sensitive of [...DEFAULT_SENSITIVE_PATHS, ...(options.sensitivePaths ?? [])]) {
		const target = normalizeSandboxPath(sensitive, "Sensitive path");
		if (hidden.some((entry) => isPosixWithin(entry.target, target) || entry.target === target)) continue;
		let info;
		try {
			info = await lstat(target);
		} catch {
			continue;
		}
		if (info.isDirectory()) {
			hidden.push({ target, kind: "directory" });
		} else {
			fileMasks.push(target);
		}
	}

	// Writable sources/targets must not re-expose protected or hidden trees.
	assertNoProtectedWritableOverlap(
		allProtectedPaths,
		writableMounts.filter((mount) => mount.mode === "rw").map((mount) => mount.source),
		writableMounts.filter((mount) => mount.mode === "rw").map((mount) => mount.target),
	);
	assertNoHiddenWritableOverlap(
		allHiddenPaths,
		writableMounts.filter((mount) => mount.mode === "rw").map((mount) => mount.source),
		writableMounts.filter((mount) => mount.mode === "rw").map((mount) => mount.target),
	);

	// --- Environment, command, cwd ------------------------------------------
	const home = await inspectMountSource(options.workerHomeDir, "Worker home");
	if (home.kind !== "directory") {
		throw new RsiError("SANDBOX_INVALID", "Worker home must be a directory.");
	}
	if (allProtectedPaths.some((root) => isPosixWithin(root, home.canonical))) {
		throw new RsiError("SANDBOX_ALIAS_RISK", "Worker home must not be inside a protected root.");
	}
	if (allHiddenPaths.some((root) => isPosixWithin(root, home.canonical))) {
		throw new RsiError("SANDBOX_ALIAS_RISK", "Worker home must not be inside hidden control state.");
	}
	const tmpDir = normalizeSandboxPath(options.tmpDir ?? "/tmp", "tmpDir");
	if (allProtectedPaths.some((root) => isPosixWithin(root, tmpDir))) {
		throw new RsiError("SANDBOX_INVALID", "TMPDIR must not be inside a protected root.");
	}
	if (allHiddenPaths.some((root) => isPosixWithin(root, tmpDir))) {
		throw new RsiError("SANDBOX_INVALID", "TMPDIR must not be inside hidden control state.");
	}

	const env = buildSandboxEnvironment({
		inherited: process.env,
		explicit: { ...(options.environment ?? {}), ...(request.env ?? {}) },
		home: home.canonical,
		tmpDir,
		workerUid: uid,
		...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
	});
	const envHome = normalizeSandboxPath(env.HOME ?? home.canonical, "HOME");
	const envTmp = normalizeSandboxPath(env.TMPDIR ?? tmpDir, "TMPDIR");
	if (allProtectedPaths.some((root) => pathsOverlap(root, envHome))) {
		throw new RsiError("SANDBOX_INVALID", "HOME must not overlap a protected root.");
	}
	if (allHiddenPaths.some((root) => pathsOverlap(root, envHome))) {
		throw new RsiError("SANDBOX_INVALID", "HOME must not overlap hidden control state.");
	}
	if (allProtectedPaths.some((root) => pathsOverlap(root, envTmp))) {
		throw new RsiError("SANDBOX_INVALID", "TMPDIR must not overlap a protected root.");
	}
	if (allHiddenPaths.some((root) => pathsOverlap(root, envTmp))) {
		throw new RsiError("SANDBOX_INVALID", "TMPDIR must not overlap hidden control state.");
	}

	const executableInput = request.executable ?? request.workerEntry;
	if (typeof executableInput !== "string" || !posix.isAbsolute(executableInput)) {
		throw new RsiError("SANDBOX_INVALID", "Worker executable must be an absolute path.");
	}
	const executableInfo = await inspectExecutablePath(executableInput);
	if (allHiddenPaths.some((root) => isPosixWithin(root, executableInfo.canonical))) {
		throw new RsiError("SANDBOX_INVALID", "Worker executable must not be inside hidden control state.");
	}
	await assertExecutableForWorker(executableInfo.canonical, uid, gid);
	const args = [...(request.args ?? [])];
	for (const arg of args) {
		if (typeof arg !== "string" || arg.includes("\u0000")) {
			throw new RsiError("SANDBOX_INVALID", "Worker arguments must be strings without NUL.");
		}
	}
	const argvBytes = Buffer.byteLength([executableInfo.canonical, ...args].join("\u0000"), "utf8");
	if (argvBytes > 128 * 1024) {
		throw new RsiError("SANDBOX_INVALID", "Worker argv exceeds the 128 KiB limit.");
	}

	const cwd = await inspectMountSource(request.cwd, "Worker cwd");
	if (cwd.kind !== "directory") {
		throw new RsiError("SANDBOX_INVALID", "Worker cwd must be a directory.");
	}
	if (allProtectedPaths.some((root) => isPosixWithin(root, cwd.canonical))) {
		throw new RsiError("SANDBOX_ALIAS_RISK", "Worker cwd must not be inside a protected root.");
	}
	if (allHiddenPaths.some((root) => isPosixWithin(root, cwd.canonical))) {
		throw new RsiError("SANDBOX_ALIAS_RISK", "Worker cwd must not be inside hidden control state.");
	}
	if (!modeAllows(cwd.mode, cwd.uid, cwd.gid, uid, gid, { read: 0o400, execute: 0o100 })) {
		throw new RsiError("SANDBOX_INVALID", `Worker cannot enter cwd: ${cwd.canonical}`);
	}

	const hostSocketPath = await canonicalizeMountTarget(policy.ipc.hostSocketPath, "Host IPC socket");
	const workerSocketPath = normalizeSandboxPath(policy.ipc.workerSocketPath, "Worker IPC socket");
	let socketMounted = false;
	for (const mount of writableMounts) {
		if (!isPosixWithin(mount.source, hostSocketPath)) continue;
		const relativeSocket = posix.relative(mount.source, hostSocketPath);
		const mountedSocket = posix.join(mount.target, relativeSocket);
		if (mountedSocket === workerSocketPath) socketMounted = true;
	}
	if (!socketMounted) {
		throw new RsiError(
			"SANDBOX_INVALID",
			"The IPC socket must be visible at its configured Worker path through a Unix-socket directory mount.",
		);
	}

	if (options.terminationGraceMs !== undefined && options.terminationGraceMs < 0) {
		throw new RsiError("SANDBOX_INVALID", "terminationGraceMs must not be negative.");
	}
	if (options.killWaitMs !== undefined && options.killWaitMs < 0) {
		throw new RsiError("SANDBOX_INVALID", "killWaitMs must not be negative.");
	}

	const hostname = options.hostname ?? "rsi-worker";
	if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(hostname)) {
		throw new RsiError("SANDBOX_INVALID", "Sandbox hostname is invalid.");
	}

	return {
		bwrapPath: context.bwrapPath ?? policy.bwrapPath,
		workerUid: uid,
		workerGid: gid,
		executable: executableInfo.canonical,
		args,
		cwd: cwd.canonical,
		env,
		hostname,
		writableMounts,
		readOnlyMounts,
		fileMasks: uniqueSorted(fileMasks),
		hidden,
		protectedRoots: allProtectedPaths,
		hiddenRoots: allHiddenPaths,
		features: context.features ?? EMPTY_BUBBLEWRAP_FEATURES,
		nestedUsernsFilterPath: context.nestedUsernsFilterPath ?? null,
		purpose: request.purpose ?? "worker",
	};
}

export function defaultExecutionLimits(options: BubblewrapLauncherOptions): {
	readonly maxStdoutBytes: number;
	readonly maxStderrBytes: number;
	readonly timeoutMs: number;
	readonly terminationGraceMs: number;
	readonly killWaitMs: number;
	readonly probeTimeoutMs: number;
} {
	return {
		maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
		maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
		timeoutMs: options.timeoutMs ?? 0,
		terminationGraceMs: options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
		killWaitMs: options.killWaitMs ?? DEFAULT_KILL_WAIT_MS,
		probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
	};
}
