import { constants } from "node:fs";
import { access, copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { RsiError } from "../shared/errors.ts";

export interface AtomicJsonReadResult<T> {
	readonly value: T | null;
	readonly recovered: boolean;
	readonly diagnostics: readonly string[];
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** fsync a directory where the platform permits it. Windows cannot open directories this way. */
export async function fsyncDirectory(path: string): Promise<void> {
	try {
		const handle = await open(path, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// Best-effort only. The rename is still atomic on the same filesystem.
	}
}

async function writeDurable(path: string, data: string, mode = 0o600): Promise<void> {
	const handle = await open(path, "wx", mode);
	try {
		await handle.writeFile(data, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Atomic JSON file with a previous-version backup.
 *
 * Save order: write complete temp, copy the current main to the backup, then
 * replace main by rename. A crash therefore leaves either the old main, the
 * new main, or a valid backup; never a half-written main from this writer.
 */
export class AtomicJsonFile<T> {
	readonly path: string;
	readonly backupPath: string;
	private readonly validate: (value: unknown) => T;
	private readonly serialize: (value: T) => string;
	private queue: Promise<void> = Promise.resolve();

	constructor(
		path: string,
		validate: (value: unknown) => T,
		serialize: (value: T) => string = (value) => `${JSON.stringify(value, null, 2)}\n`,
	) {
		this.path = path;
		this.backupPath = `${path}.bak`;
		this.validate = validate;
		this.serialize = serialize;
	}

	private async readValidated(path: string): Promise<T | null> {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			return null;
		}
		try {
			return this.validate(JSON.parse(text));
		} catch {
			return null;
		}
	}

	async read(): Promise<AtomicJsonReadResult<T>> {
		const diagnostics: string[] = [];
		const main = await this.readValidated(this.path);
		if (main !== null) return { value: main, recovered: false, diagnostics };
		if (await pathExists(this.path)) diagnostics.push(`Invalid JSON state at ${this.path}; trying backup.`);
		const backup = await this.readValidated(this.backupPath);
		if (backup !== null) {
			return { value: backup, recovered: true, diagnostics: [...diagnostics, "Recovered from backup state."] };
		}
		if (await pathExists(this.backupPath)) diagnostics.push(`Invalid JSON backup at ${this.backupPath}.`);
		return { value: null, recovered: false, diagnostics };
	}

	async write(value: T): Promise<void> {
		const serialized = this.serialize(this.validate(value));
		const run = async (): Promise<void> => {
			await mkdir(dirname(this.path), { recursive: true });
			const nonce = randomUUID();
			const tempPath = join(dirname(this.path), `.${nonce}.tmp`);
			try {
				await writeDurable(tempPath, serialized);
				if (await pathExists(this.path)) {
					const backupTemp = join(dirname(this.path), `.${nonce}.bak.tmp`);
					try {
						await copyFile(this.path, backupTemp);
						const handle = await open(backupTemp, "r+");
						try {
							await handle.sync();
						} finally {
							await handle.close();
						}
						await rm(this.backupPath, { force: true });
						await rename(backupTemp, this.backupPath);
					} finally {
						await rm(backupTemp, { force: true });
					}
				}
				await rename(tempPath, this.path);
				await fsyncDirectory(dirname(this.path));
			} finally {
				await rm(tempPath, { force: true });
			}
		};
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		await next;
	}

	/** Remove temp files left by an interrupted writer. */
	async cleanupTemps(): Promise<void> {
		const directory = dirname(this.path);
		try {
			const { readdir, unlink } = await import("node:fs/promises");
			const names = await readdir(directory);
			const prefix = `.`;
			for (const name of names) {
				if (name.startsWith(prefix) && (name.endsWith(".tmp") || name.endsWith(".bak.tmp"))) {
					await unlink(join(directory, name)).catch(() => undefined);
				}
			}
		} catch {
			// The directory may not exist yet.
		}
	}
}

/** Read at most maxBytes from the tail of a file. Missing files return an empty string. */
export async function readTail(path: string, maxBytes: number): Promise<string> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return "";
		const handle = await open(path, "r");
		try {
			const length = Math.min(info.size, maxBytes);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, Math.max(0, info.size - length));
			return buffer.toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return "";
	}
}

/** Append text while keeping only a bounded tail. The file is replaced atomically. */
export async function appendBoundedLog(path: string, text: string, maxBytes: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	let previous = "";
	try {
		previous = await readFile(path, "utf8");
	} catch {
		previous = "";
	}
	const combined = `${previous}${text}`;
	let bounded = combined;
	if (Buffer.byteLength(combined, "utf8") > maxBytes) {
		const bytes = Buffer.from(combined, "utf8");
		bounded = bytes.subarray(bytes.length - maxBytes).toString("utf8");
	}
	const nonce = randomUUID();
	const temp = join(dirname(path), `.${nonce}.log.tmp`);
	await writeDurable(temp, bounded, 0o600);
	await rename(temp, path);
	await fsyncDirectory(dirname(path));
}

export async function removeIfExists(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
}

export function assertSafeRelativePath(relativePath: string): string {
	if (
		relativePath.length === 0 ||
		relativePath.includes("\u0000") ||
		relativePath.startsWith("/") ||
		relativePath.startsWith("\\") ||
		/^[A-Za-z]:/.test(relativePath)
	) {
		throw new RsiError("PATH_INVALID", `Unsafe relative path: ${JSON.stringify(relativePath)}`);
	}
	const segments = relativePath.split(/[\\/]/);
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new RsiError("PATH_INVALID", `Unsafe relative path: ${JSON.stringify(relativePath)}`);
	}
	return segments.join("/");
}
