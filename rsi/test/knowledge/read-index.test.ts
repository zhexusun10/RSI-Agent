import assert from "node:assert/strict";
import { readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { INDEX_FILENAME } from "../../src/shared/documents.ts";
import { READ_STATS_WINDOW_MS } from "../../src/knowledge/read-stats.ts";
import { createManagedNativeToolOperations } from "../../src/knowledge/native-tools.ts";
import { createKnowledgeFixture, errorCode, fileTimes, makeIndex, readBytes, readText } from "./helpers.ts";

test("read(index.md) annotates document links per line without touching index bytes or mtime", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await fixture.service.commit({
			name: "a.md",
			content: "alpha beta",
			expectedRevision: null,
			operation: "write",
		});
		await fixture.service.commit({
			name: "b.md",
			content: "beta gamma delta",
			expectedRevision: null,
			operation: "write",
		});
		const indexContent = makeIndex([
			{ name: INDEX_FILENAME, description: "Index", location: `[${INDEX_FILENAME}](${INDEX_FILENAME})` },
			{ name: "Memory.md", description: "Memory", location: "[Memory.md](Memory.md)" },
			{ name: "a.md", description: "A", location: "[a.md](a.md)" },
			{ name: "b.md", description: "B", location: "[b.md](b.md)" },
		]);
		await writeFile(join(fixture.markdownsDir, INDEX_FILENAME), indexContent);
		const fixedMtime = new Date(Date.UTC(2026, 0, 1, 2, 3, 4, 999));
		await utimes(join(fixture.markdownsDir, "a.md"), fixedMtime, fixedMtime);
		const indexBeforeBytes = await readBytes(join(fixture.markdownsDir, INDEX_FILENAME));
		const indexBeforeTimes = await fileTimes(join(fixture.markdownsDir, INDEX_FILENAME));
		const aBeforeTimes = await fileTimes(join(fixture.markdownsDir, "a.md"));

		await fixture.service.readManagedDocument("a.md");
		await fixture.service.readManagedDocument("a.md");
		const view = await fixture.service.readManagedDocument(INDEX_FILENAME);
		const text = view.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		assert.match(
			text,
			/\| a\.md \| A \| \[a\.md\]\(a\.md\) \[System Meta: Words: 2; MTime: 2026\/01\/01 02:03:04; Reads24h: 2\] \|/u,
		);
		assert.match(text, /\[b\.md\]\(b\.md\) \[System Meta: Words: 3; MTime: [^;]+; Reads24h: 0\]/u);
		assert.match(text, /\[Memory\.md\]\(Memory\.md\) \[System Meta: Words: 0; MTime: [^;]+; Reads24h: 0\]/u);
		assert.deepEqual(await readBytes(join(fixture.markdownsDir, INDEX_FILENAME)), indexBeforeBytes);
		assert.equal((await fileTimes(join(fixture.markdownsDir, INDEX_FILENAME))).mtimeMs, indexBeforeTimes.mtimeMs);
		assert.equal((await fileTimes(join(fixture.markdownsDir, "a.md"))).mtimeMs, aBeforeTimes.mtimeMs);

		const stateText = await readText(fixture.readStatsFile);
		assert.match(stateText, /"a\.md"/u);
		assert.doesNotMatch(indexContent, /Current Memory Usage|Reads24h/u);
		assert.equal((await readdir(fixture.markdownsDir)).some((name) => name.endsWith(".json")), false);
	} finally {
		await fixture.cleanup();
	}
});

test("reading index does not count linked documents as read", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await fixture.service.commit({
			name: "linked.md",
			content: "linked",
			expectedRevision: null,
			operation: "write",
		});
		const indexContent = makeIndex([
			{ name: INDEX_FILENAME, description: "Index", location: `[${INDEX_FILENAME}](${INDEX_FILENAME})` },
			{ name: "Memory.md", description: "Memory", location: "[Memory.md](Memory.md)" },
			{ name: "linked.md", description: "Linked", location: "[linked.md](linked.md)" },
		]);
		await writeFile(join(fixture.markdownsDir, INDEX_FILENAME), indexContent);
		const view = await fixture.service.readManagedDocument(INDEX_FILENAME);
		const text = view.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		assert.match(text, /\[linked\.md\]\(linked\.md\) \[System Meta: Words: 1; MTime: [^;]+; Reads24h: 0\]/u);
		const counts = await fixture.service.readStatsCounts(fixture.clock.now());
		assert.equal(counts.get("linked.md"), undefined);
	} finally {
		await fixture.cleanup();
	}
});

