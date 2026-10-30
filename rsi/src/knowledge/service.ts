import { createEditToolDefinition, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { chmod, lstat, mkdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isPathWithin, requireAbsolutePath } from "../shared/paths.ts";
import {
	INDEX_FILENAME,
	renderIndexReadReport,
	type DocumentCommitRequest,
	type DocumentMutationResult,
	type DocumentOperation,
	type IndexConsistency,
	type ManagedDocumentStat,
} from "../shared/documents.ts";
import { RsiError } from "../shared/errors.ts";
import { sha256Bytes, sha256Text, type ContentRevision } from "../shared/hash.ts";
import type {
	IndexReadReport,
	ManagedDocumentSnapshot,
	ManagedDocumentSummary,
} from "../shared/ipc/protocol.ts";
import { listManagedMarkdownNames, inspectManagedMarkdownPath, assertManagedDocumentName } from "../shared/managed-path.ts";
import { MEMORY_FILENAME } from "../shared/paths.ts";
import {
	MEMORY_MAX_WORDS,
	MANAGED_DOCUMENT_MAX_WORDS,
	MAX_MANAGED_DOCUMENTS,
} from "../shared/policy.ts";
import { formatMemoryUsage, type MemorySnapshot } from "../shared/memory.ts";
import type { DocumentStorePort, MemoryPort } from "../shared/ports.ts";
import { assertValidTimeZone, DEFAULT_TIME_ZONE, formatTimestamp, SystemClock, type Clock } from "../shared/time.ts";
import { countWords } from "../shared/words.ts";
import {
	assertCommittableText,
	assertDirectoryIdentity,
	assertKnowledgeStateIsolation,
	captureDirectoryIdentity,
	commitStagedFile,
	decodeUtf8Strict,
	removeStagedFile,
	readRegularFileStrict,
	stageFile,
	withCrossProcessLock,
	withProcessMutex,
	type DirectoryIdentity,
} from "./atomic-fs.ts";
import {
	auditKnowledgeIndex,
	createInitialIndexContent,
	toIndexConsistency,
	type KnowledgeIndexAudit,
} from "./index-audit.ts";
import {
	assertManagedDirectoryRoot,
	classifyManagedToolPathAgainstRoot,
	type ManagedToolPath,
} from "./path-policy.ts";
import { ReadStatsStore } from "./read-stats.ts";

export interface KnowledgeServiceOptions {
	readonly markdownsDir: string;
	readonly stateDir: string;
	readonly readStatsFile?: string;
	readonly timeZone?: string;
	readonly clock?: Clock;
	readonly initialize?: boolean;
	readonly lockTimeoutMs?: number;
	readonly lockStaleMs?: number;
}

export interface AuthoritativeMemorySnapshot extends MemorySnapshot {
	readonly version: ContentRevision;
	readonly usage: string;
}

export interface ManagedReadOptions {
	readonly offset?: number;
	readonly limit?: number;
	readonly recordRead?: boolean;
	readonly now?: Date;
}

export interface ManagedReadResult {
	readonly name: string;
	readonly snapshot: ManagedDocumentSnapshot;
	readonly content: readonly (TextContent | ImageContent)[];
	readonly details?: unknown;
	readonly structuredContent?: unknown;
	readonly readsLast24h: number;
}

export interface NativeEdit {
	readonly oldText: string;
	readonly newText: string;
}

export interface ManagedEditResult extends DocumentMutationResult {
	readonly details?: unknown;
}

export interface ManagedDeleteResult {
	readonly name: string;
	readonly deleted: true;
	readonly committedAtMs: number;
	readonly indexWarnings: readonly string[];
}

export interface ManagedRenameResult extends DocumentMutationResult {
	readonly from: string;
	readonly to: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireAbsoluteDirectory(value: string, label: string): string {
	return requireAbsolutePath(value, label);
}

async function ensureDirectory(
	path: string,
	label: string,
	create: boolean,
	createMode = 0o700,
): Promise<string> {
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" && create) return undefined;
		throw new RsiError("CONFIG_INVALID", `${label} does not exist: ${path}`, { cause: error });
	});
	if (info === undefined) {
		await mkdir(path, { recursive: true, mode: createMode });
		// mkdir mode is filtered by umask; only newly created roots are corrected.
		await chmod(path, createMode).catch(() => {});
	}
	const next = await lstat(path).catch((error: unknown) => {
		throw new RsiError("CONFIG_INVALID", `${label} is not accessible: ${path}`, { cause: error });
	});
	if (next.isSymbolicLink()) {
		throw new RsiError("PATH_SYMLINK_FORBIDDEN", `${label} must not be a symlink.`);
	}
	if (!next.isDirectory()) {
		throw new RsiError("CONFIG_INVALID", `${label} must be a directory.`);
	}
	return realpath(path);
}

