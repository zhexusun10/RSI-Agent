import assert from "node:assert/strict";
import test from "node:test";
import {
	auditIndex,
	formatIndexWarning,
	parseMarkdownIndex,
	renderIndexReadReport,
	validateManagedDocumentWrite,
} from "../src/shared/index.ts";

const INDEX = `| md名 | description | 链接位置 |
| --- | --- | --- |
| architecture.md | Development and operations | architecture.md |
| index.md | Index | [index.md](index.md) |
`;

test("index parser and audit use the required three columns", () => {
	const parsed = parseMarkdownIndex(INDEX);
	assert.equal(parsed.headerFound, true);
	assert.equal(parsed.rows.length, 2);
	assert.equal(parsed.rows[1]?.location, "[index.md](index.md)");
	const consistent = auditIndex(INDEX, ["architecture.md", "index.md"]);
	assert.equal(consistent.consistent, true);
	assert.equal(formatIndexWarning(consistent), undefined);
	const missing = auditIndex(INDEX, ["architecture.md", "index.md", "Memory.md"]);
	assert.equal(missing.consistent, false);
	assert.deepEqual(missing.unlistedFiles, ["Memory.md"]);
	assert.match(formatIndexWarning(missing) ?? "", /Index Warning/);
});

test("index audit reports missing rows, bad rows, and duplicates", () => {
	const content = `| md名 | description | 链接位置 |
| --- | --- | --- |
| a.md | A | a.md |
| a.md | A again | a.md |
| b.md | B | b.md |
| bad.md | Bad | wrong.md |
`;
	const audit = auditIndex(content, ["a.md"]);
	assert.equal(audit.consistent, false);
	assert.deepEqual(audit.duplicateEntries, ["a.md"]);
	assert.deepEqual(audit.missingFiles, ["b.md", "wrong.md"]);
	assert.ok(audit.warnings.some((warning) => warning.includes("does not match")));
});

test("index read report is request-time text with words, mtime, and 24h reads", () => {
	const report = renderIndexReadReport(
		[
			{ name: "architecture.md", words: 700, mtimeMs: Date.UTC(2026, 0, 2, 3, 4, 5), readsLast24h: 3 },
		],
		new Date(Date.UTC(2026, 0, 2, 4, 0, 0)),
		"UTC",
	);
	assert.match(report, /not written to index\.md/);
	assert.match(report, /architecture\.md \| 700 \| 2026\/01\/02 03:04:05 \| 3/);
});

test("managed document limits are enforced without changing existing text", () => {
	const thousand = Array.from({ length: 1_000 }, () => "word").join(" ");
	const over = `${thousand} extra`;
	assert.equal(validateManagedDocumentWrite({ name: "a.md", content: thousand, existingNames: [] }), 1_000);
	assert.throws(
		() => validateManagedDocumentWrite({ name: "a.md", content: over, existingNames: [] }),
		(error: unknown) => (error as { code?: string }).code === "DOCUMENT_WORD_LIMIT",
	);
	const twenty = Array.from({ length: 20 }, (_, index) => `doc-${index}.md`);
	assert.throws(
		() => validateManagedDocumentWrite({ name: "doc-20.md", content: "ok", existingNames: twenty }),
		(error: unknown) => (error as { code?: string }).code === "DOCUMENT_COUNT_LIMIT",
	);
	assert.doesNotThrow(() =>
		validateManagedDocumentWrite({ name: "doc-0.md", content: "ok", existingNames: twenty }),
	);
	const memory500 = "中".repeat(500);
	assert.equal(validateManagedDocumentWrite({ name: "Memory.md", content: memory500, existingNames: ["Memory.md"] }), 500);
	assert.throws(
		() => validateManagedDocumentWrite({ name: "Memory.md", content: `${memory500}文`, existingNames: ["Memory.md"] }),
		(error: unknown) => (error as { code?: string }).code === "MEMORY_WORD_LIMIT",
	);
});
