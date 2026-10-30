import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { RsiError } from "../shared/errors.ts";
import type { ContentRevision } from "../shared/hash.ts";
import { sha256Bytes, sha256Text } from "../shared/hash.ts";
import { assertSafeRelativePath } from "./atomic-file.ts";
import type { CandidateLimits, CandidateManifest } from "./types.ts";
import { DEFAULT_CANDIDATE_LIMITS } from "./types.ts";

export interface PayloadFile {
	readonly relativePath: string;
	readonly absolutePath: string;
	readonly size: number;
	readonly executable: boolean;
	readonly digest: ContentRevision;
}

export interface PayloadScan {
	readonly files: readonly PayloadFile[];
	readonly fileCount: number;
	readonly totalBytes: number;
	readonly digest: ContentRevision;
}

function toManifestRelative(path: string): string {
	return path.split(sep).join("/");
}

export function assertCandidateManifestShape(value: unknown): CandidateManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RsiError("CANDIDATE_CHANGED", "Candidate manifest is not an object.");
	}
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		record.createdBy !== "rsi-agent/reload" ||
		typeof record.candidateId !== "string" ||
		typeof record.generation !== "number" ||
		!Number.isInteger(record.generation) ||
		record.generation < 1 ||
		typeof record.digest !== "string" ||
		!record.digest.startsWith("sha256:") ||
		typeof record.createdAtMs !== "number" ||
		record.payloadRoot !== "payload" ||
		!Array.isArray(record.entries) ||
		!record.entries.every((entry) => typeof entry === "string") ||
		!Array.isArray(record.sources) ||
		!Array.isArray(record.trustedDependencyRoots) ||
		!record.trustedDependencyRoots.every((entry) => typeof entry === "string") ||
		!Array.isArray(record.packages) ||
		typeof record.fileCount !== "number" ||
		typeof record.totalBytes !== "number"
	) {
		throw new RsiError("CANDIDATE_CHANGED", "Candidate manifest fields are invalid.");
	}
	for (const entry of record.entries) assertSafeRelativePath(entry);
	for (const source of record.sources) {
		if (typeof source !== "object" || source === null) {
			throw new RsiError("CANDIDATE_CHANGED", "Candidate source entry is invalid.");
		}
		const item = source as Record<string, unknown>;
		if (
			typeof item.id !== "string" ||
			typeof item.originalPath !== "string" ||
			typeof item.payloadPath !== "string" ||
			(item.discovery !== "extension" && item.discovery !== "extensions" && item.discovery !== "explicit") ||
			!Array.isArray(item.entries) ||
			!item.entries.every((entry) => typeof entry === "string")
		) {
			throw new RsiError("CANDIDATE_CHANGED", "Candidate source fields are invalid.");
		}
		assertSafeRelativePath(item.payloadPath);
		for (const entry of item.entries) assertSafeRelativePath(entry);
	}
	return value as CandidateManifest;
}

export function candidateIdFor(generation: number, digest: ContentRevision): string {
	if (!Number.isInteger(generation) || generation < 1) {
		throw new RsiError("PREFLIGHT_FAILED", "Candidate generation must be a positive integer.");
	}
	return `gen-${String(generation).padStart(6, "0")}-${digest.slice("sha256:".length, "sha256:".length + 12)}`;
}

export function candidateDescriptor(manifest: Pick<
	CandidateManifest,
	"generation" | "entries" | "sources" | "trustedDependencyRoots" | "packages"
>): string {
	const sources = [...manifest.sources]
		.map((source) => ({
			id: source.id,
			originalPath: source.originalPath,
			discovery: source.discovery,
			payloadPath: source.payloadPath,
			entries: [...source.entries].sort(),
		}))
		.sort((left, right) => left.id.localeCompare(right.id, "en"));
	return JSON.stringify({
		generation: manifest.generation,
		entries: [...manifest.entries].sort(),
		sources,
		trustedDependencyRoots: [...manifest.trustedDependencyRoots].sort(),
		packages: [...manifest.packages]
			.map((pin) => ({
				packageName: pin.packageName,
				version: pin.version,
				piSpec: pin.piSpec,
				extension: pin.extension,
				integrity: pin.integrity,
				peerDependencies: pin.peerDependencies,
			}))
			.sort((left, right) => left.packageName.localeCompare(right.packageName, "en")),
	});
}

