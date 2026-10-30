import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import {
	access as fsAccess,
	mkdir as fsMkdir,
	readFile as fsReadFile,
	realpath,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ReadOperations, WriteOperations, EditOperations } from "@earendil-works/pi-coding-agent";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import type { NativeToolOperationsPort } from "../shared/ports.ts";
import type { DocumentStorePort } from "../shared/ports.ts";
import { RsiError, isRsiError } from "../shared/errors.ts";
import { formatMemoryUsage, MEMORY_MAX_WORDS } from "../shared/memory.ts";
import { INDEX_FILENAME, MEMORY_FILENAME } from "../shared/paths.ts";
import { inspectManagedMarkdownPath, assertManagedDocumentName } from "../shared/managed-path.ts";
import { isPathWithin } from "../shared/paths.ts";

export interface ManagedMarkdownTarget {
	readonly name: string;
	readonly absolutePath: string;
	readonly exists: boolean;
}

export interface ManagedReadTarget {
	readonly name: string;
	readonly indexRead: boolean;
}

interface PendingMemoryUsage {
	readonly usage: string;
	readonly absolutePath: string;
}

/**
 * Route the native read/write/edit operation interfaces to the external document
 * broker for direct Markdown children of markdownsDir, and to the native local
 * filesystem implementation for every other path.
 *
 * The tools themselves are still Pi's native definitions; only their I/O operations
 * are replaced. Truncation, image handling, structured content, details, and edit
 * diff semantics therefore stay in Pi.
 */
export class ManagedToolRuntime {
	readonly operations: NativeToolOperationsPort;
	private readonly rootRealPath: string;
	private readonly cwd: string;
	private readonly documents: DocumentStorePort;
	private readonly revisions = new Map<string, string>();
	private readonly pendingMemory = new Map<string, PendingMemoryUsage>();
	private readonly activeToolCall = new AsyncLocalStorage<string>();

	private constructor(input: {
		rootRealPath: string;
		cwd: string;
		documents: DocumentStorePort;
	}) {
		this.rootRealPath = input.rootRealPath;
		this.cwd = input.cwd;
		this.documents = input.documents;

		const read: ReadOperations = {
			readFile: async (absolutePath) => {
				const target = await this.managedTarget(absolutePath);
				if (!target) return await fsReadFile(absolutePath);
				const snapshot = this.documents.readForTool
					? await this.documents.readForTool(target.name, new Date())
					: await this.documents.read(target.name);
				this.revisions.set(target.absolutePath, snapshot.revision);
				return Buffer.from(snapshot.viewContent ?? snapshot.content, "utf8");
			},
			access: async (absolutePath) => {
				const target = await this.managedTarget(absolutePath);
				if (!target) {
					await fsAccess(absolutePath, constants.R_OK);
					return;
				}
				const snapshot = await this.documents.read(target.name);
				this.revisions.set(target.absolutePath, snapshot.revision);
			},
			detectImageMimeType: async (absolutePath) => {
				const target = await this.managedTarget(absolutePath);
				if (target) return undefined;
				return await detectSupportedImageMimeTypeFromFile(absolutePath);
			},
		};

		const write: WriteOperations = {
			mkdir: async (dir) => {
				const resolved = resolve(dir);
				if (resolved === this.rootRealPath || isPathWithin(this.rootRealPath, resolved)) {
					const relative = resolved.slice(this.rootRealPath.length);
					if (relative.length > 0) {
						throw new RsiError(
							"PATH_OUTSIDE_ROOT",
							"Managed Markdown is a flat namespace; nested directories are not allowed.",
						);
					}
					return;
				}
				await fsMkdir(dir, { recursive: true });
			},
			writeFile: async (absolutePath, content) => {
				const target = await this.managedTarget(absolutePath);
				if (!target) {
					await fsWriteFile(absolutePath, content, "utf-8");
					return;
				}
				const expectedRevision = await this.currentRevision(target);
				const result = await this.documents.commit({
					name: target.name,
					content,
					expectedRevision,
					operation: "write",
				});
				this.revisions.set(target.absolutePath, result.revision);
				this.rememberMemoryUsage(target, result.memoryUsage, result.words);
			},
		};

		const edit: EditOperations = {
			readFile: async (absolutePath) => {
				const target = await this.managedTarget(absolutePath);
				if (!target) return await fsReadFile(absolutePath);
				const snapshot = await this.documents.read(target.name);
				this.revisions.set(target.absolutePath, snapshot.revision);
				return Buffer.from(snapshot.content, "utf8");
			},
			writeFile: async (absolutePath, content) => {
				const target = await this.managedTarget(absolutePath);
				if (!target) {
					await fsWriteFile(absolutePath, content, "utf-8");
					return;
				}
				const expectedRevision =
					this.revisions.get(target.absolutePath) ?? (await this.currentRevision(target));
				const result = await this.documents.commit({
					name: target.name,
					content,
					expectedRevision,
					operation: "edit",
				});
				this.revisions.set(target.absolutePath, result.revision);
				this.rememberMemoryUsage(target, result.memoryUsage, result.words);
			},
			access: async (absolutePath) => {
				const target = await this.managedTarget(absolutePath);
				if (!target) {
					await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
					return;
				}
				const snapshot = await this.documents.read(target.name);
				this.revisions.set(target.absolutePath, snapshot.revision);
			},
		};

		this.operations = { read, write, edit };
	}

