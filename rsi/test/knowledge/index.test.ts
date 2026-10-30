import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	auditKnowledgeIndex,
	createInitialIndexContent,
	formatKnowledgeIndexWarning,
	normalizeLocalIndexTarget,
	parseKnowledgeIndex,
	parseMarkdownLink,
} from "../../src/knowledge/index-audit.ts";
import { KnowledgeToolMiddleware, KnowledgeToolResultService } from "../../src/knowledge/tool-result.ts";
import { INDEX_FILENAME } from "../../src/shared/documents.ts";
import { createKnowledgeFixture, fileTimes, makeIndex, readBytes } from "./helpers.ts";

const HEADER = `| md名 | description | 链接位置 |
| --- | --- | --- |`;

test("index parser ignores headers, separators, and fenced code examples", () => {
	const content = `# Index

\`\`\`md
| fake.md | not a row | [fake.md](fake.md) |
| --- | --- | --- |
\`\`\`

    | indented.md | code block | [indented.md](indented.md) |

${HEADER}
| index.md | Index | [index.md](index.md) |
| 记忆.md | Notes | [记忆.md](%E8%AE%B0%E5%BF%86.md "title") |
`;
	const parsed = parseKnowledgeIndex(content);
	assert.equal(parsed.headerFound, true);
	assert.equal(parsed.rows.length, 2);
	assert.deepEqual(parsed.rows.map((row) => row.target), ["index.md", "记忆.md"]);
	assert.equal(parsed.rows.some((row) => row.name === "fake.md"), false);
	assert.equal(parsed.rows.some((row) => row.name === "indented-fake.md"), false);
	assert.equal(parsed.rows.some((row) => row.name === "indented.md"), false);
	assert.deepEqual(parseMarkdownLink("[a](a.md \"title\")"), { label: "a", target: "a.md" });
});

test("local link normalization decodes URL escaping and blocks every escape variant", () => {
	assert.deepEqual(normalizeLocalIndexTarget("a.md"), { ok: true, fileName: "a.md", decodedTarget: "a.md" });
	assert.deepEqual(normalizeLocalIndexTarget("./a.md"), { ok: true, fileName: "a.md", decodedTarget: "a.md" });
	assert.deepEqual(normalizeLocalIndexTarget("%E8%AE%B0%E5%BF%86.md"), {
		ok: true,
		fileName: "记忆.md",
		decodedTarget: "记忆.md",
	});
	for (const target of [
		"../escape.md",
		"%2e%2e%2fescape.md",
		"sub/../escape.md",
		"sub/a.md",
		"/absolute.md",
		"a%2Fb.md",
		"https://example.com/a.md",
		"a.txt",
		"a%00.md",
	]) {
		const result = normalizeLocalIndexTarget(target);
		if (result.ok) {
			assert.equal(result.fileName.includes("/"), false, `unexpected normalized target for ${target}`);
		} else {
			assert.equal(typeof result.reason, "string");
		}
	}
	assert.equal(normalizeLocalIndexTarget("../escape.md").ok, false);
	assert.equal(normalizeLocalIndexTarget("%2e%2e%2fescape.md").ok, false);
	assert.equal(normalizeLocalIndexTarget("a%2Fb.md").ok, false);
	assert.equal(normalizeLocalIndexTarget("sub/../escape.md").ok, false);
});

