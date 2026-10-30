import { lstat, readFile } from "node:fs/promises";
import { RsiError } from "./errors.ts";
import { sha256Text, type ContentRevision } from "./hash.ts";

export interface ManualSystemPrompt {
	readonly path: string;
	readonly content: string;
	readonly revision: ContentRevision;
}

/**
 * Read the human-provided immutable system prompt from an external .txt file.
 *
 * Missing, empty, symlinked, hardlinked, or non-regular files fail closed.
 * This module never invents, rewrites, or falls back to a prompt.
 */
export async function readImmutableSystemPrompt(path: string): Promise<ManualSystemPrompt> {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		throw new RsiError("PROMPT_MISSING", `Manual system prompt is missing: ${path}`, { cause: error });
	}
	if (info.isSymbolicLink()) {
		throw new RsiError("PROMPT_INVALID", "Manual system prompt must not be a symlink.");
	}
	if (!info.isFile()) {
		throw new RsiError("PROMPT_INVALID", "Manual system prompt must be a regular file.");
	}
	if (info.nlink !== 1) {
		throw new RsiError("PROMPT_INVALID", "Manual system prompt must have exactly one hardlink.");
	}
	const content = await readFile(path, "utf8");
	if (content.trim().length === 0) {
		throw new RsiError("PROMPT_MISSING", "Manual system prompt is empty; refusing to synthesize one.");
	}
	return {
		path,
		content,
		revision: sha256Text(content),
	};
}
