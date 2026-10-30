import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createKnowledgeFixture, makeIndex } from "../knowledge/helpers.ts";

/**
 * The annotated index view and the request-time statistics report are generated
 * for the same `read(index.md)` result. They must agree about the rolling read
 * count, including the index file's own count. A view that reports 0 while the
 * report counts 1 is stale metadata, not a "real-time" read statistic.
 */
test("read(index.md) inline Reads24h agrees with the request-time report", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await fixture.service.commit({
			name: "topic.md",
			content: "topic body",
			expectedRevision: null,
			operation: "write",
		});
		await writeFile(
			join(fixture.markdownsDir, "index.md"),
			makeIndex([
				{ name: "index.md", description: "Index", location: "[index.md](index.md)" },
				{ name: "Memory.md", description: "Memory", location: "[Memory.md](Memory.md)" },
				{ name: "topic.md", description: "Topic", location: "[topic.md](topic.md)" },
			]),
		);

		const read = await fixture.service.readManagedDocument("index.md");
		const rendered = read.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const inline = /\[index\.md\]\(index\.md\) \[System Meta: Words: \d+; MTime: [^;]+; Reads24h: (\d+)\]/u.exec(
			rendered,
		);
		assert.ok(inline, "index row must carry inline metadata");
		const report = await fixture.service.indexReport(fixture.clock.now());
		const row = report.stats.find((stat) => stat.name === "index.md");
		assert.ok(row);
		assert.equal(Number(inline[1]), row.readsLast24h, "inline index Reads24h must equal the report count");
		assert.equal(row.readsLast24h, 1, "the successful read itself is part of the rolling count");
	} finally {
		await fixture.cleanup();
	}
});