test("audit reports unindexed files, dangling rows, duplicates, and missing self-index", () => {
	const content = `${HEADER}
| a.md | A | [a.md](a.md) |
| a.md | duplicate | [a.md](a.md) |
| missing.md | Missing | [missing.md](missing.md) |
| bad.md | Bad link | not-a-link |
| escape.md | Escape | [escape.md](../escape.md) |
`;
	const audit = auditKnowledgeIndex(content, ["a.md", "unindexed.md"]);
	assert.equal(audit.consistent, false);
	assert.deepEqual(audit.duplicateEntries, ["a.md"]);
	assert.ok(audit.missingFiles.includes("missing.md"));
	assert.deepEqual(audit.unlistedFiles, ["unindexed.md"]);
	assert.equal(audit.selfIndexed, false);
	assert.ok(audit.warnings.some((warning) => warning.includes("not a Markdown link")));
	assert.ok(audit.warnings.some((warning) => warning.includes("escapes")));
	assert.ok(audit.warnings.some((warning) => warning.includes("does not list itself")));
	assert.match(formatKnowledgeIndexWarning(audit) ?? "", /^\[System Meta: Index Warning: /u);
});

test("initial index self-indexes and lists the empty Memory file", () => {
	const audit = auditKnowledgeIndex(createInitialIndexContent({ includeMemory: true }), [
		INDEX_FILENAME,
		"Memory.md",
	]);
	assert.equal(audit.consistent, true);
	assert.equal(audit.selfIndexed, true);
});

test("service consistency sees unregistered and dangling entries but never rewrites the index", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const unindexed = await fixture.service.commit({
			name: "unindexed.md",
			content: "unindexed",
			expectedRevision: null,
			operation: "write",
		});
		let audit = await fixture.service.auditIndex();
		assert.equal(audit.consistent, false);
		assert.ok(audit.unlistedFiles.includes("unindexed.md"));

		const indexContent = makeIndex([
			{ name: INDEX_FILENAME, description: "Index", location: `[${INDEX_FILENAME}](${INDEX_FILENAME})` },
			{ name: "Memory.md", description: "Memory", location: "[Memory.md](Memory.md)" },
			{ name: "unindexed.md", description: "Unindexed", location: "[unindexed.md](unindexed.md)" },
			{ name: "dangling.md", description: "Dangling", location: "[dangling.md](dangling.md)" },
		]);
		await writeFile(join(fixture.markdownsDir, INDEX_FILENAME), indexContent);
		const beforeBytes = await readBytes(join(fixture.markdownsDir, INDEX_FILENAME));
		const beforeTimes = await fileTimes(join(fixture.markdownsDir, INDEX_FILENAME));
		audit = await fixture.service.auditIndex();
		assert.equal(audit.consistent, false);
		assert.ok(audit.missingFiles.includes("dangling.md"));
		const consistency = await fixture.service.consistency();
		assert.ok(consistency.missingFiles.includes("dangling.md"));
		assert.deepEqual(await readBytes(join(fixture.markdownsDir, INDEX_FILENAME)), beforeBytes);
		assert.equal((await fileTimes(join(fixture.markdownsDir, INDEX_FILENAME))).mtimeMs, beforeTimes.mtimeMs);
		assert.equal((await fixture.service.read("unindexed.md")).revision, unindexed.revision);
	} finally {
		await fixture.cleanup();
	}
});

test("no index warning is emitted for vendor Markdown outside markdowns", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const audit = await fixture.service.auditIndex();
		assert.equal(audit.consistent, true);
		assert.equal(formatKnowledgeIndexWarning(audit), undefined);
	} finally {
		await fixture.cleanup();
	}
});

test("middleware audits after every tool result, including plugins, sleep, controls, and errors", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await fixture.service.commit({
			name: "not-indexed.md",
			content: "not indexed",
			expectedRevision: null,
			operation: "write",
		});
		const middleware = new KnowledgeToolMiddleware({ service: fixture.service });
		const tools = ["bash", "web_search", "sleep", "custom_plugin", "read", "write", "control"];
		const warnings: string[] = [];
		for (const [index, toolName] of tools.entries()) {
			const patch = await middleware.afterToolResult({
				toolCallId: `call-${index}`,
				toolName,
				input: {},
				content: [{ type: "text", text: `${toolName} result` }],
				isError: index % 2 === 0,
			});
			const content = patch.content ?? [];
			const text = content.find((block) => block.type === "text")?.text ?? "";
			const line = text
				.split("\n")
				.find((candidate) => candidate.startsWith("[System Meta: Index Warning: "));
			assert.ok(line, `${toolName} must append an index warning`);
			warnings.push(line);
		}
		assert.equal(new Set(warnings).size, 1);

		const decorator = new KnowledgeToolResultService({ service: fixture.service });
		const decoration = await decorator.decorate(
			{
				toolName: "custom_plugin",
				toolCallId: "error-call",
				isError: true,
				indexRead: false,
			},
			fixture.clock.now(),
		);
		assert.equal(decoration.warnings.length, 1);
		assert.match(decoration.appendText, /^\[System Meta: Index Warning: /u);
		assert.match(decoration.currentTime, /^\(Current Time: /u);
	} finally {
		await fixture.cleanup();
	}
});
