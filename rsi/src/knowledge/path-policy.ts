import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RsiError } from "../shared/errors.ts";
import { inspectManagedMarkdownPath } from "../shared/managed-path.ts";
import { isPathWithin } from "../shared/paths.ts";
import { captureDirectoryIdentity, type DirectoryIdentity } from "./atomic-fs.ts";

export interface ManagedToolPath {
	readonly managed: true;
	readonly name: string;
	readonly absolutePath: string;
	readonly configuredPath: string;
}

export interface UnmanagedToolPath {
	readonly managed: false;
	readonly absolutePath: string;
	readonly reason: "outside-markdowns";
}

export type ManagedToolPathDecision = ManagedToolPath | UnmanagedToolPath;

async function nearestCanonicalPath(path: string): Promise<string> {
	let current = resolve(path);
	const missing: string[] = [];
	for (;;) {
		try {
			const info = await lstat(current);
			const canonical = info.isSymbolicLink() ? await realpath(current) : current;
			const real = await realpath(canonical).catch(() => canonical);
			return resolve(real, ...missing);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				throw new RsiError("PATH_INVALID", "Could not canonicalize a tool path.", { cause: error });
			}
			const parent = dirname(current);
			if (parent === current) {
				throw new RsiError("PATH_INVALID", "Could not find an existing ancestor for a tool path.");
			}
			missing.unshift(basename(current));
			current = parent;
		}
	}
}

function requireAbsoluteToolPath(inputPath: string, cwd: string): string {
	if (typeof inputPath !== "string" || inputPath.length === 0 || inputPath.includes("\u0000")) {
		throw new RsiError("PATH_INVALID", "Tool path must be a non-empty path without NUL.");
	}
	if (!isAbsolute(cwd)) {
		throw new RsiError("PATH_INVALID", "Tool working directory must be absolute.");
	}
	return resolve(cwd, inputPath);
}

function assertFlatManagedRelative(relativePath: string): string {
	if (
		relativePath.length === 0 ||
		relativePath === "." ||
		relativePath.includes("/") ||
		relativePath.includes("\\") ||
		relativePath.includes(sep) ||
		relativePath.startsWith("..") ||
		isAbsolute(relativePath)
	) {
		throw new RsiError(
			"DOCUMENT_NAME_INVALID",
			"Managed Markdown must be a direct, flat .md filename under markdowns/.",
		);
	}
	return relativePath;
}

/** Classify a path for native read/write/edit routing. */
export async function classifyManagedToolPathAgainstRoot(
	root: DirectoryIdentity,
	inputPath: string,
	cwd: string,
): Promise<ManagedToolPathDecision> {
	const absolutePath = requireAbsoluteToolPath(inputPath, cwd);
	const lexicalInside =
		isPathWithin(root.configuredPath, absolutePath) || isPathWithin(root.realPath, absolutePath);
	const canonicalPath = await nearestCanonicalPath(absolutePath);
	const canonicalInside = isPathWithin(root.realPath, canonicalPath);

	if (lexicalInside && !canonicalInside) {
		throw new RsiError(
			"PATH_SYMLINK_FORBIDDEN",
			"A path inside markdowns resolves outside it; refusing the alias.",
		);
	}
	if (!lexicalInside && canonicalInside) {
		throw new RsiError(
			"PATH_SYMLINK_FORBIDDEN",
			"A path outside markdowns resolves to a managed Markdown file; refusing the alias.",
		);
	}
	if (!lexicalInside && !canonicalInside) {
		return { managed: false, absolutePath, reason: "outside-markdowns" };
	}

	const relativePath = assertFlatManagedRelative(relative(root.realPath, canonicalPath));
	const inspection = await inspectManagedMarkdownPath(root.realPath, relativePath, { allowMissing: true });
	return {
		managed: true,
		name: inspection.relativeName,
		absolutePath: inspection.absolutePath,
		configuredPath: root.configuredPath,
	};
}

/**
 * Classify a path using either a captured canonical root or a markdowns
 * directory. A string root is canonicalized and identity-checked first.
 */
export async function classifyManagedToolPath(
	root: DirectoryIdentity | string,
	inputPath: string,
	cwd: string,
): Promise<ManagedToolPathDecision> {
	const identity =
		typeof root === "string" ? await captureDirectoryIdentity(root, "markdownsDir") : root;
	return classifyManagedToolPathAgainstRoot(identity, inputPath, cwd);
}

/** Convenience classifier for Worker adapters that only know markdownsDir. */
export async function inspectManagedToolPath(
	markdownsDir: string,
	inputPath: string,
	cwd: string,
): Promise<ManagedToolPathDecision> {
	const root = await captureDirectoryIdentity(markdownsDir, "markdownsDir");
	return classifyManagedToolPathAgainstRoot(root, inputPath, cwd);
}

/** Used by write.mkdir; only the markdowns root itself may be "created". */
export async function assertManagedDirectoryRoot(root: DirectoryIdentity, directory: string): Promise<void> {
	const absolutePath = resolve(directory);
	const canonicalPath = await nearestCanonicalPath(absolutePath);
	if (canonicalPath !== root.realPath) {
		throw new RsiError(
			"DOCUMENT_NAME_INVALID",
			"Managed documents are flat; parent-directory creation is limited to the existing markdowns root.",
		);
	}
}

export function managedNameFromAbsolutePath(path: string): string {
	return basename(path);
}

export function joinManagedPath(root: DirectoryIdentity, name: string): string {
	return join(root.realPath, name);
}
