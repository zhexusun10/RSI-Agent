import { posix } from "node:path";
import { RsiError } from "../shared/errors.ts";

/** Sandbox-internal paths are always POSIX paths, even when unit-tested on Windows. */
export function normalizeSandboxPath(value: string, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
		throw new RsiError("SANDBOX_INVALID", `${label} must be a non-empty path without NUL.`);
	}
	if (!posix.isAbsolute(value)) {
		throw new RsiError("SANDBOX_INVALID", `${label} must be an absolute POSIX path: ${value}`);
	}
	const normalized = posix.normalize(value);
	if (normalized !== value && normalized !== `${value}/`) {
		// Do not silently rewrite security-relevant paths such as /a/../b.
		if (value.split("/").includes("..")) {
			throw new RsiError("SANDBOX_INVALID", `${label} must not contain '..': ${value}`);
		}
	}
	if (normalized === "/" && label !== "root filesystem") {
		return normalized;
	}
	return normalized;
}

export function isPosixWithin(parent: string, candidate: string): boolean {
	const parentResolved = posix.resolve(parent);
	const candidateResolved = posix.resolve(candidate);
	const relative = posix.relative(parentResolved, candidateResolved);
	return relative === "" || (relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative));
}

export function pathsOverlap(left: string, right: string): boolean {
	return isPosixWithin(left, right) || isPosixWithin(right, left);
}

export function pathIsRoot(value: string): boolean {
	return posix.normalize(value) === "/";
}

export interface MountInfoEntry {
	readonly mountId: number;
	readonly parentId: number;
	readonly majorMinor: string;
	readonly root: string;
	readonly mountPoint: string;
	readonly options: readonly string[];
	readonly fsType: string;
	readonly source: string;
	readonly superOptions: readonly string[];
}

const PSEUDO_FILESYSTEMS = new Set([
	"autofs",
	"binfmt_misc",
	"bpf",
	"cgroup",
	"cgroup2",
	"configfs",
	"debugfs",
	"devpts",
	"devtmpfs",
	"efivarfs",
	"fusectl",
	"hugetlbfs",
	"mqueue",
	"nsfs",
	"proc",
	"pstore",
	"rpc_pipefs",
	"securityfs",
	"selinuxfs",
	"sysfs",
	"tracefs",
]);

/** Decode the octal escapes defined by proc(5) mountinfo. */
export function decodeMountInfoField(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
		String.fromCharCode(Number.parseInt(octal, 8)),
	);
}

/** Parse Linux /proc/self/mountinfo. Malformed records are ignored defensively. */
export function parseMountInfo(text: string): MountInfoEntry[] {
	const entries: MountInfoEntry[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		const separator = line.indexOf(" - ");
		if (separator === -1) continue;
		const left = line.slice(0, separator).split(" ");
		const right = line.slice(separator + 3).split(" ");
		if (left.length < 6 || right.length < 3) continue;
		const mountId = Number(left[0]);
		const parentId = Number(left[1]);
		if (!Number.isFinite(mountId) || !Number.isFinite(parentId)) continue;
		entries.push({
			mountId,
			parentId,
			majorMinor: left[2] ?? "",
			root: decodeMountInfoField(left[3] ?? "/"),
			mountPoint: decodeMountInfoField(left[4] ?? "/"),
			options: (left[5] ?? "").split(",").filter(Boolean),
			fsType: right[0] ?? "",
			source: decodeMountInfoField(right[1] ?? ""),
			superOptions: (right[2] ?? "").split(",").filter(Boolean),
		});
	}
	return entries;
}

function isRealFilesystem(entry: MountInfoEntry): boolean {
	if (PSEUDO_FILESYSTEMS.has(entry.fsType)) return false;
	return !entry.fsType.startsWith("cgroup");
}

/**
 * Find every visible path that refers to the same mounted tree as a protected
 * or hidden root. A container may bind-mount a protected directory at another
 * path; protecting only the canonical name would leave the alias writable.
 */
