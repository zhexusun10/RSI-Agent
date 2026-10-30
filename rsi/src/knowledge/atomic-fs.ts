import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { RsiError } from "../shared/errors.ts";
import { isPathWithin } from "../shared/paths.ts";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const LOCK_POLL_MS = 10;

export interface DirectoryIdentity {
	readonly configuredPath: string;
	readonly realPath: string;
	readonly dev: number;
	readonly ino: number;
}

/** Validate a canonical managed root and remember its filesystem identity. */
export async function captureDirectoryIdentity(
	directory: string,
	label: string,
): Promise<DirectoryIdentity> {
	const configuredPath = resolve(directory);
	const info = await lstat(configuredPath).catch((error: unknown) => {
		throw new RsiError("PATH_INVALID", `${label} does not exist or is not accessible.`, { cause: error });
	});
	if (info.isSymbolicLink()) {
		throw new RsiError("PATH_SYMLINK_FORBIDDEN", `${label} must not be a symlink.`);
	}
	if (!info.isDirectory()) {
		throw new RsiError("PATH_INVALID", `${label} must be a directory.`);
	}
	const realPath = await realpath(configuredPath);
	const realInfo = await stat(realPath);
	return { configuredPath, realPath, dev: realInfo.dev, ino: realInfo.ino };
}

/** Fail closed if the directory was deleted, replaced, or rebound to another mount. */
export async function assertDirectoryIdentity(identity: DirectoryIdentity, label: string): Promise<void> {
	const info = await lstat(identity.configuredPath).catch((error: unknown) => {
		throw new RsiError("PATH_INVALID", `${label} disappeared while knowledge is in use.`, { cause: error });
	});
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new RsiError("PATH_INVALID", `${label} is no longer a canonical directory.`);
	}
	const currentRealPath = await realpath(identity.configuredPath).catch((error: unknown) => {
		throw new RsiError("PATH_INVALID", `${label} cannot be canonicalized.`, { cause: error });
	});
	const current = await stat(currentRealPath).catch((error: unknown) => {
		throw new RsiError("PATH_INVALID", `${label} cannot be statted.`, { cause: error });
	});
	if (
		currentRealPath !== identity.realPath ||
		current.dev !== identity.dev ||
		current.ino !== identity.ino
	) {
		throw new RsiError("PATH_INVALID", `${label} was replaced or remounted.`, {
			details: {
				expectedRealPath: identity.realPath,
				actualRealPath: currentRealPath,
				expectedDev: identity.dev,
				actualDev: current.dev,
				expectedIno: identity.ino,
				actualIno: current.ino,
			},
		});
	}
}

export function decodeUtf8Strict(bytes: Uint8Array, label: string): string {
	try {
		return UTF8_DECODER.decode(bytes);
	} catch (error) {
		throw new RsiError("INTERNAL", `${label} is not valid UTF-8.`, { cause: error });
	}
}

export function assertCommittableText(content: string, label: string): void {
	if (typeof content !== "string") {
		throw new RsiError("INTERNAL", `${label} content must be a string.`);
	}
	if (content.includes("\u0000")) {
		throw new RsiError("INTERNAL", `${label} content contains NUL.`);
	}
	if (typeof content.isWellFormed === "function" && !content.isWellFormed()) {
		throw new RsiError("INTERNAL", `${label} content contains an unpaired UTF-16 surrogate.`);
	}
	const roundTrip = Buffer.from(content, "utf8").toString("utf8");
	if (roundTrip !== content) {
		throw new RsiError("INTERNAL", `${label} content cannot be encoded as UTF-8 losslessly.`);
	}
}

export interface RegularFileRead {
	readonly bytes: Buffer;
	readonly text: string;
	readonly mtimeMs: number;
	readonly nlink: number;
}