function conflictCode(name: string): "MEMORY_REVISION_CONFLICT" | "DOCUMENT_REVISION_CONFLICT" {
	return name === MEMORY_FILENAME ? "MEMORY_REVISION_CONFLICT" : "DOCUMENT_REVISION_CONFLICT";
}

function assertExpectedRevisionValue(expectedRevision: string | null): void {
	if (expectedRevision !== null && (typeof expectedRevision !== "string" || expectedRevision.length === 0)) {
		throw new RsiError("INTERNAL", "expectedRevision must be a revision string or null.");
	}
}

function assertOperation(value: unknown): asserts value is DocumentOperation {
	if (value !== "write" && value !== "edit" && value !== "memory") {
		throw new RsiError("INTERNAL", "Unsupported managed document operation.");
	}
}

function readWordLimit(name: string): number {
	return name === MEMORY_FILENAME ? MEMORY_MAX_WORDS : MANAGED_DOCUMENT_MAX_WORDS;
}

function wordLimitCode(name: string): "MEMORY_WORD_LIMIT" | "DOCUMENT_WORD_LIMIT" {
	return name === MEMORY_FILENAME ? "MEMORY_WORD_LIMIT" : "DOCUMENT_WORD_LIMIT";
}

function assertWordCount(name: string, content: string, label: string): number {
	const words = countWords(content);
	const maxWords = readWordLimit(name);
	if (words > maxWords) {
		throw new RsiError(wordLimitCode(name), `${label} exceeds ${maxWords} words (found ${words}).`, {
			details: { words, maxWords },
		});
	}
	return words;
}

function appendAfterLocationLink(line: string, location: string, metadata: string): string {
	const locationStart = line.indexOf(location);
	const linkStart = locationStart >= 0 ? line.indexOf("](", locationStart) : line.indexOf("](");
	if (linkStart < 0) return line;
	let depth = 0;
	let escaped = false;
	for (let index = linkStart + 1; index < line.length; index++) {
		const character = line[index] ?? "";
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "(") depth++;
		else if (character === ")") {
			depth--;
			if (depth === 0) {
				return `${line.slice(0, index + 1)}${metadata}${line.slice(index + 1)}`;
			}
		}
	}
	return line;
}

/**
 * Trusted external knowledge service: MemoryPort, DocumentStorePort, the
 * document broker, index auditor, and request-time index view.
 */
export class KnowledgeService implements MemoryPort, DocumentStorePort {
	readonly root: DirectoryIdentity;
	readonly markdownsDir: string;
	readonly stateDir: string;
	readonly readStatsFile: string;
	readonly timeZone: string;
	readonly clock: Clock;
	readonly readStats: ReadStatsStore;
	private readonly lockDir: string;
	private readonly lockTimeoutMs: number;
	private readonly lockStaleMs: number;

	private constructor(input: {
		root: DirectoryIdentity;
		stateDir: string;
		readStatsFile: string;
		timeZone: string;
		clock: Clock;
		lockDir: string;
		lockTimeoutMs: number;
		lockStaleMs: number;
	}) {
		this.root = input.root;
		this.markdownsDir = input.root.realPath;
		this.stateDir = input.stateDir;
		this.readStatsFile = input.readStatsFile;
		this.timeZone = input.timeZone;
		this.clock = input.clock;
		this.lockDir = input.lockDir;
		this.lockTimeoutMs = input.lockTimeoutMs;
		this.lockStaleMs = input.lockStaleMs;
		this.readStats = new ReadStatsStore({
			filePath: input.readStatsFile,
			lockDir: join(input.stateDir, ".reads.lock"),
			lockTimeoutMs: input.lockTimeoutMs,
			lockStaleMs: input.lockStaleMs,
		});
	}

