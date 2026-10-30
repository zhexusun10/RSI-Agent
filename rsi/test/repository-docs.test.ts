import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	auditIndex,
	countWords,
	INDEX_COLUMNS,
	listManagedMarkdownNames,
	MANAGED_DOCUMENT_MAX_WORDS,
	MAX_MANAGED_DOCUMENTS,
} from "../src/shared/index.ts";

const markdownsDir = fileURLToPath(new URL("../../markdowns", import.meta.url));

test("root markdowns/ index and documents are internally consistent", async () => {
	const listing = await listManagedMarkdownNames(markdownsDir);
	assert.ok(listing.names.length <= MAX_MANAGED_DOCUMENTS);
	for (const name of ["Memory.md", "architecture.md", "index.md", "operations.md", "security.md"]) {
		assert.ok(listing.names.includes(name), `the seed must contain ${name}`);
	}
	const index = await readFile(join(markdownsDir, "index.md"), "utf8");
	assert.match(index, new RegExp(INDEX_COLUMNS.join(" \| ")));
	const audit = auditIndex(index, listing.names);
	assert.equal(audit.consistent, true, audit.warnings.join("; "));
	assert.deepEqual(audit.missingFiles, []);
	assert.deepEqual(audit.unlistedFiles, []);
	assert.deepEqual(audit.duplicateEntries, []);
	for (const name of listing.names) {
		const content = await readFile(join(markdownsDir, name), "utf8");
		assert.ok(countWords(content) <= MANAGED_DOCUMENT_MAX_WORDS, `${name} exceeds the word cap`);
	}
	const architecture = await readFile(join(markdownsDir, "architecture.md"), "utf8");
	assert.ok(countWords(architecture) <= 1_000);
	assert.ok(countWords(index) <= 1_000);
});
