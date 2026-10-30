import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { auditIndex, countWords, listManagedMarkdownNames } from "../../src/shared/index.ts";

const execFileAsync = promisify(execFile);

function findRepositoryRoot(): string {
	const starts = [
		resolve(process.cwd()),
		resolve(dirname(fileURLToPath(import.meta.url))),
	];
	for (const start of starts) {
		let current = start;
		for (let depth = 0; depth < 8; depth++) {
			if (
				existsSync(join(current, "markdowns", "index.md")) &&
				existsSync(join(current, "rsi", "package.json"))
			) {
				return current;
			}
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	throw new Error("Could not locate repository root for Markdown seed test.");
}

const repositoryRoot = findRepositoryRoot();
const seedDir = join(repositoryRoot, "markdowns");
const script = join(repositoryRoot, "rsi", "scripts", "seed-markdowns.mjs");

const LEGACY_INDEX = `# Managed Markdown Index

| md名 | description | 链接位置 |
| --- | --- | --- |
| index.md | Managed Markdown index and request-time statistics anchor | [index.md](index.md) |
| Memory.md | Agent-maintained Memory, initially empty | [Memory.md](Memory.md) |
`;

async function runSeed(targetDir: string): Promise<string> {
	const result = await execFileAsync(process.execPath, [script, seedDir, targetDir], { encoding: "utf8" });
	return `${result.stdout}\n${result.stderr}`;
}

test("fresh container Markdown seed contains every seed document with a consistent index", { timeout: 20_000 }, async () => {
	const target = await mkdtemp(join(tmpdir(), "rsi-markdown-seed-"));
	try {
		const output = await runSeed(target);
		assert.match(output, /seeded/u);
		const listing = await listManagedMarkdownNames(target);
		assert.deepEqual([...listing.names].sort(), (await readdir(seedDir)).filter((name) => name.endsWith(".md")).sort());
		assert.equal(countWords(await readFile(join(target, "Memory.md"), "utf8")), 0);
		const index = await readFile(join(target, "index.md"), "utf8");
		const audit = auditIndex(index, listing.names);
		assert.equal(audit.consistent, true, audit.warnings.join("; "));
		for (const name of listing.names) {
			assert.ok(index.includes(`[${name}](${name})`), `index must link ${name}`);
		}
	} finally {
		await rm(target, { recursive: true, force: true });
	}
});

test("legacy two-row index is upgraded to the full seed without losing Memory", { timeout: 20_000 }, async () => {
	const target = await mkdtemp(join(tmpdir(), "rsi-markdown-legacy-"));
	try {
		await writeFile(join(target, "index.md"), LEGACY_INDEX, "utf8");
		await writeFile(join(target, "Memory.md"), "KEEP-OPERATOR-MEMORY\n", "utf8");
		await runSeed(target);
		const listing = await listManagedMarkdownNames(target);
		assert.deepEqual([...listing.names].sort(), (await readdir(seedDir)).filter((name) => name.endsWith(".md")).sort());
		assert.equal(await readFile(join(target, "Memory.md"), "utf8"), "KEEP-OPERATOR-MEMORY\n");
		const audit = auditIndex(await readFile(join(target, "index.md"), "utf8"), listing.names);
		assert.equal(audit.consistent, true, audit.warnings.join("; "));
	} finally {
		await rm(target, { recursive: true, force: true });
	}
});

test("a custom operator-managed index is never overwritten or expanded", { timeout: 20_000 }, async () => {
	const target = await mkdtemp(join(tmpdir(), "rsi-markdown-custom-"));
	try {
		const customIndex = [
			"# Managed Markdown Index",
			"",
			"| md名 | description | 链接位置 |",
			"| --- | --- | --- |",
			"| index.md | Custom | [index.md](index.md) |",
			"",
		].join("\n");
		await writeFile(join(target, "index.md"), customIndex, "utf8");
		const output = await runSeed(target);
		assert.match(output, /operator-managed/u);
		assert.equal(await readFile(join(target, "index.md"), "utf8"), customIndex);
		assert.deepEqual((await readdir(target)).filter((name) => name.endsWith(".md")), ["index.md"]);
	} finally {
		await rm(target, { recursive: true, force: true });
	}
});