test("read offset, limit, and continuation semantics survive annotation", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		for (let index = 0; index < 6; index++) {
			await fixture.service.commit({
				name: `doc-${index}.md`,
				content: `doc ${index}`,
				expectedRevision: null,
				operation: "write",
			});
		}
		const rows = [
			{ name: INDEX_FILENAME, description: "Index", location: `[${INDEX_FILENAME}](${INDEX_FILENAME})` },
			{ name: "Memory.md", description: "Memory", location: "[Memory.md](Memory.md)" },
			...Array.from({ length: 6 }, (_, index) => ({
				name: `doc-${index}.md`,
				description: `Document ${index}`,
				location: `[doc-${index}.md](doc-${index}.md)`,
			})),
		];
		const indexContent = makeIndex(rows);
		await writeFile(join(fixture.markdownsDir, INDEX_FILENAME), indexContent);
		const read = await fixture.service.readManagedDocument(INDEX_FILENAME, { offset: 8, limit: 2 });
		const text = read.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		assert.match(text, /doc-1\.md/u);
		assert.match(text, /doc-2\.md/u);
		assert.doesNotMatch(text, /doc-0\.md/u);
		assert.match(text, /more lines in file\. Use offset=10 to continue\./u);
		assert.equal(read.readsLast24h, 1);

		const countBefore = (await fixture.service.readStatsCounts(fixture.clock.now())).get(INDEX_FILENAME) ?? 0;
		await assert.rejects(
			() => fixture.service.readManagedDocument(INDEX_FILENAME, { offset: 99 }),
			/Offset 99 is beyond end of file/u,
		);
		const countAfter = (await fixture.service.readStatsCounts(fixture.clock.now())).get(INDEX_FILENAME) ?? 0;
		assert.equal(countAfter, countBefore);
	} finally {
		await fixture.cleanup();
	}
});

test("native read operations receive the annotated index view", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await fixture.service.commit({
			name: "native.md",
			content: "native read",
			expectedRevision: null,
			operation: "write",
		});
		const operations = createManagedNativeToolOperations(fixture.service);
		const definition = createReadToolDefinition(fixture.markdownsDir, { operations: operations.read });
		const indexContent = makeIndex([
			{ name: INDEX_FILENAME, description: "Index", location: `[${INDEX_FILENAME}](${INDEX_FILENAME})` },
			{ name: "Memory.md", description: "Memory", location: "[Memory.md](Memory.md)" },
			{ name: "native.md", description: "Native", location: "[native.md](native.md)" },
		]);
		await writeFile(join(fixture.markdownsDir, INDEX_FILENAME), indexContent);
		const result = await definition.execute(
			"native-read",
			{ path: join(fixture.markdownsDir, INDEX_FILENAME) },
			undefined,
			undefined,
			{ cwd: fixture.markdownsDir } as never,
		);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		assert.match(text, /\[native\.md\]\(native\.md\) \[System Meta: Words: 2;/u);
	} finally {
		await fixture.cleanup();
	}
});

test("read counts use a rolling 24-hour window, persist across restart, and expire", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await fixture.service.commit({
			name: "rolling.md",
			content: "rolling",
			expectedRevision: null,
			operation: "write",
		});
		const start = fixture.clock.now();
		await fixture.service.recordRead("rolling.md", start);
		assert.equal((await fixture.service.readStatsCounts(start)).get("rolling.md"), 1);

		fixture.clock.set(start.getTime() + READ_STATS_WINDOW_MS - 1);
		await fixture.service.recordRead("rolling.md", fixture.clock.now());
		assert.equal((await fixture.service.readStatsCounts(fixture.clock.now())).get("rolling.md"), 2);

		const restarted = await fixture.open();
		assert.equal(
			(await restarted.readStatsCounts(fixture.clock.now())).get("rolling.md"),
			2,
			"counts must survive a process restart",
		);

		fixture.clock.set(start.getTime() + READ_STATS_WINDOW_MS);
		assert.equal(
			(await restarted.readStatsCounts(fixture.clock.now())).get("rolling.md"),
			1,
			"a record exactly 24 hours old is outside the window",
		);

		fixture.clock.set(start.getTime() + READ_STATS_WINDOW_MS * 2 + 1);
		assert.equal((await restarted.readStatsCounts(fixture.clock.now())).get("rolling.md"), undefined);
		const raw = JSON.parse(await readFile(fixture.readStatsFile, "utf8")) as {
			records?: Record<string, number[]>;
		};
		assert.equal(raw.records?.["rolling.md"], undefined, "expired records must be physically cleaned");
	} finally {
		await fixture.cleanup();
	}
});

test("a successful managed read records exactly once and rejects nonexistent reads", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await fixture.service.commit({
			name: "once.md",
			content: "one",
			expectedRevision: null,
			operation: "write",
		});
		await fixture.service.readManagedDocument("once.md");
		await fixture.service.readManagedDocument("once.md");
		assert.equal((await fixture.service.readStatsCounts(fixture.clock.now())).get("once.md"), 2);
		await assert.rejects(
			() => fixture.service.recordRead("missing.md", fixture.clock.now()),
			(error: unknown) => errorCode(error) === "DOCUMENT_NOT_FOUND",
		);
		assert.equal((await fixture.service.readStatsCounts(fixture.clock.now())).get("missing.md"), undefined);
	} finally {
		await fixture.cleanup();
	}
});
