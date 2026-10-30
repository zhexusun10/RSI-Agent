import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { RsiError } from "./errors.ts";

export const MANAGED_DOCUMENT_NAME_PATTERN =
	/^(?!\.)(?!.*[|\\/\u0000-\u001f\u007f])[\p{L}\p{N}][\p{L}\p{N}._-]*\.md$/u;

export function assertManagedDocumentName(name: string): string {
	if (
		typeof name !== "string" ||
		name.length === 0 ||
		name.length > 200 ||
		name.endsWith(".") ||
		!MANAGED_DOCUMENT_NAME_PATTERN.test(name)
	) {
		throw new RsiError(
			"DOCUMENT_NAME_INVALID",
			"Managed Markdown names must be a direct .md filename using Unicode letters/numbers, dot, underscore, or hyphen.",
		);
	}
	return name;
}

export interface ManagedPathInspection {
	readonly root: string;
	readonly rootRealPath: string;
	readonly relativeName: string;
	readonly absolutePath: string;
	readonly exists: boolean;
	readonly isFile: boolean;
	readonly nlink: number;
	readonly realPath?: string;
}

async function requireCanonicalDirectory(path: string, label: string): Promise<string> {
	const info = await lstat(path).catch((error: unknown) => {
		throw new RsiError("PATH_INVALID", `${label} does not exist or is not accessible.`, { cause: error });
	});
	if (info.isSymbolicLink()) {
		throw new RsiError("PATH_SYMLINK_FORBIDDEN", `${label} must not be a symlink.`);
	}
	if (!info.isDirectory()) {
		throw new RsiError("PATH_INVALID", `${label} must be a directory.`);
	}
	return realpath(path);
}

/**
 * Validate one direct child Markdown path.
 *
 * The managed namespace is intentionally flat: nested Markdown directories
 * would create an alternate namespace that a flat index cannot enumerate.
 * Existing symlinks and hardlinks are rejected so a writable alias cannot
 * bypass the read-only mount or broker transaction.
 */
export async function inspectManagedMarkdownPath(
	markdownsDir: string,
	relativeName: string,
	options: { allowMissing?: boolean } = {},
): Promise<ManagedPathInspection> {
	const root = resolve(markdownsDir);
	const name = assertManagedDocumentName(relativeName);
	if (isAbsolute(name) || name !== relativeName) {
		throw new RsiError("DOCUMENT_NAME_INVALID", "Managed Markdown name must be a bare filename.");
	}
	const rootRealPath = await requireCanonicalDirectory(root, "markdownsDir");
	const absolutePath = join(rootRealPath, name);
	const info = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" && options.allowMissing) return undefined;
		throw new RsiError("DOCUMENT_NOT_FOUND", `Managed Markdown does not exist: ${name}`, { cause: error });
	});
	if (info === undefined) {
		return {
			root,
			rootRealPath,
			relativeName: name,
			absolutePath,
			exists: false,
			isFile: false,
			nlink: 0,
		};
	}
	if (info.isSymbolicLink()) {
		throw new RsiError("PATH_SYMLINK_FORBIDDEN", `Managed Markdown must not be a symlink: ${name}`);
	}
	if (!info.isFile()) {
		throw new RsiError("PATH_NOT_FILE", `Managed Markdown must be a regular file: ${name}`);
	}
	if (info.nlink !== 1) {
		throw new RsiError("PATH_HARDLINK_FORBIDDEN", `Managed Markdown must have exactly one hardlink: ${name}`, {
			details: { nlink: info.nlink },
		});
	}
	const targetRealPath = await realpath(absolutePath);
	if (targetRealPath !== absolutePath) {
		throw new RsiError("PATH_SYMLINK_FORBIDDEN", `Managed Markdown resolves through an alias: ${name}`);
	}
	return {
		root,
		rootRealPath,
		relativeName: name,
		absolutePath,
		exists: true,
		isFile: true,
		nlink: info.nlink,
		realPath: targetRealPath,
	};
}

export interface ManagedMarkdownListing {
	readonly root: string;
	readonly rootRealPath: string;
	readonly names: readonly string[];
}

/**
 * List managed Markdown names. Any nested directory, symlink, or invalid
 * Markdown filename fails closed instead of being silently ignored.
 */
export async function listManagedMarkdownNames(markdownsDir: string): Promise<ManagedMarkdownListing> {
	const root = resolve(markdownsDir);
	const rootRealPath = await requireCanonicalDirectory(root, "markdownsDir");
	const entries = await readdir(rootRealPath, { withFileTypes: true });
	const names: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			throw new RsiError("DOCUMENT_NAME_INVALID", `Nested directories are not allowed in markdowns/: ${entry.name}`);
		}
		if (entry.isSymbolicLink()) {
			throw new RsiError("PATH_SYMLINK_FORBIDDEN", `Symlinks are not allowed in markdowns/: ${entry.name}`);
		}
		if (!entry.name.toLowerCase().endsWith(".md")) continue;
		const inspection = await inspectManagedMarkdownPath(rootRealPath, entry.name, { allowMissing: false });
		if (inspection.exists) names.push(inspection.relativeName);
	}
	names.sort((left, right) => left.localeCompare(right, "en"));
	return { root, rootRealPath, names };
}