/** Hash payload file contents, paths, sizes, and exec bits. This never follows links. */
export async function scanPayload(
	payloadDir: string,
	limits: CandidateLimits = DEFAULT_CANDIDATE_LIMITS,
): Promise<PayloadScan> {
	const files: PayloadFile[] = [];
	let totalBytes = 0;
	const visit = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
		for (const entry of entries) {
			const absolute = join(directory, entry.name);
			const info = await lstat(absolute);
			if (info.isSymbolicLink()) {
				throw new RsiError("PATH_SYMLINK_FORBIDDEN", `Candidate snapshot contains a symlink: ${absolute}`);
			}
			if (info.isDirectory()) {
				await visit(absolute);
				continue;
			}
			if (!info.isFile()) {
				throw new RsiError("PATH_NOT_FILE", `Candidate snapshot contains a non-regular file: ${absolute}`);
			}
			if (info.nlink !== 1) {
				throw new RsiError("PATH_HARDLINK_FORBIDDEN", `Candidate snapshot file has multiple links: ${absolute}`);
			}
			if (info.size > limits.maxFileBytes) {
				throw new RsiError("PREFLIGHT_FAILED", `Candidate file is too large: ${absolute}`);
			}
			totalBytes += info.size;
			if (totalBytes > limits.maxTotalBytes) {
				throw new RsiError("PREFLIGHT_FAILED", "Candidate snapshot exceeds the total size limit.");
			}
			const relativePath = assertSafeRelativePath(toManifestRelative(relative(payloadDir, absolute)));
			const bytes = await readFile(absolute);
			files.push({
				relativePath,
				absolutePath: absolute,
				size: bytes.length,
				executable: (info.mode & 0o111) !== 0,
				digest: sha256Bytes(bytes),
			});
			if (files.length > limits.maxFiles) {
				throw new RsiError("PREFLIGHT_FAILED", "Candidate snapshot exceeds the file count limit.");
			}
		}
	};
	await visit(payloadDir);
	files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
	const hash = createHash("sha256");
	for (const file of files) {
		const bytes = await readFile(file.absolutePath);
		hash.update(file.relativePath);
		hash.update("\u0000");
		hash.update(String(file.size));
		hash.update("\u0000");
		hash.update(file.executable ? "x" : "-");
		hash.update("\u0000");
		hash.update(bytes);
		hash.update("\u0000");
	}
	return {
		files,
		fileCount: files.length,
		totalBytes,
		digest: `sha256:${hash.digest("hex")}`,
	};
}

/**
 * Digest binds both immutable payload bytes and the reload input descriptor.
 * Any manifest edit (entries, source roots, dependencies) changes the digest.
 */
export async function computeCandidateDigest(
	manifest: Pick<
		CandidateManifest,
		"generation" | "entries" | "sources" | "trustedDependencyRoots" | "packages" | "payloadRoot"
	>,
	candidateRoot: string,
	limits: CandidateLimits = DEFAULT_CANDIDATE_LIMITS,
): Promise<{ readonly digest: ContentRevision; readonly scan: PayloadScan }> {
	const scan = await scanPayload(join(candidateRoot, manifest.payloadRoot), limits);
	const digest = sha256Text(
		JSON.stringify({
			version: 1,
			descriptor: candidateDescriptor(manifest),
			payloadDigest: scan.digest,
			fileCount: scan.fileCount,
			totalBytes: scan.totalBytes,
		}),
	);
	return { digest, scan };
}
