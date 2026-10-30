import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { RsiError } from "../shared/errors.ts";
import { isPathWithin } from "../shared/paths.ts";
import { assertSafeRelativePath } from "./atomic-file.ts";
import type { CandidateDiscoveryMode } from "./types.ts";

const EXTENSION_FILE_PATTERN = /\.(?:ts|js)$/;
const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

export function isExtensionFile(path: string): boolean {
	return EXTENSION_FILE_PATTERN.test(path);
}

export function isSupportedScript(path: string): boolean {
	return SUPPORTED_EXTENSIONS.includes(extname(path).toLowerCase() as (typeof SUPPORTED_EXTENSIONS)[number]);
}

async function assertRegularNonLink(path: string, label: string): Promise<void> {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		throw new RsiError("PATH_NOT_FILE", `${label} does not exist: ${path}`, { cause: error });
	}
	if (info.isSymbolicLink()) {
		throw new RsiError("PATH_SYMLINK_FORBIDDEN", `${label} must not be a symbolic link: ${path}`);
	}
	if (!info.isFile()) {
		throw new RsiError("PATH_NOT_FILE", `${label} must be a regular file: ${path}`);
	}
	if (info.nlink !== 1) {
		throw new RsiError("PATH_HARDLINK_FORBIDDEN", `${label} must have exactly one hard link: ${path}`);
	}
}

async function assertNoSymlinkComponents(root: string, path: string): Promise<void> {
	const rel = relative(root, path);
	if (rel.length === 0) return;
	if (rel === ".." || rel.startsWith("..") || isAbsolute(rel)) {
		throw new RsiError("PATH_OUTSIDE_ROOT", `Path escapes its source root: ${path}`);
	}
	let current = root;
	for (const segment of rel.split(/[\\/]/)) {
		current = join(current, segment);
		const info = await lstat(current);
		if (info.isSymbolicLink()) {
			throw new RsiError("PATH_SYMLINK_FORBIDDEN", `Symlink component is not allowed: ${current}`);
		}
	}
}

async function readPiExtensions(packageJsonPath: string): Promise<readonly string[] | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new RsiError("PREFLIGHT_FAILED", `Invalid package.json: ${packageJsonPath}`, { cause: error });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new RsiError("PREFLIGHT_FAILED", `package.json must contain an object: ${packageJsonPath}`);
	}
	const record = parsed as Record<string, unknown>;
	const pi = record.pi;
	if (pi === undefined) return null;
	if (typeof pi !== "object" || pi === null || Array.isArray(pi)) {
		throw new RsiError("PREFLIGHT_FAILED", `pi manifest must be an object: ${packageJsonPath}`);
	}
	const extensions = (pi as Record<string, unknown>).extensions;
	if (extensions === undefined) return null;
	if (!Array.isArray(extensions) || !extensions.every((entry) => typeof entry === "string")) {
		throw new RsiError("PREFLIGHT_FAILED", `pi.extensions must be an array of strings: ${packageJsonPath}`);
	}
	return extensions as readonly string[];
}