	static async open(options: KnowledgeServiceOptions): Promise<KnowledgeService> {
		const markdownsConfigured = requireAbsoluteDirectory(options.markdownsDir, "markdownsDir");
		const stateConfigured = requireAbsoluteDirectory(options.stateDir, "stateDir");
		assertKnowledgeStateIsolation(markdownsConfigured, stateConfigured);
		const initialize = options.initialize ?? true;
		const timeZone = assertValidTimeZone(options.timeZone ?? DEFAULT_TIME_ZONE);
		const stateDir = await ensureDirectory(stateConfigured, "stateDir", initialize, 0o700);
		const markdownsDir = await ensureDirectory(markdownsConfigured, "markdownsDir", initialize, 0o755);
		assertKnowledgeStateIsolation(markdownsDir, stateDir);
		const root = await captureDirectoryIdentity(markdownsDir, "markdownsDir");

		const configuredReadStatsFile = requireAbsolutePath(
			options.readStatsFile ?? join(stateDir, "read-stats", "reads.json"),
			"readStatsFile",
		);
		if (configuredReadStatsFile === stateDir || !isPathWithin(stateDir, configuredReadStatsFile)) {
			throw new RsiError("CONFIG_INVALID", "readStatsFile must be inside the external state directory.");
		}
		const readStatsDir = await ensureDirectory(
			dirname(configuredReadStatsFile),
			"readStatsDir",
			initialize,
		);
		const readStatsFile = join(readStatsDir, basename(configuredReadStatsFile));
		if (readStatsFile === stateDir || !isPathWithin(stateDir, readStatsFile)) {
			throw new RsiError("CONFIG_INVALID", "readStatsFile must resolve inside the external state directory.");
		}

		const service = new KnowledgeService({
			root,
			stateDir,
			readStatsFile,
			timeZone,
			clock: options.clock ?? new SystemClock(),
			lockDir: join(stateDir, ".knowledge.lock"),
			lockTimeoutMs: options.lockTimeoutMs ?? 10_000,
			lockStaleMs: options.lockStaleMs ?? 30_000,
		});
		await service.initialize(initialize);
		return service;
	}

	static async openFromRuntimePaths(
		paths: {
			readonly markdownsDir: string;
			readonly stateDir: string;
			readonly readStatsFile: string;
		},
		options: Omit<KnowledgeServiceOptions, "markdownsDir" | "stateDir" | "readStatsFile"> = {},
	): Promise<KnowledgeService> {
		return KnowledgeService.open({
			...options,
			markdownsDir: paths.markdownsDir,
			stateDir: paths.stateDir,
			readStatsFile: paths.readStatsFile,
		});
	}

	private async withMutationLock<T>(action: () => Promise<T>): Promise<T> {
		return withProcessMutex(`knowledge-root:${this.root.realPath}`, () =>
			withCrossProcessLock(
				this.lockDir,
				{ timeoutMs: this.lockTimeoutMs, staleMs: this.lockStaleMs },
				async () => {
					await assertDirectoryIdentity(this.root, "markdownsDir");
					return action();
				},
			),
		);
	}

	private async initialize(initialize: boolean): Promise<void> {
		await this.withMutationLock(async () => {
			const names = (await listManagedMarkdownNames(this.root.realPath)).names;
			const hasMemory = names.includes(MEMORY_FILENAME);
			const hasIndex = names.includes(INDEX_FILENAME);
			const additions = Number(!hasMemory) + Number(!hasIndex);
			if (names.length > MAX_MANAGED_DOCUMENTS || names.length + additions > MAX_MANAGED_DOCUMENTS) {
				throw new RsiError(
					"DOCUMENT_COUNT_LIMIT",
					`At most ${MAX_MANAGED_DOCUMENTS} managed Markdown files are allowed.`,
				);
			}
			if (!initialize && (!hasMemory || !hasIndex)) {
				throw new RsiError(
					"DOCUMENT_NOT_FOUND",
					"Managed knowledge initialization is disabled and Memory.md or index.md is missing.",
				);
			}
			// Validate pre-existing documents before creating anything, so a bad
			// startup Memory fails closed without any write or truncation.
			for (const name of names) {
				await this.readSnapshotLocked(name);
			}
			if (!hasMemory) {
				await this.commitLocked({
					name: MEMORY_FILENAME,
					content: "",
					expectedRevision: null,
					operation: "memory",
					allowMissingCreate: true,
					audit: false,
				});
			}
			if (!hasIndex) {
				// Do not invent descriptions for files that already existed. Memory.md
				// is listed only when this transaction created the initial empty one.
				const content = createInitialIndexContent({
					includeMemory: !hasMemory,
				});
				await this.commitLocked({
					name: INDEX_FILENAME,
					content,
					expectedRevision: null,
					operation: "write",
					allowMissingCreate: true,
					audit: false,
				});
			}
			await this.validateAllManagedDocumentsLocked();
		});
		await this.readStats.counts(this.clock.now());
		await assertDirectoryIdentity(this.root, "markdownsDir");
	}

	private async validateAllManagedDocumentsLocked(): Promise<void> {
		const names = (await listManagedMarkdownNames(this.root.realPath)).names;
		if (names.length > MAX_MANAGED_DOCUMENTS) {
			throw new RsiError(
				"DOCUMENT_COUNT_LIMIT",
				`At most ${MAX_MANAGED_DOCUMENTS} managed Markdown files are allowed; found ${names.length}.`,
				{ details: { count: names.length, max: MAX_MANAGED_DOCUMENTS } },
			);
		}
		for (const name of names) {
			await this.readSnapshotLocked(name);
		}
	}

