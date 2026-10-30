import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { RsiError } from "../shared/errors.ts";
import { isPathWithin } from "../shared/paths.ts";
import { REQUIRED_PLUGIN_PINS, type LkgSnapshot, type PluginCandidate, type VerifiedPluginPin } from "../shared/plugins.ts";
import { assertSafeRelativePath, AtomicJsonFile, fsyncDirectory, readTail } from "./atomic-file.ts";
import {
	assertCandidateManifestShape,
	candidateIdFor,
	computeCandidateDigest,
	scanPayload,
	type PayloadFile,
} from "./digest.ts";
import { discoverExtensionEntries } from "./discovery.ts";
import type {
	CandidateLimits,
	CandidateManifest,
	CandidateManifestSource,
	CandidatePrepareInput,
	CandidateSourceRootInput,
	CandidateVerification,
	ReloadCandidate,
	RestoreInterruptionReport,
	RestoreRootAllowlist,
} from "./types.ts";
import {
	DEFAULT_CANDIDATE_LIMITS,
	RELOAD_MANIFEST_FILENAME,
	RELOAD_PAYLOAD_DIRNAME,
} from "./types.ts";

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BACKUP_PREFIX = ".rsi-backup-";
const STAGING_PREFIX = ".rsi-restore-";
const RESTORE_TX_PREFIX = ".rsi-tx-";

interface RestoreTransaction {
	readonly version: 1;
	readonly transactionId: string;
	readonly target: string;
	readonly staged: string;
	readonly backup: string;
	readonly phase: "prepared" | "backed-up" | "installed";
	readonly updatedAtMs: number;
}

function restoreTransactionValidator(value: unknown): RestoreTransaction {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RsiError("INTERNAL", "Invalid restore transaction.");
	}
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.transactionId !== "string" ||
		typeof record.target !== "string" ||
		typeof record.staged !== "string" ||
		typeof record.backup !== "string" ||
		(record.phase !== "prepared" && record.phase !== "backed-up" && record.phase !== "installed") ||
		typeof record.updatedAtMs !== "number"
	) {
		throw new RsiError("INTERNAL", "Invalid restore transaction fields.");
	}
	return value as RestoreTransaction;
}

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const item of items) {
		if (seen.has(item.id)) {
			throw new RsiError("PREFLIGHT_FAILED", `Duplicate candidate source id: ${item.id}`);
		}
		seen.add(item.id);
		result.push(item);
	}
	return result;
}