/** Read a regular, single-link file with strict UTF-8 decoding. Missing returns undefined. */
export async function readRegularFileStrict(
	absolutePath: string,
	label: string,
	options: { allowMissing?: boolean } = {},
): Promise<RegularFileRead | undefined> {
	const info = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" && options.allowMissing) return undefined;
		throw new RsiError("DOCUMENT_NOT_FOUND", `${label} does not exist.`, { cause: error });
	});
	if (info === undefined) return undefined;
	if (info.isSymbolicLink()) {
		throw new RsiError("PATH_SYMLINK_FORBIDDEN", `${label} must not be a symlink.`);
	}
	if (!info.isFile()) {
		throw new RsiError("PATH_NOT_FILE", `${label} must be a regular file.`);
	}
	if (info.nlink !== 1) {
		throw new RsiError("PATH_HARDLINK_FORBIDDEN", `${label} must have exactly one hardlink.`, {
			details: { nlink: info.nlink },
		});
	}
	const targetRealPath = await realpath(absolutePath).catch((error: unknown) => {
		throw new RsiError("PATH_INVALID", `${label} cannot be canonicalized.`, { cause: error });
	});
	if (targetRealPath !== absolutePath) {
		throw new RsiError("PATH_SYMLINK_FORBIDDEN", `${label} resolves through an alias.`);
	}
	const bytes = await readFile(absolutePath).catch((error: unknown) => {
		throw new RsiError("PATH_INVALID", `${label} cannot be read.`, { cause: error });
	});
	const text = decodeUtf8Strict(bytes, label);
	return { bytes, text, mtimeMs: info.mtimeMs, nlink: info.nlink };
}

export async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(directory, constants.O_RDONLY);
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EINVAL" && code !== "EPERM" && code !== "EACCES" && code !== "EISDIR" && code !== "EBADF") {
			throw error;
		}
	} finally {
		await handle?.close().catch(() => {});
	}
}

export interface StagedFile {
	readonly path: string;
	readonly bytes: Buffer;
}

export interface StageFileOptions {
	/** Final mode for the staged inode. Managed Markdown must remain readable by a distinct Worker uid. */
	readonly mode?: number;
}

/** Write a verified staging file in the target directory. It is never the target file. */
export async function stageFile(
	directory: string,
	content: string,
	options: StageFileOptions = {},
): Promise<StagedFile> {
	assertCommittableText(content, "Staged file");
	const bytes = Buffer.from(content, "utf8");
	const path = join(directory, `.rsi-${randomUUID()}.tmp`);
	const mode = options.mode ?? 0o600;
	const handle = await open(path, "wx", mode).catch((error: unknown) => {
		throw new RsiError("INTERNAL", "Could not create a staging file for the knowledge transaction.", {
			cause: error,
		});
	});
	try {
		await handle.writeFile(bytes);
		await handle.sync();
		// mkdir/open modes are filtered by umask. Apply the exact mode for the
		// final rename target; state files use 0600 and managed Markdown uses 0644.
		await handle.chmod(mode);
	} catch (error) {
		await handle.close().catch(() => {});
		await unlink(path).catch(() => {});
		throw new RsiError("INTERNAL", "Could not write a staging file for the knowledge transaction.", {
			cause: error,
		});
	} finally {
		await handle.close().catch(() => {});
	}
	const readBack = await readFile(path);
	if (!readBack.equals(bytes)) {
		await unlink(path).catch(() => {});
		throw new RsiError("INTERNAL", "Staging verification failed before commit.");
	}
	return { path, bytes };
}

export async function removeStagedFile(file: StagedFile | undefined): Promise<void> {
	if (!file) return;
	await unlink(file.path).catch(() => {});
}

/** Rename a staging file onto its final direct child name. The caller holds the transaction lock. */
export async function commitStagedFile(staged: StagedFile, targetPath: string, rootRealPath: string): Promise<void> {
	if (dirname(targetPath) !== rootRealPath) {
		await removeStagedFile(staged);
		throw new RsiError("PATH_OUTSIDE_ROOT", "A knowledge commit may only target a direct child of markdowns.");
	}
	try {
		await rename(staged.path, targetPath);
	} catch (error) {
		await removeStagedFile(staged);
		throw new RsiError("INTERNAL", "Atomic knowledge commit failed; the previous file was preserved.", {
			cause: error,
		});
	}
	await fsyncDirectoryBestEffort(rootRealPath);
}

const processMutexTails = new Map<string, Promise<void>>();