	static async create(input: {
		markdownsDir: string;
		cwd: string;
		documents: DocumentStorePort;
	}): Promise<ManagedToolRuntime> {
		const rootRealPath = await realpath(input.markdownsDir).catch((error: unknown) => {
			throw new RsiError("PATH_INVALID", "markdownsDir must exist and be accessible.", { cause: error });
		});
		return new ManagedToolRuntime({
			rootRealPath,
			cwd: resolve(input.cwd),
			documents: input.documents,
		});
	}

	get markdownsRoot(): string {
		return this.rootRealPath;
	}

	/**
	 * Resolve a managed direct Markdown child, or null for an ordinary file.
	 *
	 * The native read/write/edit tools receive paths that can contain a symlink
	 * or Windows junction in a writable workspace. Lexical containment alone
	 * would let such an alias bypass the broker entirely. Canonicalize the file,
	 * or its parent for a not-yet-created write target, before deciding whether
	 * the operation belongs to the managed Markdown namespace.
	 */
	async targetForPath(absolutePath: string): Promise<ManagedMarkdownTarget | null> {
		const resolved = isAbsolute(absolutePath) ? resolve(absolutePath) : resolve(this.cwd, absolutePath);
		if (!resolved.toLowerCase().endsWith(".md")) return null;

		let candidate = resolved;
		let canonical: string | null = null;
		try {
			canonical = await realpath(resolved);
		} catch {
			// A write may target a new file below an existing (possibly aliased) parent.
			const parent = await realpath(dirname(resolved)).catch(() => null);
			if (parent !== null) candidate = join(parent, basename(resolved));
		}
		if (canonical !== null) candidate = canonical;
		if (isPathWithin(this.rootRealPath, resolved) && !isPathWithin(this.rootRealPath, candidate)) {
			throw new RsiError(
				"PATH_OUTSIDE_ROOT",
				"Managed Markdown must not alias a path outside the managed root.",
			);
		}

		if (!isPathWithin(this.rootRealPath, candidate)) return null;
		if (resolve(dirname(candidate)) !== resolve(this.rootRealPath)) {
			throw new RsiError(
				"DOCUMENT_NAME_INVALID",
				"Managed Markdown is a flat namespace; nested paths or aliases to nested paths are not allowed.",
			);
		}
		const name = basename(candidate);
		assertManagedDocumentName(name);
		const inspection = await inspectManagedMarkdownPath(this.rootRealPath, name, {
			allowMissing: true,
		});
		return {
			name,
			absolutePath: inspection.absolutePath,
			exists: inspection.exists,
		};
	}

	/** Classify a successful native read for decoration. Never throws for ordinary paths. */
	async classifyRead(pathInput: unknown): Promise<ManagedReadTarget | null> {
		if (typeof pathInput !== "string" || pathInput.length === 0) return null;
		try {
			const target = await this.targetForPath(pathInput);
			if (!target?.exists) return null;
			return { name: target.name, indexRead: target.name === INDEX_FILENAME };
		} catch {
			return null;
		}
	}

	/**
	 * Run a native tool operation in the toolCallId's async context, so
	 * concurrent Memory writes cannot overwrite each other's pending usage.
	 */
	async runInToolCall<T>(toolCallId: string, operation: () => T | Promise<T>): Promise<T> {
		return await this.activeToolCall.run(toolCallId, operation);
	}

	/** Consume the Memory usage metadata produced by this exact write/edit result. */
	takeMemoryUsage(
		toolName: string,
		input: Readonly<Record<string, unknown>>,
		isError: boolean,
		toolCallId?: string,
	): string | undefined {
		if (isError || (toolName !== "write" && toolName !== "edit")) return undefined;
		if (toolCallId !== undefined) {
			const pending = this.pendingMemory.get(toolCallId);
			if (pending !== undefined) {
				this.pendingMemory.delete(toolCallId);
				return pending.usage;
			}
		}
		const path = input.path;
		if (typeof path !== "string") return undefined;
		const absolutePath = isAbsolute(path) ? resolve(path) : resolve(this.cwd, path);
		for (const [name, pending] of this.pendingMemory) {
			if (pending.absolutePath !== absolutePath) continue;
			this.pendingMemory.delete(name);
			return pending.usage;
		}
		return undefined;
	}

	private async managedTarget(absolutePath: string): Promise<ManagedMarkdownTarget | null> {
		return await this.targetForPath(absolutePath);
	}

	private async currentRevision(target: ManagedMarkdownTarget): Promise<string | null> {
		try {
			const snapshot = await this.documents.read(target.name);
			this.revisions.set(target.absolutePath, snapshot.revision);
			return snapshot.revision;
		} catch (error) {
			if (isRsiError(error) && error.code === "DOCUMENT_NOT_FOUND") return null;
			throw error;
		}
	}

	private rememberMemoryUsage(
		target: ManagedMarkdownTarget,
		memoryUsage: string | undefined,
		words: number,
	): void {
		if (target.name !== MEMORY_FILENAME) return;
		const key = this.activeToolCall.getStore() ?? target.name;
		this.pendingMemory.set(key, {
			usage: memoryUsage ?? formatMemoryUsage(words, MEMORY_MAX_WORDS),
			absolutePath: target.absolutePath,
		});
		if (this.pendingMemory.size > 2_000) {
			const first = this.pendingMemory.keys().next().value;
			if (first !== undefined) this.pendingMemory.delete(first);
		}
	}
}