async function resolveIndex(dir: string): Promise<string | null> {
	for (const name of ["index.ts", "index.js"]) {
		const candidate = join(dir, name);
		try {
			const info = await lstat(candidate);
			if (info.isFile() && !info.isSymbolicLink()) return candidate;
			if (info.isSymbolicLink()) {
				throw new RsiError("PATH_SYMLINK_FORBIDDEN", `Extension index must not be a symbolic link: ${candidate}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return null;
}

async function resolvePackageEntries(root: string): Promise<string[] | null> {
	const manifestEntries = await readPiExtensions(join(root, "package.json"));
	if (manifestEntries !== null && manifestEntries.length > 0) {
		const entries: string[] = [];
		for (const entry of manifestEntries) {
			if (entry.length === 0 || isAbsolute(entry)) {
				throw new RsiError("PATH_OUTSIDE_ROOT", `pi.extensions entries must be relative paths: ${entry}`);
			}
			const absolute = resolve(root, entry);
			if (!isPathWithin(root, absolute) || resolve(root) === absolute) {
				throw new RsiError("PATH_OUTSIDE_ROOT", `pi.extensions entry escapes package root: ${entry}`);
			}
			await assertNoSymlinkComponents(root, absolute);
			await assertRegularNonLink(absolute, "Extension entry");
			const real = await realpath(absolute);
			if (!isPathWithin(await realpath(root), real)) {
				throw new RsiError("PATH_SYMLINK_FORBIDDEN", `Extension entry resolves outside its package: ${entry}`);
			}
			entries.push(absolute);
		}
		return entries;
	}
	const index = await resolveIndex(root);
	return index === null ? null : [index];
}

/** Discover extension entries without executing package code. */
export async function discoverExtensionEntries(
	root: string,
	mode: CandidateDiscoveryMode,
	explicitEntries: readonly string[] = [],
	options: { readonly allowEmpty?: boolean } = {},
): Promise<string[]> {
	const rootInfo = await lstat(root);
	if (rootInfo.isSymbolicLink()) {
		throw new RsiError("PATH_SYMLINK_FORBIDDEN", `Extension source root must not be a symlink: ${root}`);
	}
	if (!rootInfo.isDirectory()) {
		throw new RsiError("PATH_NOT_FILE", `Extension source root must be a directory: ${root}`);
	}
	const resolvedRoot = resolve(root);
	if (mode === "explicit") {
		if (explicitEntries.length === 0) {
			throw new RsiError("PREFLIGHT_FAILED", `No explicit extension entries supplied for ${root}.`);
		}
		const entries: string[] = [];
		for (const entry of explicitEntries) {
			const safe = assertSafeRelativePath(entry);
			const absolute = resolve(resolvedRoot, safe);
			if (!isPathWithin(resolvedRoot, absolute) || resolve(resolvedRoot) === absolute) {
				throw new RsiError("PATH_OUTSIDE_ROOT", `Explicit entry escapes source root: ${entry}`);
			}
			await assertNoSymlinkComponents(resolvedRoot, absolute);
			await assertRegularNonLink(absolute, "Explicit extension entry");
			if (!isExtensionFile(absolute)) {
				throw new RsiError("PREFLIGHT_FAILED", `Explicit extension entry must be .ts or .js: ${entry}`);
			}
			entries.push(absolute);
		}
		return entries;
	}
	if (mode === "extension") {
		const entries = await resolvePackageEntries(resolvedRoot);
		if (entries === null) {
			throw new RsiError("PREFLIGHT_FAILED", `No extension entry (pi.extensions or index.ts/js) in ${root}.`);
		}
		return entries;
	}

	const entries: string[] = [];
	const direct = await readdir(resolvedRoot, { withFileTypes: true });
	direct.sort((left, right) => left.name.localeCompare(right.name, "en"));
	for (const entry of direct) {
		const absolute = join(resolvedRoot, entry.name);
		if (entry.isSymbolicLink()) {
			throw new RsiError("PATH_SYMLINK_FORBIDDEN", `Extension discovery rejects symlinks: ${absolute}`);
		}
		if (entry.isFile()) {
			if (isExtensionFile(entry.name)) {
				await assertRegularNonLink(absolute, "Discovered extension file");
				entries.push(absolute);
			}
			continue;
		}
		if (entry.isDirectory()) {
			const nested = await resolvePackageEntries(absolute);
			if (nested !== null) {
				entries.push(...nested);
				continue;
			}
			const index = await resolveIndex(absolute);
			if (index !== null) entries.push(index);
		}
	}
	if (entries.length === 0 && options.allowEmpty !== true) {
		throw new RsiError("PREFLIGHT_FAILED", `No Pi extensions discovered in ${root}.`);
	}
	return entries;
}
