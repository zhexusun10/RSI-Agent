#!/usr/bin/env node
import { copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const LEGACY_INDEX = `# Managed Markdown Index

| md名 | description | 链接位置 |
| --- | --- | --- |
| index.md | Managed Markdown index and request-time statistics anchor | [index.md](index.md) |
| Memory.md | Agent-maintained Memory, initially empty | [Memory.md](Memory.md) |
`;

function fail(message) {
	console.error(`[rsi-seed-markdowns] ${message}`);
	process.exitCode = 1;
}

async function inspectRegular(path, label) {
	const info = await lstat(path).catch((error) => {
		throw new Error(`${label} is not accessible: ${path}: ${error instanceof Error ? error.message : String(error)}`);
	});
	if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
		throw new Error(`${label} must be a single-link regular file: ${path}`);
	}
	return info;
}

async function main() {
	const seedDir = resolve(process.argv[2] ?? "/opt/rsi/seed-markdowns");
	const targetDir = resolve(process.argv[3] ?? "/data/markdowns");
	const seedNames = (await readdir(seedDir))
		.filter((name) => name.endsWith(".md"))
		.sort((left, right) => left.localeCompare(right, "en"));
	if (!seedNames.includes("index.md") || !seedNames.includes("Memory.md")) {
		throw new Error(`seed directory must contain index.md and Memory.md: ${seedDir}`);
	}
	const seedPaths = new Map();
	for (const name of seedNames) {
		if (basename(name) !== name) throw new Error(`invalid seed name: ${name}`);
		const path = join(seedDir, name);
		await inspectRegular(path, "Seed Markdown");
		seedPaths.set(name, path);
	}

	await mkdir(targetDir, { recursive: true, mode: 0o755 });
	const indexPath = join(targetDir, "index.md");
	let indexContent = null;
	try {
		await inspectRegular(indexPath, "Managed index");
		indexContent = await readFile(indexPath, "utf8");
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("not accessible")) throw error;
	}

	const legacy = indexContent !== null && indexContent.trim() === LEGACY_INDEX.trim();
	if (indexContent !== null && !legacy) {
		console.log("[rsi-seed-markdowns] operator-managed index.md exists; leaving managed Markdown unchanged");
		return;
	}

	const copied = [];
	for (const name of seedNames) {
		const target = join(targetDir, name);
		let exists = true;
		try {
			await inspectRegular(target, "Managed Markdown target");
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("not accessible")) throw error;
			exists = false;
		}
		if (exists && !(legacy && name === "index.md")) continue;
		await copyFile(seedPaths.get(name), target);
		// Managed files are always Supervisor-owned/read-only to the Worker.
		const { chmod } = await import("node:fs/promises");
		await chmod(target, 0o644);
		copied.push(name);
	}
	if (copied.length === 0) {
		console.log("[rsi-seed-markdowns] all managed Markdown already present");
	} else {
		console.log(`[rsi-seed-markdowns] seeded ${copied.join(", ")}`);
	}
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