	private async readSnapshotLocked(name: string): Promise<ManagedDocumentSnapshot> {
		assertManagedDocumentName(name);
		const path = join(this.root.realPath, name);
		const read = await readRegularFileStrict(path, name);
		if (!read) throw new RsiError("DOCUMENT_NOT_FOUND", `Managed Markdown does not exist: ${name}`);
		assertCommittableText(read.text, name);
		const words = assertWordCount(name, read.text, name);
		return {
			name,
			content: read.text,
			words,
			revision: sha256Bytes(read.bytes),
			mtimeMs: read.mtimeMs,
		};
	}

	private async readOptionalSnapshotLocked(name: string): Promise<ManagedDocumentSnapshot | undefined> {
		assertManagedDocumentName(name);
		const read = await readRegularFileStrict(join(this.root.realPath, name), name, {
			allowMissing: true,
		});
		if (!read) return undefined;
		assertCommittableText(read.text, name);
		const words = assertWordCount(name, read.text, name);
		return {
			name,
			content: read.text,
			words,
			revision: sha256Bytes(read.bytes),
			mtimeMs: read.mtimeMs,
		};
	}

	private async auditNow(): Promise<KnowledgeIndexAudit> {
		const names = (await listManagedMarkdownNames(this.root.realPath)).names;
		const indexRead = await readRegularFileStrict(join(this.root.realPath, INDEX_FILENAME), INDEX_FILENAME, {
			allowMissing: true,
		});
		if (indexRead) assertCommittableText(indexRead.text, INDEX_FILENAME);
		const content = indexRead?.text ?? "";
		const audit = auditKnowledgeIndex(content, names);
		if (!indexRead) {
			return {
				...audit,
				warnings: [`Index file is missing: ${INDEX_FILENAME}`, ...audit.warnings],
				consistent: false,
			};
		}
		return audit;
	}

	private indexWarningsFor(audit: KnowledgeIndexAudit): readonly string[] {
		return audit.consistent ? [] : [...audit.warnings];
	}

	private async safeIndexWarnings(): Promise<readonly string[]> {
		try {
			return this.indexWarningsFor(await this.auditNow());
		} catch (error) {
			const message = error instanceof Error && error.message.length > 0 ? error.message : "unknown error";
			const sanitized = message.split(String.fromCharCode(13)).join(" ").split(String.fromCharCode(10)).join(" ");
			return [`Could not audit managed knowledge: ${sanitized}`];
		}
	}

	private async commitLocked(input: {
		readonly name: string;
		readonly content: string;
		readonly expectedRevision: string | null;
		readonly operation: DocumentOperation;
		readonly allowMissingCreate?: boolean;
		readonly audit?: boolean;
	}): Promise<DocumentMutationResult> {
		const name = assertManagedDocumentName(input.name);
		assertOperation(input.operation);
		assertExpectedRevisionValue(input.expectedRevision);
		if (input.operation === "memory" && name !== MEMORY_FILENAME) {
			throw new RsiError("DOCUMENT_NAME_INVALID", "The memory operation is only valid for Memory.md.");
		}
		assertCommittableText(input.content, name);

		const existing = await this.readOptionalSnapshotLocked(name);
		const names = (await listManagedMarkdownNames(this.root.realPath)).names;
		if (names.length > MAX_MANAGED_DOCUMENTS) {
			throw new RsiError(
				"DOCUMENT_COUNT_LIMIT",
				`At most ${MAX_MANAGED_DOCUMENTS} managed Markdown files are allowed; found ${names.length}.`,
				{ details: { count: names.length, max: MAX_MANAGED_DOCUMENTS } },
			);
		}
		if (existing === undefined) {
			if (!input.allowMissingCreate && input.expectedRevision !== null) {
				throw new RsiError(conflictCode(name), `${name} was removed before the commit.`);
			}
			if (!names.includes(name) && names.length >= MAX_MANAGED_DOCUMENTS) {
				throw new RsiError(
					"DOCUMENT_COUNT_LIMIT",
					`At most ${MAX_MANAGED_DOCUMENTS} managed Markdown files are allowed.`,
					{ details: { count: names.length, max: MAX_MANAGED_DOCUMENTS } },
				);
			}
		} else if (input.expectedRevision === null) {
			throw new RsiError(
				conflictCode(name),
				`${name} already exists; a non-null expected revision is required to replace it.`,
				{ details: { actual: existing.revision } },
			);
		} else if (input.expectedRevision !== existing.revision) {
			throw new RsiError(conflictCode(name), `${name} changed before the commit.`, {
				details: { expected: input.expectedRevision, actual: existing.revision },
			});
		}

		const words = assertWordCount(name, input.content, name);
		const staged = await stageFile(this.root.realPath, input.content, { mode: 0o644 });
		try {
			const stagedRead = await readRegularFileStrict(staged.path, "staged knowledge document");
			if (!stagedRead) throw new RsiError("INTERNAL", "Staged knowledge document disappeared.");
			assertCommittableText(stagedRead.text, "staged knowledge document");
			assertWordCount(name, stagedRead.text, "staged knowledge document");
			if (!stagedRead.bytes.equals(staged.bytes)) {
				throw new RsiError("INTERNAL", "Staged knowledge document verification failed.");
			}

			const current = await this.readOptionalSnapshotLocked(name);
			if (existing === undefined) {
				if (current !== undefined) {
					throw new RsiError(conflictCode(name), `${name} was created concurrently.`);
				}
			} else if (current === undefined || current.revision !== input.expectedRevision) {
				throw new RsiError(conflictCode(name), `${name} changed concurrently before commit.`);
			}
			await assertDirectoryIdentity(this.root, "markdownsDir");
			await commitStagedFile(staged, join(this.root.realPath, name), this.root.realPath);
		} catch (error) {
			await removeStagedFile(staged);
			throw error;
		}

		await assertDirectoryIdentity(this.root, "markdownsDir");
		const committed = await this.readSnapshotLocked(name);
		const expectedCommittedRevision = sha256Text(input.content);
		if (committed.revision !== expectedCommittedRevision) {
			throw new RsiError("INTERNAL", `${name} revision does not match the verified staged bytes.`);
		}
		const indexWarnings = input.audit === false ? [] : await this.safeIndexWarnings();
		return {
			name,
			revision: committed.revision,
			words,
			created: existing === undefined,
			...(name === MEMORY_FILENAME ? { memoryUsage: formatMemoryUsage(words) } : {}),
			indexWarnings,
			committedAtMs: this.clock.now().getTime(),
		};
	}

