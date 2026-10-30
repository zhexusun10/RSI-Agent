import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createKnowledgeFixture, errorCode, readBytes } from "./helpers.ts";
import { KnowledgeService } from "../../src/knowledge/index.ts";
import { MEMORY_FILENAME } from "../../src/shared/paths.ts";
import { formatMemoryUsage } from "../../src/shared/memory.ts";
import { countWords } from "../../src/shared/words.ts";

test("Memory accepts 500 words and rejects 501 without changing bytes", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const empty = await fixture.service.readCurrentMemory();
		const atLimit = "中".repeat(500);
		const committed = await fixture.service.commitMemory({
			content: atLimit,
			expectedRevision: empty.revision,
		});
		assert.equal(committed.snapshot.words, 500);
		assert.equal(committed.usage, formatMemoryUsage(500));
		assert.equal(committed.snapshot.content, atLimit);
		assert.equal(committed.snapshot.version, committed.snapshot.revision);
		assert.equal(committed.snapshot.usage, formatMemoryUsage(500));
		const brokerResult = await fixture.service.commit({
			name: MEMORY_FILENAME,
			content: "broker memory",
			expectedRevision: committed.snapshot.revision,
			operation: "write",
		});
		assert.equal(brokerResult.memoryUsage, formatMemoryUsage(2));
		assert.equal((await fixture.service.readCurrentMemory()).content, "broker memory");
		await fixture.service.commitMemory({
			content: atLimit,
			expectedRevision: (await fixture.service.readCurrentMemory()).revision,
		});
		const before = await readBytes(join(fixture.markdownsDir, MEMORY_FILENAME));
		const beforeRevision = committed.snapshot.revision;

		await assert.rejects(
			() =>
				fixture.service.commitMemory({
					content: `${atLimit}文`,
					expectedRevision: beforeRevision,
				}),
			(error: unknown) => errorCode(error) === "MEMORY_WORD_LIMIT",
		);
		const after = await readBytes(join(fixture.markdownsDir, MEMORY_FILENAME));
		assert.deepEqual(after, before);
		const nextRequest = await fixture.service.readCurrentMemory();
		assert.equal(nextRequest.content, atLimit);
		assert.equal(nextRequest.revision, beforeRevision);
		assert.equal(nextRequest.usage, formatMemoryUsage(500));
	} finally {
		await fixture.cleanup();
	}
});

test("Memory word counting uses the shared Chinese and mixed-script algorithm", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const empty = await fixture.service.readCurrentMemory();
		const content = "中文 hello-world 123 it's かなカナ한글";
		const words = countWords(content);
		assert.ok(words > 8, "mixed CJK and Latin text must not be one word");
		const committed = await fixture.service.commitMemory({
			content,
			expectedRevision: empty.revision,
		});
		assert.equal(committed.snapshot.words, words);
		assert.equal(committed.usage, `[System Meta: Current Memory Usage: ${words} / 500 words]`);
	} finally {
		await fixture.cleanup();
	}
});

test("a rejected Memory update keeps the next model request on the previous version", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const empty = await fixture.service.readCurrentMemory();
		const first = await fixture.service.commitMemory({
			content: "stable long-term memory",
			expectedRevision: empty.revision,
		});
		const before = await readBytes(join(fixture.markdownsDir, MEMORY_FILENAME));
		await assert.rejects(
			() =>
				fixture.service.commitMemory({
					content: Array.from({ length: 501 }, () => "x").join(" "),
					expectedRevision: first.snapshot.revision,
				}),
			(error: unknown) => errorCode(error) === "MEMORY_WORD_LIMIT",
		);
		const nextRequest = await fixture.service.readCurrentMemory();
		assert.equal(nextRequest.content, "stable long-term memory");
		assert.equal(nextRequest.revision, first.snapshot.revision);
		assert.equal(nextRequest.usage, formatMemoryUsage(first.snapshot.words));
		assert.deepEqual(await readBytes(join(fixture.markdownsDir, MEMORY_FILENAME)), before);
		const names = await readdir(fixture.markdownsDir);
		assert.deepEqual(names.filter((name) => name.includes(".rsi-")), []);
	} finally {
		await fixture.cleanup();
	}
});

test("Memory becomes visible to the next request immediately after a commit", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const initial = await fixture.service.readCurrentMemory();
		const committed = await fixture.service.commitMemory({
			content: "same turn update",
			expectedRevision: initial.revision,
		});
		const next = await fixture.service.getMemory();
		assert.equal(next.content, "same turn update");
		assert.equal(next.revision, committed.snapshot.revision);
		assert.deepEqual(committed.snapshot, next);
		await assert.rejects(
			() =>
				fixture.service.commitMemory({
					content: "stale write",
					expectedRevision: initial.revision,
				}),
			(error: unknown) => errorCode(error) === "MEMORY_REVISION_CONFLICT",
		);
		assert.equal((await fixture.service.readCurrentMemory()).content, "same turn update");
	} finally {
		await fixture.cleanup();
	}
});

test("a native edit that exceeds 500 Memory words is rejected atomically", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const empty = await fixture.service.readCurrentMemory();
		const first = await fixture.service.commitMemory({
			content: "old memory",
			expectedRevision: empty.revision,
		});
		const before = await readBytes(join(fixture.markdownsDir, MEMORY_FILENAME));
		await assert.rejects(
			() =>
				fixture.service.editDocument(
					MEMORY_FILENAME,
					[{ oldText: "old memory", newText: "新".repeat(501) }],
					first.snapshot.revision,
				),
			(error: unknown) => errorCode(error) === "MEMORY_WORD_LIMIT",
		);
		assert.deepEqual(await readBytes(join(fixture.markdownsDir, MEMORY_FILENAME)), before);
		const next = await fixture.service.readCurrentMemory();
		assert.equal(next.content, "old memory");
		assert.equal(next.revision, first.snapshot.revision);
	} finally {
		await fixture.cleanup();
	}
});

test("startup fails closed on an over-limit Memory without truncating it", async () => {
	const baseDir = await mkdtemp(join(tmpdir(), "rsi-knowledge-bad-"));
	try {
		const markdownsDir = join(baseDir, "markdowns");
		const stateDir = join(baseDir, "state");
		await mkdir(markdownsDir);
		await mkdir(stateDir);
		const overLimit = "中".repeat(501);
		await writeFile(join(markdownsDir, MEMORY_FILENAME), overLimit);
		const before = await readBytes(join(markdownsDir, MEMORY_FILENAME));
		await assert.rejects(
			() =>
				KnowledgeService.open({
					markdownsDir,
					stateDir,
					readStatsFile: join(stateDir, "read-stats", "reads.json"),
					timeZone: "UTC",
				}),
			(error: unknown) => errorCode(error) === "MEMORY_WORD_LIMIT",
		);
		assert.deepEqual(await readBytes(join(markdownsDir, MEMORY_FILENAME)), before);
	} finally {
		await rm(baseDir, { recursive: true, force: true });
	}
});

test("getMemory reads committed bytes on every model request without caching", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await fixture.service.readCurrentMemory();
		await writeFile(join(fixture.markdownsDir, MEMORY_FILENAME), "externally committed");
		const first = await fixture.service.readCurrentMemory();
		assert.equal(first.content, "externally committed");
		await writeFile(join(fixture.markdownsDir, MEMORY_FILENAME), "next committed");
		const second = await fixture.service.getMemory();
		assert.equal(second.content, "next committed");
		assert.notEqual(second.revision, first.revision);
	} finally {
		await fixture.cleanup();
	}
});
