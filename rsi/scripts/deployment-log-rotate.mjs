#!/usr/bin/env node
import { copyFile, lstat, readdir, rename, rm, truncate } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_KEEP_FILES = 4;

function positiveInteger(value, name, minimum) {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
	return number;
}

export async function rotateLogs({ dir, maxBytes = DEFAULT_MAX_BYTES, keepFiles = DEFAULT_KEEP_FILES }) {
	const root = resolve(dir);
	const info = await lstat(root).catch((error) => {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	});
	if (!info) return { rotated: [], skipped: "log directory does not exist" };
	if (info.isSymbolicLink()) throw new Error("Log directory must not be a symlink.");
	if (!info.isDirectory()) throw new Error("Log directory must be a directory.");
	const entries = await readdir(root, { withFileTypes: true });
	const rotated = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
		const path = join(root, entry.name);
		const fileInfo = await lstat(path);
		if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) continue;
		if (fileInfo.size <= maxBytes) continue;
		await rm(`${path}.${keepFiles - 1}`, { force: true });
		for (let index = keepFiles - 2; index >= 1; index -= 1) {
			const from = `${path}.${index}`;
			const to = `${path}.${index + 1}`;
			const fromInfo = await lstat(from).catch((error) => {
				if (error?.code === "ENOENT") return undefined;
				throw error;
			});
			if (fromInfo?.isFile()) {
				await rm(to, { force: true });
				await rename(from, to);
			}
		}
		await copyFile(path, `${path}.1`);
		await truncate(path, 0);
		rotated.push({ path, previousBytes: fileInfo.size });
	}
	return { rotated, skipped: undefined };
}

function parseArgs(argv) {
	let dir;
	let maxBytes = Number(process.env.RSI_LOG_MAX_BYTES ?? DEFAULT_MAX_BYTES);
	let keepFiles = Number(process.env.RSI_LOG_KEEP_FILES ?? DEFAULT_KEEP_FILES);
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--once") continue;
		if (arg === "--dir") dir = resolve(argv[++index] ?? "");
		else if (arg === "--max-bytes") maxBytes = Number(argv[++index]);
		else if (arg === "--keep") keepFiles = Number(argv[++index]);
		else if (arg === "--help" || arg === "-h") {
			console.error("Usage: deployment-log-rotate.mjs --once --dir DIR [--max-bytes N] [--keep N]");
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!dir) dir = process.env.RSI_LOGS_DIR ?? "/state/logs";
	return {
		dir,
		maxBytes: positiveInteger(maxBytes, "--max-bytes", 1),
		keepFiles: positiveInteger(keepFiles, "--keep", 2),
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = parseArgs(process.argv.slice(2));
		const result = await rotateLogs(args);
		for (const entry of result.rotated) {
			console.log(`rotated ${entry.path} (${entry.previousBytes} bytes)`);
		}
		if (result.skipped) console.log(`skipped: ${result.skipped}`);
	} catch (error) {
		console.error(`[rsi-log-rotate] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