	private memorySnapshotWithUsage(snapshot: ManagedDocumentSnapshot): AuthoritativeMemorySnapshot {
		if (snapshot.words > MEMORY_MAX_WORDS) {
			throw new RsiError(
				"MEMORY_WORD_LIMIT",
				`Memory.md exceeds ${MEMORY_MAX_WORDS} words; refusing to serve an unsafe Memory.`,
			);
		}
		return {
			name: MEMORY_FILENAME,
			content: snapshot.content,
			words: snapshot.words,
			maxWords: MEMORY_MAX_WORDS,
			revision: snapshot.revision,
			updatedAtMs: Math.trunc(snapshot.mtimeMs),
			version: snapshot.revision,
			usage: formatMemoryUsage(snapshot.words),
		};
	}

	async readCurrentMemory(signal?: AbortSignal): Promise<AuthoritativeMemorySnapshot> {
		if (signal?.aborted) throw new RsiError("INTERNAL", "Memory read aborted.");
		await assertDirectoryIdentity(this.root, "markdownsDir");
		return this.memorySnapshotWithUsage(await this.readSnapshotLocked(MEMORY_FILENAME));
	}

	async getMemory(signal?: AbortSignal): Promise<AuthoritativeMemorySnapshot> {
		return this.readCurrentMemory(signal);
	}

	async commitMemory(
		input: { readonly content: string; readonly expectedRevision: ContentRevision },
		signal?: AbortSignal,
	): Promise<{ readonly snapshot: AuthoritativeMemorySnapshot; readonly usage: string }> {
		if (signal?.aborted) throw new RsiError("INTERNAL", "Memory commit aborted.");
		if (!isRecord(input) || typeof input.content !== "string" || typeof input.expectedRevision !== "string") {
			throw new RsiError("MEMORY_REVISION_CONFLICT", "Memory commit requires content and expectedRevision.");
		}
		const committed = await this.withMutationLock(async () => {
			const result = await this.commitLocked({
				name: MEMORY_FILENAME,
				content: input.content,
				expectedRevision: input.expectedRevision,
				operation: "memory",
			});
			const snapshot = await this.readSnapshotLocked(MEMORY_FILENAME);
			return { result, snapshot: this.memorySnapshotWithUsage(snapshot) };
		});
		if (committed.snapshot.revision !== committed.result.revision) {
			throw new RsiError("INTERNAL", "Memory commit snapshot revision changed unexpectedly.");
		}
		return { snapshot: committed.snapshot, usage: formatMemoryUsage(committed.result.words) };
	}