export function findMountAliasTargets(
	roots: readonly string[],
	mounts: readonly MountInfoEntry[],
): string[] {
	const aliases = new Set<string>();
	const rootDevices = new Set(
		mounts
			.filter((mount) => posix.normalize(mount.mountPoint) === "/" && posix.normalize(mount.root) === "/")
			.map((mount) => mount.majorMinor),
	);
	for (const rootInput of roots) {
		const root = posix.normalize(rootInput);
		for (const mount of mounts) {
			if (!isRealFilesystem(mount)) continue;
			const mountRoot = posix.normalize(mount.root);
			const mountPoint = posix.normalize(mount.mountPoint);
			if (!posix.isAbsolute(mountRoot) || !posix.isAbsolute(mountPoint)) continue;
			if (mountPoint === root) continue;
			// A nested mount below a protected directory must also be made
			// read-only; a parent ro-bind does not guarantee nested mounts are ro.
			if (isPosixWithin(root, mountPoint)) {
				aliases.add(mountPoint);
				continue;
			}
			// The protected path is at or below this mountpoint, so the canonical
			// protected bind already covers this visible path.
			if (isPosixWithin(mountPoint, root)) continue;
			if (mountRoot === "/") {
				// root="/" on a non-root mountpoint is only a mapping of the
				// namespace root when it is a bind of the same root superblock.
				// A tmpfs/procfs mounted at /tmp must not invent /tmp/tmp/... aliases.
				if (mountPoint === "/" || !rootDevices.has(mount.majorMinor)) continue;
				aliases.add(posix.join(mountPoint, posix.relative("/", root)));
			} else if (isPosixWithin(mountRoot, root)) {
				aliases.add(posix.join(mountPoint, posix.relative(mountRoot, root)));
			} else if (isPosixWithin(root, mountRoot)) {
				aliases.add(mountPoint);
			}
		}
	}
	return [...aliases].sort((left, right) => left.localeCompare(right, "en"));
}

export function assertNoProtectedWritableOverlap(
	protectedPaths: readonly string[],
	writableSources: readonly string[],
	writableTargets: readonly string[],
): void {
	for (const protectedPath of protectedPaths) {
		for (const source of writableSources) {
			if (pathsOverlap(protectedPath, source)) {
				throw new RsiError(
					"SANDBOX_ALIAS_RISK",
					`Writable mount source ${source} overlaps protected path ${protectedPath}.`,
				);
			}
		}
		for (const target of writableTargets) {
			if (pathsOverlap(protectedPath, target)) {
				throw new RsiError(
					"SANDBOX_ALIAS_RISK",
					`Writable mount target ${target} overlaps protected path ${protectedPath}.`,
				);
			}
		}
	}
}

export function assertNoHiddenWritableOverlap(
	hiddenPaths: readonly string[],
	writableSources: readonly string[],
	writableTargets: readonly string[],
): void {
	for (const hiddenPath of hiddenPaths) {
		for (const source of writableSources) {
			if (pathsOverlap(hiddenPath, source)) {
				throw new RsiError(
					"SANDBOX_ALIAS_RISK",
					`Writable mount source ${source} overlaps hidden control state ${hiddenPath}.`,
				);
			}
		}
		for (const target of writableTargets) {
			if (pathsOverlap(hiddenPath, target)) {
				throw new RsiError(
					"SANDBOX_ALIAS_RISK",
					`Writable mount target ${target} overlaps hidden control state ${hiddenPath}.`,
				);
			}
		}
	}
}

export function assertNoProtectedHiddenOverlap(
	protectedPaths: readonly string[],
	hiddenPaths: readonly string[],
): void {
	for (const protectedPath of protectedPaths) {
		for (const hiddenPath of hiddenPaths) {
			if (pathsOverlap(protectedPath, hiddenPath)) {
				throw new RsiError(
					"SANDBOX_ALIAS_RISK",
					`Protected path ${protectedPath} overlaps hidden control state ${hiddenPath}.`,
				);
			}
		}
	}
}

export function assertTargetOutsideProtectedAndHidden(
	target: string,
	protectedPaths: readonly string[],
	hiddenPaths: readonly string[],
	label: string,
): void {
	for (const protectedPath of protectedPaths) {
		if (isPosixWithin(protectedPath, target) || isPosixWithin(target, protectedPath)) {
			throw new RsiError(
				"SANDBOX_ALIAS_RISK",
				`${label} target ${target} overlaps protected path ${protectedPath}.`,
			);
		}
	}
	for (const hiddenPath of hiddenPaths) {
		if (isPosixWithin(hiddenPath, target) || isPosixWithin(target, hiddenPath)) {
			throw new RsiError(
				"SANDBOX_ALIAS_RISK",
				`${label} target ${target} overlaps hidden control state ${hiddenPath}.`,
			);
		}
	}
}

/** Return the closest ancestor that is not itself hidden by a broader hidden root. */
export function minimalRoots(paths: readonly string[]): string[] {
	const normalized = [...new Set(paths.map((path) => posix.normalize(path)))].sort(
		(left, right) => left.length - right.length || left.localeCompare(right, "en"),
	);
	const result: string[] = [];
	for (const candidate of normalized) {
		if (result.some((parent) => isPosixWithin(parent, candidate))) continue;
		result.push(candidate);
	}
	return result;
}