function isSamePath(left: string, right: string): boolean {
	const normalize = (path: string): string => {
		const resolved = resolve(path);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	return normalize(left) === normalize(right);
}

function overlaps(left: string, right: string): boolean {
	return isPathWithin(left, right) || isPathWithin(right, left);
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
	const resolved = resolve(path);
	let info;
	try {
		info = await lstat(resolved);
	} catch (error) {
		throw new RsiError("PATH_NOT_FILE", `${label} does not exist: ${resolved}`, { cause: error });
	}
	if (info.isSymbolicLink()) {
		throw new RsiError("PATH_SYMLINK_FORBIDDEN", `${label} must not be a symlink: ${resolved}`);
	}
	if (!info.isDirectory()) {
		throw new RsiError("PATH_NOT_FILE", `${label} must be a directory: ${resolved}`);
	}
	const canonical = await realpath(resolved);
	if (!isSamePath(resolved, canonical)) {
		throw new RsiError(
			"PATH_SYMLINK_FORBIDDEN",
			`${label} must use its canonical path (${canonical}) instead of an alias (${resolved}).`,
		);
	}
	return canonical;
}

async function readSourceFile(path: string, expected: PayloadFile): Promise<Buffer> {
	const before = await lstat(path);
	if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
		throw new RsiError("CANDIDATE_CHANGED", `Source file changed type during snapshot: ${path}`);
	}
	const handle = await open(path, "r");
	try {
		const after = await handle.stat();
		if (after.ino !== before.ino || after.dev !== before.dev || after.size !== expected.size) {
			throw new RsiError("CANDIDATE_CHANGED", `Source file changed during snapshot: ${path}`);
		}
		const bytes = await handle.readFile();
		if (bytes.length !== expected.size) {
			throw new RsiError("CANDIDATE_CHANGED", `Source file changed size during snapshot: ${path}`);
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function writeFileDurable(path: string, bytes: Uint8Array, mode: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const handle = await open(path, "wx", mode);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function chmodTree(root: string, readOnly: boolean): Promise<void> {
	const visit = async (path: string): Promise<void> => {
		const info = await lstat(path);
		if (info.isSymbolicLink()) {
			throw new RsiError("PATH_SYMLINK_FORBIDDEN", `Refusing to chmod symlink: ${path}`);
		}
		if (info.isDirectory()) {
			const entries = await readdir(path);
			for (const entry of entries) await visit(join(path, entry));
			await chmod(path, readOnly ? 0o555 : 0o755);
			return;
		}
		const executable = (info.mode & 0o111) !== 0;
		const base = readOnly ? 0o444 : 0o644;
		await chmod(path, executable ? base | 0o111 : base);
	};
	await visit(root);
}

async function copyTree(sourceRoot: string, targetRoot: string, writable: boolean): Promise<void> {
	const visit = async (sourceDir: string, targetDir: string): Promise<void> => {
		// Build writable first: the container Supervisor has no CAP_DAC_OVERRIDE
		// and cannot populate a directory after creating it mode 0555. The entire
		// tree is sealed read-only after all children have been copied.
		await mkdir(targetDir, { recursive: true, mode: 0o755 });
		const entries = await readdir(sourceDir, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
		for (const entry of entries) {
			const source = join(sourceDir, entry.name);
			const target = join(targetDir, entry.name);
			const info = await lstat(source);
			if (info.isSymbolicLink()) {
				throw new RsiError("PATH_SYMLINK_FORBIDDEN", `Refusing to copy symlink: ${source}`);
			}
			if (info.isDirectory()) {
				await visit(source, target);
				continue;
			}
			if (!info.isFile()) {
				throw new RsiError("PATH_NOT_FILE", `Refusing to copy non-regular file: ${source}`);
			}
			const bytes = await readFile(source);
			const executable = (info.mode & 0o111) !== 0;
			await writeFileDurable(target, bytes, writable ? (executable ? 0o755 : 0o644) : executable ? 0o555 : 0o444);
		}
	};
	await visit(sourceRoot, targetRoot);
	if (!writable) await chmodTree(targetRoot, true);
	await fsyncDirectory(targetRoot);
}

/** Read-only, content-addressed candidate snapshot store and LKG materializer. */
export class ImmutableCandidateStore {
	readonly snapshotDir: string;
	readonly candidatesDir: string;
	readonly lkgDir: string;
	readonly transactionDir: string;
	readonly limits: CandidateLimits;
	readonly forbiddenRoots: readonly string[];
	readonly defaultTrustedDependencyRoots: readonly string[];
	private readonly hooks: { readonly afterBackup?: () => Promise<void> | void; readonly afterInstall?: () => Promise<void> | void };

	constructor(input: {
		readonly snapshotDir: string;
		readonly forbiddenRoots?: readonly string[];
		readonly trustedDependencyRoots?: readonly string[];
		readonly limits?: CandidateLimits;
		readonly hooks?: { readonly afterBackup?: () => Promise<void> | void; readonly afterInstall?: () => Promise<void> | void };
	}) {
		this.snapshotDir = resolve(input.snapshotDir);
		this.candidatesDir = join(this.snapshotDir, "candidates");
		this.lkgDir = join(this.snapshotDir, "lkg");
		this.transactionDir = join(this.snapshotDir, "restore-transactions");
		this.limits = input.limits ?? DEFAULT_CANDIDATE_LIMITS;
		this.forbiddenRoots = (input.forbiddenRoots ?? []).map((path) => resolve(path));
		this.defaultTrustedDependencyRoots = (input.trustedDependencyRoots ?? []).map((path) => resolve(path));
		this.hooks = input.hooks ?? {};
	}

	private async canonicalTrustedRoots(input: readonly string[] | undefined): Promise<string[]> {
		const roots = uniqueById(
			[...(input ?? []), ...this.defaultTrustedDependencyRoots].map((path, index) => ({
				id: `${index}`,
				path: resolve(path),
			})),
		);
		const result: string[] = [];
		for (const root of roots) {
			const canonical = await canonicalDirectory(root.path, "trustedDependencyRoot");
			if (!result.some((entry) => isSamePath(entry, canonical))) result.push(canonical);
		}
		return result;
	}

	private assertPrepareRootAllowed(root: string): void {
		if (root === resolve("/") || root === resolve(process.cwd())) {
			throw new RsiError("PATH_OUTSIDE_ROOT", `Refusing to snapshot broad directory: ${root}`);
		}
		for (const forbidden of this.forbiddenRoots) {
			if (isSamePath(root, forbidden) || isPathWithin(root, forbidden)) {
				throw new RsiError(
					"PATH_OUTSIDE_ROOT",
					`Extension source root must not contain a protected runtime path: ${root}`,
				);
			}
			if (isPathWithin(forbidden, root)) {
				throw new RsiError("PATH_OUTSIDE_ROOT", `Extension source root is inside a protected path: ${root}`);
			}
		}
	}

	private async discoverSource(
		source: CandidateSourceRootInput,
		canonicalRoot: string,
		allowEmpty: boolean,
	): Promise<{ readonly source: CandidateManifestSource; readonly absoluteEntries: readonly string[] }> {
		if (!SOURCE_ID_PATTERN.test(source.id)) {
			throw new RsiError("PREFLIGHT_FAILED", `Invalid candidate source id: ${source.id}`);
		}
		const discovery = source.discovery ?? "extensions";
		const absoluteEntries = await discoverExtensionEntries(canonicalRoot, discovery, source.entries, {
			allowEmpty,
		});
		const relativeEntries = absoluteEntries.map((entry) => {
			const rel = relative(canonicalRoot, entry);
			if (rel.startsWith("..") || isAbsolute(rel)) {
				throw new RsiError("PATH_OUTSIDE_ROOT", `Extension entry escapes source root: ${entry}`);
			}
			return assertSafeRelativePath(rel.replaceAll("\\", "/"));
		});
		return {
			source: {
				id: source.id,
				originalPath: canonicalRoot,
				discovery,
				payloadPath: `${RELOAD_PAYLOAD_DIRNAME}/sources/${source.id}`,
				entries: relativeEntries,
			},
			absoluteEntries,
		};
	}

	async prepareCandidate(input: CandidatePrepareInput): Promise<ReloadCandidate> {
		if (!Number.isInteger(input.generation) || input.generation < 1) {
			throw new RsiError("PREFLIGHT_FAILED", "Candidate generation must be a positive integer.");
		}
		if (input.sourceRoots.length === 0 && input.allowEmpty !== true) {
			throw new RsiError("PREFLIGHT_FAILED", "At least one extension source root is required unless an empty candidate is explicitly allowed.");
		}
		await mkdir(this.candidatesDir, { recursive: true, mode: 0o755 });
		await chmod(this.candidatesDir, 0o755).catch(() => undefined);
		const uniqueSources = uniqueById(input.sourceRoots);
		const seenRoots: string[] = [];
		const canonicalSources: { input: CandidateSourceRootInput; root: string }[] = [];
		for (const source of uniqueSources) {
			if (!isAbsolute(source.path)) {
				throw new RsiError("PATH_INVALID", `Extension source root must be absolute: ${source.path}`);
			}
			const root = await canonicalDirectory(source.path, "extension source root");
			this.assertPrepareRootAllowed(root);
			for (const previous of seenRoots) {
				if (overlaps(previous, root)) {
					throw new RsiError("PATH_OUTSIDE_ROOT", `Extension source roots must not overlap: ${previous}, ${root}`);
				}
			}
			seenRoots.push(root);
			canonicalSources.push({ input: source, root });
		}

		const discovered: CandidateManifestSource[] = [];
		const sourceBefore = new Map<string, string>();
		for (const item of canonicalSources) {
			const before = await scanPayload(item.root, this.limits);
			sourceBefore.set(item.root, before.digest);
			discovered.push((await this.discoverSource(item.input, item.root, input.allowEmpty === true)).source);
		}
		const trustedDependencyRoots = await this.canonicalTrustedRoots(input.trustedDependencyRoots);
		const packages: readonly VerifiedPluginPin[] = input.packages ?? REQUIRED_PLUGIN_PINS;

		const staging = join(this.candidatesDir, `.staging-${randomUUID()}`);
		try {
			await mkdir(staging, { recursive: true, mode: 0o700 });
			const payloadDir = join(staging, RELOAD_PAYLOAD_DIRNAME);
			await mkdir(payloadDir, { recursive: true, mode: 0o700 });
			for (const source of discovered) {
				const sourceStaging = join(staging, source.payloadPath);
				await mkdir(sourceStaging, { recursive: true, mode: 0o700 });
				const scan = await scanPayload(source.originalPath, this.limits);
				for (const file of scan.files) {
					const bytes = await readSourceFile(file.absolutePath, file);
					const destination = join(sourceStaging, ...file.relativePath.split("/"));
					await writeFileDurable(destination, bytes, file.executable ? 0o755 : 0o644);
				}
				await fsyncDirectory(sourceStaging);
			}

			await input.hooks?.beforeSourceRecheck?.();
			for (const item of canonicalSources) {
				const after = await scanPayload(item.root, this.limits);
				if (after.digest !== sourceBefore.get(item.root)) {
					throw new RsiError(
						"CANDIDATE_CHANGED",
						`Extension source changed while building the candidate snapshot: ${item.root}`,
					);
				}
			}

			const manifestDraft = {
				version: 1 as const,
				createdBy: "rsi-agent/reload" as const,
				candidateId: "",
				generation: input.generation,
				digest: "sha256:" as `sha256:${string}`,
				createdAtMs: input.now.getTime(),
				payloadRoot: RELOAD_PAYLOAD_DIRNAME,
				entries: discovered
					.flatMap((source) =>
						source.entries.map((entry) => `${source.payloadPath}/${entry.replaceAll("\\", "/")}`),
					)
					.sort((left, right) => left.localeCompare(right, "en")),
				sources: [...discovered].sort((left, right) => left.id.localeCompare(right.id, "en")),
				trustedDependencyRoots,
				packages,
				fileCount: 0,
				totalBytes: 0,
			};
			const draftResult = await computeCandidateDigest(manifestDraft, staging, this.limits);
			const candidateId = candidateIdFor(input.generation, draftResult.digest);
			const manifest: CandidateManifest = {
				...manifestDraft,
				candidateId,
				digest: draftResult.digest,
				fileCount: draftResult.scan.fileCount,
				totalBytes: draftResult.scan.totalBytes,
			};
			await writeFile(join(staging, RELOAD_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
			await chmodTree(staging, true);
			const verifiedDraft = await computeCandidateDigest(manifest, staging, this.limits);
			if (verifiedDraft.digest !== manifest.digest) {
				throw new RsiError("CANDIDATE_CHANGED", "Candidate digest changed while writing its manifest.");
			}
			const finalPath = join(this.candidatesDir, candidateId);
			try {
				await lstat(finalPath);
				const existing = await this.verifyCandidate(finalPath);
				if (existing.manifest.digest !== manifest.digest) {
					throw new RsiError("CANDIDATE_CHANGED", `Candidate id collision at ${finalPath}.`);
				}
				await rm(staging, { recursive: true, force: true });
				return existing.candidate;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await rename(staging, finalPath);
			await fsyncDirectory(this.candidatesDir);
			return (await this.verifyCandidate(finalPath)).candidate;
		} catch (error) {
			await rm(staging, { recursive: true, force: true });
			throw error;
		}
	}

	async readManifest(candidatePath: string): Promise<CandidateManifest> {
		const root = resolve(candidatePath);
		const info = await lstat(root);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new RsiError("CANDIDATE_CHANGED", `Candidate path is not a directory: ${root}`);
		}
		let text: string;
		try {
			text = await readFile(join(root, RELOAD_MANIFEST_FILENAME), "utf8");
		} catch (error) {
			throw new RsiError("CANDIDATE_CHANGED", `Candidate manifest is missing: ${root}`, { cause: error });
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new RsiError("CANDIDATE_CHANGED", `Candidate manifest is not valid JSON: ${root}`, { cause: error });
		}
		return assertCandidateManifestShape(parsed);
	}

	private async assertCandidateLocation(candidatePath: string): Promise<void> {
		const root = resolve(candidatePath);
		if (!isPathWithin(this.snapshotDir, root) || isSamePath(root, this.snapshotDir)) {
			throw new RsiError("PATH_OUTSIDE_ROOT", `Candidate path is outside the snapshot store: ${root}`);
		}
	}

	private async assertReadOnlyCandidate(candidatePath: string, files: readonly PayloadFile[]): Promise<void> {
		const manifestInfo = await lstat(join(candidatePath, RELOAD_MANIFEST_FILENAME));
		if ((manifestInfo.mode & 0o222) !== 0) {
			throw new RsiError("CANDIDATE_CHANGED", "Candidate manifest is writable; immutable snapshot required.");
		}
		for (const file of files) {
			const info = await lstat(file.absolutePath);
			if ((info.mode & 0o222) !== 0) {
				throw new RsiError("CANDIDATE_CHANGED", `Candidate file is writable: ${file.absolutePath}`);
			}
		}
	}

	async verifyCandidate(
		candidatePath: string,
		options: { readonly allowWritable?: boolean } = {},
	): Promise<CandidateVerification> {
		await this.assertCandidateLocation(candidatePath);
		const manifest = await this.readManifest(candidatePath);
		const computed = await computeCandidateDigest(manifest, candidatePath, this.limits);
		if (computed.digest !== manifest.digest) {
			throw new RsiError("CANDIDATE_CHANGED", `Candidate digest mismatch at ${candidatePath}.`, {
				details: { expected: manifest.digest, actual: computed.digest },
			});
		}
		if (manifest.candidateId !== candidateIdFor(manifest.generation, manifest.digest)) {
			throw new RsiError("CANDIDATE_CHANGED", `Candidate id does not match its digest at ${candidatePath}.`);
		}
		if (computed.scan.fileCount !== manifest.fileCount || computed.scan.totalBytes !== manifest.totalBytes) {
			throw new RsiError("CANDIDATE_CHANGED", `Candidate size metadata mismatch at ${candidatePath}.`);
		}
		const fileSet = new Set(computed.scan.files.map((file) => file.relativePath));
		for (const entry of manifest.entries) {
			assertSafeRelativePath(entry);
			const payloadRelative = entry.startsWith(`${manifest.payloadRoot}/`)
				? entry.slice(manifest.payloadRoot.length + 1)
				: entry;
			if (!fileSet.has(payloadRelative)) {
				throw new RsiError("CANDIDATE_CHANGED", `Candidate entry is missing from payload: ${entry}`);
			}
		}
		if (!options.allowWritable) await this.assertReadOnlyCandidate(candidatePath, computed.scan.files);
		const candidate: ReloadCandidate = {
			candidateId: manifest.candidateId,
			generation: manifest.generation,
			path: resolve(candidatePath),
			digest: manifest.digest,
			packages: manifest.packages,
			createdAtMs: manifest.createdAtMs,
			readOnly: true,
			manifest,
		};
		return { manifest, digest: manifest.digest, candidate };
	}

	toPluginCandidate(candidate: ReloadCandidate): PluginCandidate {
		return {
			candidateId: candidate.candidateId,
			generation: candidate.generation,
			path: candidate.path,
			digest: candidate.digest,
			packages: candidate.packages,
			createdAtMs: candidate.createdAtMs,
			readOnly: true,
		};
	}

	async createLkg(candidate: ReloadCandidate, now: Date, healthyTurns: number): Promise<LkgSnapshot> {
		const verified = await this.verifyCandidate(candidate.path);
		if (verified.digest !== candidate.digest) {
			throw new RsiError("CANDIDATE_CHANGED", "Candidate changed before LKG materialization.");
		}
		await mkdir(this.lkgDir, { recursive: true, mode: 0o755 });
		await chmod(this.lkgDir, 0o755).catch(() => undefined);
		const target = join(this.lkgDir, candidate.candidateId);
		try {
			const existing = await this.verifyCandidate(target);
			if (existing.digest !== candidate.digest) {
				throw new RsiError("CANDIDATE_CHANGED", `LKG id collision at ${target}.`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const staging = join(this.lkgDir, `.staging-${randomUUID()}`);
			try {
				await copyTree(candidate.path, staging, false);
				await this.verifyCandidate(staging);
				await rename(staging, target);
				await fsyncDirectory(this.lkgDir);
			} catch (error) {
				await rm(staging, { recursive: true, force: true });
				throw error;
			}
		}
		return {
			generation: candidate.generation,
			candidateId: candidate.candidateId,
			digest: candidate.digest,
			path: target,
			healthyTurns,
			verifiedAtMs: now.getTime(),
		};
	}

	async verifyLkg(snapshot: LkgSnapshot): Promise<ReloadCandidate> {
		await this.assertCandidateLocation(snapshot.path);
		const verification = await this.verifyCandidate(snapshot.path);
		if (
			verification.digest !== snapshot.digest ||
			verification.manifest.generation !== snapshot.generation ||
			verification.manifest.candidateId !== snapshot.candidateId
		) {
			throw new RsiError("CANDIDATE_CHANGED", "LKG snapshot no longer matches its recorded generation/digest.");
		}
		return verification.candidate;
	}

	private assertRestoreTarget(target: string, allowlist: RestoreRootAllowlist): void {
		const resolved = resolve(target);
		const allowed = allowlist.roots.some((root) => isSamePath(root, resolved));
		if (!allowed) {
			throw new RsiError("PATH_OUTSIDE_ROOT", `Restore target is not in the Supervisor allowlist: ${resolved}`);
		}
		if (resolved === resolve("/")) {
			throw new RsiError("PATH_OUTSIDE_ROOT", "Refusing to restore a filesystem root.");
		}
		for (const forbidden of allowlist.forbiddenRoots ?? []) {
			const forbiddenResolved = resolve(forbidden);
			if (isSamePath(resolved, forbiddenResolved) || isPathWithin(resolved, forbiddenResolved)) {
				throw new RsiError("PATH_OUTSIDE_ROOT", `Restore target contains a protected path: ${resolved}`);
			}
		}
	}

	private async stageSource(payload: string, target: string): Promise<string> {
		const parent = dirname(target);
		await mkdir(parent, { recursive: true });
		const staging = join(parent, `${STAGING_PREFIX}${randomUUID()}`);
		await copyTree(payload, staging, true);
		return staging;
	}

	private transactionFile(transactionId: string): AtomicJsonFile<RestoreTransaction> {
		return new AtomicJsonFile(
			join(this.transactionDir, `${RESTORE_TX_PREFIX}${transactionId}.json`),
			restoreTransactionValidator,
		);
	}

	private async writeTransaction(transaction: RestoreTransaction): Promise<void> {
		await mkdir(this.transactionDir, { recursive: true, mode: 0o700 });
		await this.transactionFile(transaction.transactionId).write(transaction);
	}

	private async clearTransaction(transactionId: string): Promise<void> {
		await rm(join(this.transactionDir, `${RESTORE_TX_PREFIX}${transactionId}.json`), { force: true });
		await rm(join(this.transactionDir, `${RESTORE_TX_PREFIX}${transactionId}.json.bak`), { force: true });
	}

	/** Atomically replace one source root with the candidate payload. */
	async restoreCandidateSources(
		candidatePath: string,
		allowlist: RestoreRootAllowlist,
	): Promise<{ readonly restored: readonly string[] }> {
		const { manifest } = await this.verifyCandidate(candidatePath);
		const restored: string[] = [];
		for (const source of manifest.sources) {
			this.assertRestoreTarget(source.originalPath, allowlist);
			const payload = join(candidatePath, source.payloadPath);
			const target = resolve(source.originalPath);
			let targetInfo: Awaited<ReturnType<typeof lstat>> | null = null;
			try {
				targetInfo = await lstat(target);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (targetInfo !== null && (targetInfo.isSymbolicLink() || !targetInfo.isDirectory())) {
				throw new RsiError("PATH_SYMLINK_FORBIDDEN", `Restore target is not a real directory: ${target}`);
			}
			const staged = await this.stageSource(payload, target);
			const transactionId = randomUUID();
			const backup = join(dirname(target), `${BACKUP_PREFIX}${transactionId}`);
			const transaction: RestoreTransaction = {
				version: 1,
				transactionId,
				target,
				staged,
				backup,
				phase: "prepared",
				updatedAtMs: Date.now(),
			};
			await this.writeTransaction(transaction);
			try {
				if (targetInfo !== null) {
					await rename(target, backup);
				}
				await this.writeTransaction({ ...transaction, phase: "backed-up", updatedAtMs: Date.now() });
				await this.hooks.afterBackup?.();
				await rename(staged, target);
				await this.writeTransaction({ ...transaction, phase: "installed", updatedAtMs: Date.now() });
				await this.hooks.afterInstall?.();
				await rm(backup, { recursive: true, force: true });
			} catch (error) {
				// Best-effort immediate rollback. Startup recovery handles a crash here.
				try {
					if (targetInfo !== null) {
						const current = await lstat(target).catch(() => null);
						if (current === null) await rename(backup, target);
					}
				} catch {
					// The transaction journal remains for startup recovery.
				}
				throw error;
			} finally {
				await rm(staged, { recursive: true, force: true }).catch(() => undefined);
			}
			await this.clearTransaction(transactionId);
			restored.push(target);
		}
		return { restored };
	}

	/** Recover crash-interrupted source replacement without silently deleting old bytes. */
	async recoverInterruptedRestores(allowlist: RestoreRootAllowlist): Promise<RestoreInterruptionReport> {
		const recovered: string[] = [];
		const committed: string[] = [];
		const cleaned: string[] = [];
		const errors: string[] = [];
		let names: string[] = [];
		try {
			names = await readdir(this.transactionDir);
		} catch {
			names = [];
		}
		for (const name of names.sort()) {
			if (!name.startsWith(RESTORE_TX_PREFIX) || !name.endsWith(".json")) continue;
			const file = this.transactionFile(name.slice(RESTORE_TX_PREFIX.length, -".json".length));
			const read = await file.read();
			if (read.value === null) {
				errors.push(...read.diagnostics);
				continue;
			}
			const transaction = read.value;
			try {
				this.assertRestoreTarget(transaction.target, allowlist);
				const stagedExists = await lstat(transaction.staged).then(() => true).catch(() => false);
				const backupExists = await lstat(transaction.backup).then(() => true).catch(() => false);
				const targetExists = await lstat(transaction.target).then(() => true).catch(() => false);
				if (transaction.phase === "prepared") {
					if (stagedExists) await rm(transaction.staged, { recursive: true, force: true });
					cleaned.push(transaction.target);
				} else if (transaction.phase === "backed-up") {
					if (stagedExists && targetExists) {
						// Both old target and staged new tree exist: the rename did not happen.
						await rm(transaction.staged, { recursive: true, force: true });
						if (backupExists) await rm(transaction.backup, { recursive: true, force: true });
						committed.push(transaction.target);
					} else if (backupExists) {
						// The old tree was moved but the new tree was not installed: roll back.
						if (targetExists) await rm(transaction.target, { recursive: true, force: true });
						await rename(transaction.backup, transaction.target);
						recovered.push(transaction.target);
					} else if (targetExists) {
						// A previous recovery already renamed the backup back. Keep it.
						committed.push(transaction.target);
					} else {
						errors.push(`Restore transaction ${transaction.transactionId} lost its backup for ${transaction.target}.`);
					}
					if (stagedExists) await rm(transaction.staged, { recursive: true, force: true });
				} else {
					if (stagedExists) await rm(transaction.staged, { recursive: true, force: true });
					if (backupExists) await rm(transaction.backup, { recursive: true, force: true });
					if (targetExists) committed.push(transaction.target);
					else errors.push(`Installed restore transaction lost its target: ${transaction.target}`);
				}
				await this.clearTransaction(transaction.transactionId);
			} catch (error) {
				errors.push(`Could not recover restore transaction ${transaction.transactionId}: ${String(error)}`);
			}
		}
		for (const root of allowlist.roots) {
			const parent = dirname(root);
			try {
				const entries = await readdir(parent);
				for (const entry of entries) {
					if (entry.startsWith(STAGING_PREFIX)) {
						await rm(join(parent, entry), { recursive: true, force: true });
						cleaned.push(join(parent, entry));
					}
				}
			} catch {
				// Parent need not exist yet.
			}
		}
		return { recovered, committed, cleaned, errors };
	}

	async pruneCandidates(keepPaths: readonly string[], keepCount = 5): Promise<string[]> {
		const keep = new Set(keepPaths.map((path) => resolve(path)));
		let names: string[] = [];
		try {
			names = await readdir(this.candidatesDir);
		} catch {
			return [];
		}
		const candidates = names
			.filter((name) => !name.startsWith("."))
			.sort((left, right) => left.localeCompare(right, "en"))
			.map((name) => join(this.candidatesDir, name))
			.filter((path) => !keep.has(path));
		const removals: string[] = [];
		for (const path of candidates) {
			if (removals.length < Math.max(0, candidates.length - keepCount)) {
				await rm(path, { recursive: true, force: true });
				removals.push(path);
			}
		}
		return removals;
	}

	async pruneLkg(keepPaths: readonly string[], keepCount = 3): Promise<string[]> {
		const keep = new Set(keepPaths.map((path) => resolve(path)));
		let names: string[] = [];
		try {
			names = await readdir(this.lkgDir);
		} catch {
			return [];
		}
		const candidates = names
			.filter((name) => !name.startsWith("."))
			.sort((left, right) => left.localeCompare(right, "en"))
			.map((name) => join(this.lkgDir, name))
			.filter((path) => !keep.has(path));
		const removals: string[] = [];
		for (const path of candidates) {
			if (removals.length < Math.max(0, candidates.length - keepCount)) {
				await rm(path, { recursive: true, force: true });
				removals.push(path);
			}
		}
		return removals;
	}
}

/** Read a candidate's bounded manifest tail; used for diagnostics without execution. */
export async function readCandidateDiagnosticTail(path: string): Promise<string> {
	return readTail(join(path, RELOAD_MANIFEST_FILENAME), 4_096);
}

export function candidateContentDigest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function requireWithinSnapshot(snapshotDir: string, path: string): string {
	const resolved = resolve(path);
	if (!isPathWithin(snapshotDir, resolved)) {
		throw new RsiError("PATH_OUTSIDE_ROOT", `Path is outside snapshotDir: ${resolved}`);
	}
	return resolved;
}

export async function assertRegularFile(path: string): Promise<void> {
	const info = await stat(path);
	if (!info.isFile()) throw new RsiError("PATH_NOT_FILE", `Not a regular file: ${path}`);
}

export const NODE_FS_CONSTANTS = constants;