	async list(): Promise<readonly ManagedDocumentSummary[]> {
		await assertDirectoryIdentity(this.root, "markdownsDir");
		const names = (await listManagedMarkdownNames(this.root.realPath)).names;
		const summaries: ManagedDocumentSummary[] = [];
		for (const name of names) {
			const snapshot = await this.readSnapshotLocked(name);
			summaries.push({
				name,
				words: snapshot.words,
				revision: snapshot.revision,
				mtimeMs: snapshot.mtimeMs,
			});
		}
		return summaries;
	}

	async read(name: string): Promise<ManagedDocumentSnapshot> {
		await assertDirectoryIdentity(this.root, "markdownsDir");
		const inspection = await inspectManagedMarkdownPath(this.root.realPath, name);
		return this.readSnapshotLocked(inspection.relativeName);
	}

	/**
	 * Request-time tool view. index.md rows gain word count, real mtime and
	 * rolling 24-hour read statistics without modifying the source file.
	 */
	async readForTool(name: string, now: Date): Promise<ManagedDocumentSnapshot> {
		const snapshot = await this.read(name);
		if (snapshot.name !== INDEX_FILENAME) {
			return { ...snapshot, viewContent: snapshot.content };
		}
		return {
			...snapshot,
			viewContent: await this.annotateIndexContent(snapshot.content, now, { pendingRead: snapshot.name }),
		};
	}

	async commit(request: DocumentCommitRequest): Promise<DocumentMutationResult> {
		if (!isRecord(request)) throw new RsiError("INTERNAL", "Document commit request must be an object.");
		return this.withMutationLock(() =>
			this.commitLocked({
				name: request.name,
				content: request.content,
				expectedRevision: request.expectedRevision,
				operation: request.operation,
			}),
		);
	}

	/** Write tool semantics: overwrite the latest committed bytes under one lock. */
	async overwriteLatest(name: string, content: string): Promise<DocumentMutationResult> {
		return this.withMutationLock(async () => {
			const existing = await this.readOptionalSnapshotLocked(name);
			return this.commitLocked({
				name,
				content,
				expectedRevision: existing?.revision ?? null,
				operation: "write",
				allowMissingCreate: true,
			});
		});
	}

	async replaceDocument(name: string, content: string, expectedRevision: string | null): Promise<DocumentMutationResult> {
		return this.commit({
			name,
			content,
			expectedRevision,
			operation: "write",
		});
	}

