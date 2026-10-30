import { lstat, realpath } from "node:fs/promises";
import { RsiError } from "./errors.ts";
import { listManagedMarkdownNames } from "./managed-path.ts";
import type { RuntimePaths } from "./paths.ts";
import { isPathWithin } from "./paths.ts";
import { readImmutableSystemPrompt, type ManualSystemPrompt } from "./prompt.ts";

export type ProtectedPathKind = "pi-source" | "rsi-source" | "manual-prompt" | "managed-markdowns";

export interface CanonicalProtectedPath {
	readonly kind: ProtectedPathKind;
	readonly configured: string;
	readonly canonical: string;
}

export interface VerifiedRuntimeLayout {
	readonly paths: RuntimePaths;
	readonly canonicalWorkspaceDir: string;
	readonly canonicalStateDir: string;
	readonly protectedPaths: readonly CanonicalProtectedPath[];
	readonly markdownNames: readonly string[];
	readonly manualPrompt: ManualSystemPrompt;
}

async function requireDirectory(path: string, label: string): Promise<string> {
	const info = await lstat(path).catch((error: unknown) => {
		throw new RsiError("CONFIG_INVALID", `${label} does not exist: ${path}`, { cause: error });
	});
	if (info.isSymbolicLink()) {
		throw new RsiError("CONFIG_INVALID", `${label} must not be a symlink: ${path}`);
	}
	if (!info.isDirectory()) {
		throw new RsiError("CONFIG_INVALID", `${label} must be a directory: ${path}`);
	}
	return realpath(path);
}

function assertCanonicalDisjoint(left: string, right: string, label: string): void {
	if (isPathWithin(left, right) || isPathWithin(right, left)) {
		throw new RsiError("CONFIG_INVALID", `${label} overlaps after realpath resolution: ${left} and ${right}`);
	}
}

/**
 * Filesystem preflight for deployment/config validation.
 *
 * It canonicalizes roots to detect aliases that lexical checks miss, validates
 * the external prompt, and proves the managed Markdown namespace is flat and
 * free of symlinks/hardlinks. It does not start Pi or call a model.
 */
export async function verifyRuntimeLayout(paths: RuntimePaths): Promise<VerifiedRuntimeLayout> {
	const canonicalWorkspaceDir = await requireDirectory(paths.workspaceDir, "workspaceDir");
	const canonicalStateDir = await requireDirectory(paths.stateDir, "stateDir");
	const canonicalPi = await requireDirectory(paths.piSourceDir, "piSourceDir");
	const canonicalRsi = await requireDirectory(paths.rsiSourceDir, "rsiSourceDir");
	const markdownListing = await listManagedMarkdownNames(paths.markdownsDir);
	const manualPrompt = await readImmutableSystemPrompt(paths.systemPromptFile);
	const canonicalPrompt = await realpath(paths.systemPromptFile);

	const protectedPaths: CanonicalProtectedPath[] = [
		{ kind: "pi-source", configured: paths.piSourceDir, canonical: canonicalPi },
		{ kind: "rsi-source", configured: paths.rsiSourceDir, canonical: canonicalRsi },
		{ kind: "manual-prompt", configured: paths.systemPromptFile, canonical: canonicalPrompt },
		{ kind: "managed-markdowns", configured: paths.markdownsDir, canonical: markdownListing.rootRealPath },
	];
	for (const protectedPath of protectedPaths) {
		assertCanonicalDisjoint(canonicalWorkspaceDir, protectedPath.canonical, "workspaceDir and protected path");
		assertCanonicalDisjoint(canonicalStateDir, protectedPath.canonical, "stateDir and protected path");
	}
	assertCanonicalDisjoint(canonicalStateDir, canonicalWorkspaceDir, "stateDir and workspaceDir");

	return {
		paths,
		canonicalWorkspaceDir,
		canonicalStateDir,
		protectedPaths,
		markdownNames: markdownListing.names,
		manualPrompt,
	};
}