/** Serialize transactions inside one process before taking the cross-process lock. */
export async function withProcessMutex<T>(key: string, action: () => Promise<T>): Promise<T> {
	const previous = processMutexTails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	const tail = previous.then(() => gate);
	processMutexTails.set(key, tail);
	await previous;
	try {
		return await action();
	} finally {
		release();
		if (processMutexTails.get(key) === tail) processMutexTails.delete(key);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

interface LockOwner {
	readonly pid: number;
	readonly createdAtMs: number;
}

async function readLockOwner(lockDir: string): Promise<LockOwner | undefined> {
	try {
		const text = await readFile(join(lockDir, "owner.json"), "utf8");
		const value = JSON.parse(text) as Partial<LockOwner>;
		if (typeof value.pid === "number" && typeof value.createdAtMs === "number") {
			return { pid: value.pid, createdAtMs: value.createdAtMs };
		}
	} catch {
		// A missing owner file is handled by the stale-age check.
	}
	return undefined;
}

async function removeStaleLock(lockDir: string, staleMs: number): Promise<boolean> {
	const owner = await readLockOwner(lockDir);
	const info = await lstat(lockDir).catch(() => undefined);
	if (!info) return true;
	const ageMs = Date.now() - info.mtimeMs;
	if (owner && processIsAlive(owner.pid) && ageMs < staleMs) return false;
	if (!owner && ageMs < staleMs) return false;
	await rm(lockDir, { recursive: true, force: true }).catch(() => {});
	return true;
}

export interface CrossProcessLockOptions {
	readonly timeoutMs?: number;
	readonly staleMs?: number;
}

/** Directory-based cross-process lock in the trusted state area. */
export async function withCrossProcessLock<T>(
	lockDir: string,
	options: CrossProcessLockOptions,
	action: () => Promise<T>,
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const staleMs = options.staleMs ?? 30_000;
	const startedAt = Date.now();
	await mkdir(dirname(lockDir), { recursive: true });
	let acquired = false;
	for (;;) {
		try {
			await mkdir(lockDir);
			acquired = true;
			try {
				await writeFile(
					join(lockDir, "owner.json"),
					JSON.stringify({ pid: process.pid, createdAtMs: Date.now() } satisfies LockOwner),
					{ encoding: "utf8", mode: 0o600 },
				);
			} catch (error) {
				await rm(lockDir, { recursive: true, force: true }).catch(() => {});
				throw new RsiError("INTERNAL", "Could not record the knowledge lock owner.", { cause: error });
			}
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				throw new RsiError("INTERNAL", "Could not acquire the knowledge transaction lock.", { cause: error });
			}
			if (await removeStaleLock(lockDir, staleMs)) continue;
			if (Date.now() - startedAt >= timeoutMs) {
				throw new RsiError("INTERNAL", "Timed out waiting for the knowledge transaction lock.", {
					retryable: true,
				});
			}
			await delay(LOCK_POLL_MS);
		}
	}
	if (!acquired) {
		throw new RsiError("INTERNAL", "Knowledge transaction lock was not acquired.");
	}
	try {
		return await action();
	} finally {
		await rm(lockDir, { recursive: true, force: true }).catch(() => {});
	}
}

/** Atomically write a small JSON/state file inside a trusted directory. */
export async function atomicWriteStateFile(path: string, content: string): Promise<void> {
	assertCommittableText(content, "State file");
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw new RsiError("INTERNAL", "Could not inspect a knowledge state file.", { cause: error });
	});
	if (info?.isSymbolicLink() || (info !== undefined && !info.isFile())) {
		throw new RsiError("PATH_SYMLINK_FORBIDDEN", "Knowledge state files must be regular files.");
	}
	const staged = await stageFile(directory, content);
	try {
		await rename(staged.path, path);
	} catch (error) {
		await removeStagedFile(staged);
		throw new RsiError("INTERNAL", "Could not commit a knowledge state file.", { cause: error });
	}
	await fsyncDirectoryBestEffort(directory);
}

export async function readStateFileStrict(path: string): Promise<string | undefined> {
	const read = await readRegularFileStrict(path, "Knowledge state file", { allowMissing: true });
	return read?.text;
}

/** True when stateDir and markdownsDir do not overlap. */
export function assertKnowledgeStateIsolation(markdownsDir: string, stateDir: string): void {
	if (
		resolve(markdownsDir) === resolve(stateDir) ||
		isPathWithin(markdownsDir, stateDir) ||
		isPathWithin(stateDir, markdownsDir)
	) {
		throw new RsiError("CONFIG_INVALID", "Knowledge state must be outside the managed Markdown directory.");
	}
}