	/** Native edit semantics on a locked, in-memory staging copy, then one atomic commit. */
	async editDocument(
		name: string,
		edits: readonly NativeEdit[],
		expectedRevision: string,
	): Promise<ManagedEditResult> {
		assertManagedDocumentName(name);
		if (!Array.isArray(edits) || edits.length === 0) {
			throw new RsiError("INTERNAL", "Edit requires at least one replacement.");
		}
		for (const edit of edits) {
			if (
				!isRecord(edit) ||
				typeof edit.oldText !== "string" ||
				typeof edit.newText !== "string"
			) {
				throw new RsiError("INTERNAL", "Edit replacements require string oldText and newText.");
			}
		}
		return this.withMutationLock(async () => {
			const existing = await this.readSnapshotLocked(name);
			if (expectedRevision !== existing.revision) {
				throw new RsiError(conflictCode(name), `${name} changed before the edit.`, {
					details: { expected: expectedRevision, actual: existing.revision },
				});
			}
			let stagedContent: string | undefined;
			const definition = createEditToolDefinition(this.root.realPath, {
				operations: {
					access: async () => {
						await this.readSnapshotLocked(name);
					},
					readFile: async () => Buffer.from(existing.content, "utf8"),
					writeFile: async (_path, content) => {
						stagedContent = content;
					},
				},
			});
			const result = await definition.execute(
				"knowledge-edit",
				{
					path: join(this.root.realPath, name),
					edits: edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText })),
				},
				undefined,
				undefined,
				{ cwd: this.root.realPath } as never,
			);
			if (stagedContent === undefined) {
				throw new RsiError("INTERNAL", "Native edit semantics produced no staged content.");
			}
			const mutation = await this.commitLocked({
				name,
				content: stagedContent,
				expectedRevision,
				operation: "edit",
			});
			return { ...mutation, details: result.details };
		});
	}

	async deleteDocument(name: string, expectedRevision: string): Promise<ManagedDeleteResult> {
		assertManagedDocumentName(name);
		if (name === MEMORY_FILENAME || name === INDEX_FILENAME) {
			throw new RsiError("DOCUMENT_NAME_INVALID", `${name} is required and cannot be deleted.`);
		}
		return this.withMutationLock(async () => {
			const existing = await this.readSnapshotLocked(name);
			if (expectedRevision !== existing.revision) {
				throw new RsiError(conflictCode(name), `${name} changed before deletion.`, {
					details: { expected: expectedRevision, actual: existing.revision },
				});
			}
			await assertDirectoryIdentity(this.root, "markdownsDir");
			const inspection = await inspectManagedMarkdownPath(this.root.realPath, name);
			await unlink(inspection.absolutePath);
			return {
				name,
				deleted: true,
				committedAtMs: this.clock.now().getTime(),
				indexWarnings: await this.safeIndexWarnings(),
			};
		});
	}

	async renameDocument(from: string, to: string, expectedRevision: string): Promise<ManagedRenameResult> {
		assertManagedDocumentName(from);
		assertManagedDocumentName(to);
		if (from === MEMORY_FILENAME || from === INDEX_FILENAME || to === MEMORY_FILENAME || to === INDEX_FILENAME) {
			throw new RsiError("DOCUMENT_NAME_INVALID", "Memory.md and index.md cannot be renamed.");
		}
		if (dirname(join(this.root.realPath, from)) !== dirname(join(this.root.realPath, to))) {
			throw new RsiError("DOCUMENT_NAME_INVALID", "Cross-directory rename is not allowed.");
		}
		return this.withMutationLock(async () => {
			const names = (await listManagedMarkdownNames(this.root.realPath)).names;
			if (names.length > MAX_MANAGED_DOCUMENTS) {
				throw new RsiError(
					"DOCUMENT_COUNT_LIMIT",
					`At most ${MAX_MANAGED_DOCUMENTS} managed Markdown files are allowed; found ${names.length}.`,
					{ details: { count: names.length, max: MAX_MANAGED_DOCUMENTS } },
				);
			}
			const existing = await this.readSnapshotLocked(from);
			if (expectedRevision !== existing.revision) {
				throw new RsiError(conflictCode(from), `${from} changed before rename.`, {
					details: { expected: expectedRevision, actual: existing.revision },
				});
			}
			const targetInspection = await inspectManagedMarkdownPath(this.root.realPath, to, {
				allowMissing: true,
			});
			if (targetInspection.exists) {
				throw new RsiError(conflictCode(to), `Rename target already exists: ${to}`);
			}
			await assertDirectoryIdentity(this.root, "markdownsDir");
			await rename(join(this.root.realPath, from), targetInspection.absolutePath);
			await assertDirectoryIdentity(this.root, "markdownsDir");
			const committed = await this.readSnapshotLocked(to);
			if (committed.revision !== existing.revision) {
				throw new RsiError("INTERNAL", "Rename changed document bytes unexpectedly.");
			}
			return {
				name: to,
				from,
				to,
				revision: committed.revision,
				words: committed.words,
				created: false,
				indexWarnings: await this.safeIndexWarnings(),
				committedAtMs: this.clock.now().getTime(),
			};
		});
	}

	async indexReport(now: Date): Promise<IndexReadReport> {
		await assertDirectoryIdentity(this.root, "markdownsDir");
		const names = (await listManagedMarkdownNames(this.root.realPath)).names;
		const counts = await this.readStats.counts(now);
		const stats: ManagedDocumentStat[] = [];
		for (const name of names) {
			const snapshot = await this.readSnapshotLocked(name);
			stats.push({
				name,
				words: snapshot.words,
				mtimeMs: snapshot.mtimeMs,
				readsLast24h: counts.get(name) ?? 0,
			});
		}
		const audit = await this.auditNow();
		return {
			generatedAtMs: now.getTime(),
			stats,
			consistency: toIndexConsistency(audit),
			reportText: renderIndexReadReport(stats, now, this.timeZone),
		};
	}

	async consistency(): Promise<IndexConsistency> {
		await assertDirectoryIdentity(this.root, "markdownsDir");
		return toIndexConsistency(await this.auditNow());
	}

	async auditIndex(): Promise<KnowledgeIndexAudit> {
		await assertDirectoryIdentity(this.root, "markdownsDir");
		return this.auditNow();
	}

	async recordRead(name: string, at: Date): Promise<number> {
		assertManagedDocumentName(name);
		await assertDirectoryIdentity(this.root, "markdownsDir");
		const inspection = await inspectManagedMarkdownPath(this.root.realPath, name);
		if (!inspection.exists) throw new RsiError("DOCUMENT_NOT_FOUND", `Managed Markdown does not exist: ${name}`);
		return this.readStats.record(name, at);
	}

	async readStatsCounts(now: Date): Promise<ReadonlyMap<string, number>> {
		return this.readStats.counts(now);
	}

	/** Annotate index rows only in the returned view; the source text stays untouched. */
	async annotateIndexContent(
		content: string,
		now: Date,
		options: { readonly pendingRead?: string } = {},
	): Promise<string> {
		const names = (await listManagedMarkdownNames(this.root.realPath)).names;
		const actual = new Set(names);
		const audit = auditKnowledgeIndex(content, names);
		const counts = new Map(await this.readStats.counts(now));
		if (options.pendingRead !== undefined) {
			counts.set(options.pendingRead, (counts.get(options.pendingRead) ?? 0) + 1);
		}
		const stats = new Map<string, { words: number; mtimeMs: number }>();
		for (const row of audit.rows) {
			if (row.target === undefined || !actual.has(row.target) || stats.has(row.target)) continue;
			try {
				const snapshot = await this.readSnapshotLocked(row.target);
				stats.set(row.target, { words: snapshot.words, mtimeMs: snapshot.mtimeMs });
			} catch {
				// A broken or unsafe target remains an index warning, not a fabricated statistic.
			}
		}
		const lines = content.split("\n");
		for (const row of audit.rows) {
			if (row.target === undefined) continue;
			const stat = stats.get(row.target);
			if (!stat) continue;
			const lineIndex = row.line - 1;
			const line = lines[lineIndex];
			if (line === undefined) continue;
			const hadCr = line.endsWith("\r");
			const body = hadCr ? line.slice(0, -1) : line;
			const metadata = ` [System Meta: Words: ${stat.words}; MTime: ${formatTimestamp(
				Math.floor(stat.mtimeMs / 1_000) * 1_000,
				this.timeZone,
			)}; Reads24h: ${counts.get(row.target) ?? 0}]`;
			lines[lineIndex] = `${appendAfterLocationLink(body, row.location, metadata)}${hadCr ? "\r" : ""}`;
		}
		return lines.join("\n");
	}

	/** Raw bytes for edit. The index annotation is intentionally excluded. */
	async readBytesForManagedTool(name: string): Promise<Buffer> {
		const snapshot = await this.read(name);
		return Buffer.from(snapshot.content, "utf8");
	}

	/** Bytes for the native read tool. index.md gets its per-row request-time metadata. */
	async readBytesForNativeRead(name: string, now: Date): Promise<Buffer> {
		const snapshot = await this.read(name);
		if (snapshot.name !== INDEX_FILENAME) return Buffer.from(snapshot.content, "utf8");
		return Buffer.from(
			await this.annotateIndexContent(snapshot.content, now, { pendingRead: snapshot.name }),
			"utf8",
		);
	}

	async readManagedDocument(name: string, options: ManagedReadOptions = {}): Promise<ManagedReadResult> {
		const snapshot = await this.read(name);
		const now = options.now ?? this.clock.now();
		const viewContent =
			snapshot.name === INDEX_FILENAME
				? await this.annotateIndexContent(snapshot.content, now, {
						...(options.recordRead === false ? {} : { pendingRead: snapshot.name }),
					})
				: snapshot.content;
		const definition = createReadToolDefinition(this.root.realPath, {
			operations: {
				access: async () => {},
				readFile: async () => Buffer.from(viewContent, "utf8"),
			},
		});
		const result = await definition.execute(
			"knowledge-read",
			{
				path: join(this.root.realPath, snapshot.name),
				...(options.offset === undefined ? {} : { offset: options.offset }),
				...(options.limit === undefined ? {} : { limit: options.limit }),
			},
			undefined,
			undefined,
			{ cwd: this.root.realPath } as never,
		);
		const readsLast24h =
			options.recordRead === false ? await this.readStats.count(name, now) : await this.recordRead(name, now);
		return {
			name,
			snapshot,
			content: result.content,
			details: result.details,
			structuredContent: result.structuredContent,
			readsLast24h,
		};
	}

	async resolveManagedToolPath(inputPath: string, cwd: string): Promise<ManagedToolPath> {
		const decision = await classifyManagedToolPathAgainstRoot(this.root, inputPath, cwd);
		if (!decision.managed) {
			throw new RsiError("PATH_OUTSIDE_ROOT", "The knowledge broker only accepts managed Markdown paths.");
		}
		return decision;
	}

	async assertManagedDirectoryRoot(directory: string): Promise<void> {
		await assertManagedDirectoryRoot(this.root, directory);
	}

	async assertManagedExists(name: string): Promise<void> {
		await this.read(name);
	}

	async decodeManagedBytesForTool(bytes: Uint8Array, name: string): Promise<string> {
		assertManagedDocumentName(name);
		return decodeUtf8Strict(bytes, name);
	}
}

export function createKnowledgeService(options: KnowledgeServiceOptions): Promise<KnowledgeService> {
	return KnowledgeService.open(options);
}
