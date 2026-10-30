import assert from "node:assert/strict";
import { link, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	createKnowledgeFixture,
	errorCode,
	fileTimes,
	makeIndex,
	readBytes,
} from "./helpers.ts";
import { KnowledgeService } from "../../src/knowledge/index.ts";
import { INDEX_FILENAME } from "../../src/shared/documents.ts";
import { MEMORY_FILENAME } from "../../src/shared/paths.ts";
import { countWords } from "../../src/shared/words.ts";

function words(count: number): string {
	return Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
}

test("managed documents accept 1000 words, reject 1001, and leave old bytes intact", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const created = await fixture.service.commit({
			name: "limit.md",
			content: words(1_000),
			expectedRevision: null,
			operation: "write",
		});
		assert.equal(created.words, 1_000);
		const before = await readBytes(join(fixture.markdownsDir, "limit.md"));
		await assert.rejects(
			() =>
				fixture.service.commit({
					name: "limit.md",
					content: words(1_001),
					expectedRevision: created.revision,
					operation: "write",
				}),
			(error: unknown) => errorCode(error) === "DOCUMENT_WORD_LIMIT",
		);
		assert.deepEqual(await readBytes(join(fixture.markdownsDir, "limit.md")), before);
		await assert.rejects(
			() =>
				fixture.service.commit({
					name: "over.md",
					content: words(1_001),
					expectedRevision: null,
					operation: "write",
				}),
			(error: unknown) => errorCode(error) === "DOCUMENT_WORD_LIMIT",
		);
		await assert.rejects(
			() => fixture.service.read("over.md"),
			(error: unknown) => errorCode(error) === "DOCUMENT_NOT_FOUND",
		);
	} finally {
		await fixture.cleanup();
	}
});

test("the 20-file quota includes Memory.md and index.md and rejects 21 atomically", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		for (let index = 0; index < 18; index++) {
			await fixture.service.commit({
				name: `doc-${index}.md`,
				content: `document ${index}`,
				expectedRevision: null,
				operation: "write",
			});
		}
		assert.equal((await fixture.service.list()).length, 20);
		const beforeNames = (await readdir(fixture.markdownsDir)).sort();
		await assert.rejects(
			() =>
				fixture.service.commit({
					name: "doc-21.md",
					content: "one too many",
					expectedRevision: null,
					operation: "write",
				}),
			(error: unknown) => errorCode(error) === "DOCUMENT_COUNT_LIMIT",
		);
		assert.deepEqual((await readdir(fixture.markdownsDir)).sort(), beforeNames);
		assert.equal((await fixture.service.list()).length, 20);
	} finally {
		await fixture.cleanup();
	}
});

test("create, replace, rename, and delete keep constraints and never rewrite index descriptions", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const indexBefore = await readBytes(join(fixture.markdownsDir, INDEX_FILENAME));
		const indexTimes = await fileTimes(join(fixture.markdownsDir, INDEX_FILENAME));
		const a = await fixture.service.commit({
			name: "a.md",
			content: "alpha",
			expectedRevision: null,
			operation: "write",
		});
		assert.ok(a.indexWarnings.some((warning) => warning.includes("a.md")));
		const b = await fixture.service.commit({
			name: "b.md",
			content: "beta",
			expectedRevision: null,
			operation: "write",
		});
		const replaced = await fixture.service.replaceDocument("a.md", "alpha replaced", a.revision);
		assert.equal((await fixture.service.read("a.md")).content, "alpha replaced");
		await assert.rejects(
			() => fixture.service.replaceDocument("a.md", "stale", a.revision),
			(error: unknown) => errorCode(error) === "DOCUMENT_REVISION_CONFLICT",
		);
		assert.equal((await fixture.service.read("a.md")).content, "alpha replaced");

		const renamed = await fixture.service.renameDocument("b.md", "c.md", b.revision);
		assert.equal(renamed.created, false);
		await assert.rejects(
			() => fixture.service.read("b.md"),
			(error: unknown) => errorCode(error) === "DOCUMENT_NOT_FOUND",
		);
		assert.equal((await fixture.service.read("c.md")).content, "beta");
		await assert.rejects(
			() => fixture.service.renameDocument("c.md", "nested/c.md", replaced.revision),
			(error: unknown) => errorCode(error) === "DOCUMENT_NAME_INVALID",
		);
		await assert.rejects(
			() => fixture.service.renameDocument("c.md", "../c.md", renamed.revision),
			(error: unknown) => errorCode(error) === "DOCUMENT_NAME_INVALID",
		);
		await assert.rejects(
			() => fixture.service.renameDocument("c.md", INDEX_FILENAME, renamed.revision),
			(error: unknown) => errorCode(error) === "DOCUMENT_NAME_INVALID",
		);
		await assert.rejects(
			() => fixture.service.deleteDocument(MEMORY_FILENAME, "sha256:any"),
			(error: unknown) => errorCode(error) === "DOCUMENT_NAME_INVALID",
		);
		await assert.rejects(
			() => fixture.service.deleteDocument(INDEX_FILENAME, "sha256:any"),
			(error: unknown) => errorCode(error) === "DOCUMENT_NAME_INVALID",
		);

		const deleted = await fixture.service.deleteDocument("c.md", renamed.revision);
		assert.equal(deleted.deleted, true);
		await assert.rejects(
			() => fixture.service.read("c.md"),
			(error: unknown) => errorCode(error) === "DOCUMENT_NOT_FOUND",
		);
		const audit = await fixture.service.auditIndex();
		assert.equal(audit.consistent, false);
		assert.ok(audit.unlistedFiles.includes("a.md"));
		assert.deepEqual(await readBytes(join(fixture.markdownsDir, INDEX_FILENAME)), indexBefore);
		assert.equal((await fileTimes(join(fixture.markdownsDir, INDEX_FILENAME))).mtimeMs, indexTimes.mtimeMs);
	} finally {
		await fixture.cleanup();
	}
});

test("concurrent creates and edits produce one winner and explicit conflicts", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const second = await fixture.open();
		const createResults = await Promise.allSettled([
			fixture.service.commit({
				name: "race.md",
				content: "first writer",
				expectedRevision: null,
				operation: "write",
			}),
			second.commit({
				name: "race.md",
				content: "second writer",
				expectedRevision: null,
				operation: "write",
			}),
		]);
		const fulfilled = createResults.filter((result) => result.status === "fulfilled");
		const rejected = createResults.filter((result) => result.status === "rejected");
		assert.equal(fulfilled.length, 1);
		assert.equal(rejected.length, 1);
		assert.equal(errorCode((rejected[0] as PromiseRejectedResult).reason), "DOCUMENT_REVISION_CONFLICT");
		const raceContent = (await fixture.service.read("race.md")).content;
		assert.ok(["first writer", "second writer"].includes(raceContent));

		const base = await fixture.service.read("race.md");
		const editResults = await Promise.allSettled([
			fixture.service.editDocument("race.md", [{ oldText: raceContent, newText: "edited one" }], base.revision),
			second.editDocument("race.md", [{ oldText: raceContent, newText: "edited two" }], base.revision),
		]);
		assert.equal(editResults.filter((result) => result.status === "fulfilled").length, 1);
		assert.equal(editResults.filter((result) => result.status === "rejected").length, 1);
		const final = await fixture.service.read("race.md");
		assert.ok(["edited one", "edited two"].includes(final.content));
		assert.equal((await fixture.service.consistency()).warnings.some((warning) => warning.includes("race.md")), true);
	} finally {
		await fixture.cleanup();
	}
});

test("a concurrent Memory CAS has exactly one winner and never exposes torn bytes", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const second = await fixture.open();
		const empty = await fixture.service.readCurrentMemory();
		const results = await Promise.allSettled([
			fixture.service.commitMemory({ content: "memory one", expectedRevision: empty.revision }),
			second.commitMemory({ content: "memory two", expectedRevision: empty.revision }),
		]);
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		assert.equal(results.filter((result) => result.status === "rejected").length, 1);
		const next = await fixture.service.readCurrentMemory();
		assert.ok(["memory one", "memory two"].includes(next.content));
		assert.equal(next.words, countWords(next.content));
	} finally {
		await fixture.cleanup();
	}
});

test("symlinks, hardlinks, and non-UTF-8 documents fail closed", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await writeFile(join(fixture.markdownsDir, "safe.md"), "safe");
		let symlinkCreated = false;
		try {
			await symlink(join(fixture.markdownsDir, "safe.md"), join(fixture.markdownsDir, "alias.md"));
			symlinkCreated = true;
		} catch {
			// Windows without symlink privilege cannot create this fixture.
		}
		if (symlinkCreated) {
			await assert.rejects(
				() => fixture.service.list(),
				(error: unknown) => errorCode(error) === "PATH_SYMLINK_FORBIDDEN",
			);
			await rm(join(fixture.markdownsDir, "alias.md"), { force: true });
		}

		await link(join(fixture.markdownsDir, "safe.md"), join(fixture.markdownsDir, "hard.md"));
		await assert.rejects(
			() => fixture.service.read("safe.md"),
			(error: unknown) => errorCode(error) === "PATH_HARDLINK_FORBIDDEN",
		);
		await rm(join(fixture.markdownsDir, "hard.md"), { force: true });

		await writeFile(join(fixture.markdownsDir, "broken.md"), Buffer.from([0xff, 0xfe, 0xfd]));
		await assert.rejects(
			() => fixture.service.read("broken.md"),
			(error: unknown) => errorCode(error) === "INTERNAL" && /UTF-8/u.test((error as Error).message),
		);
		await assert.rejects(
			() => fixture.open(),
			(error: unknown) => errorCode(error) === "INTERNAL",
		);
	} finally {
		await fixture.cleanup();
	}
});

test("deleting or replacing the markdowns directory blocks further commits", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const memory = await fixture.service.readCurrentMemory();
		await rename(fixture.markdownsDir, `${fixture.markdownsDir}-old`);
		await mkdir(fixture.markdownsDir);
		await writeFile(join(fixture.markdownsDir, MEMORY_FILENAME), "");
		await writeFile(join(fixture.markdownsDir, INDEX_FILENAME), makeIndex([{ name: INDEX_FILENAME, description: "Index", location: `[${INDEX_FILENAME}](${INDEX_FILENAME})` }]));
		await assert.rejects(
			() =>
				fixture.service.commitMemory({
					content: "should not commit",
					expectedRevision: memory.revision,
				}),
			(error: unknown) => errorCode(error) === "PATH_INVALID",
		);
		await assert.rejects(
			() => fixture.service.readCurrentMemory(),
			(error: unknown) => errorCode(error) === "PATH_INVALID",
		);
	} finally {
		await fixture.cleanup();
	}
});

test("documents outside markdowns are unmanaged and do not affect the index", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const vendorDir = join(fixture.baseDir, "workspace", "node_modules", "vendor");
		await mkdir(vendorDir, { recursive: true });
		await writeFile(join(vendorDir, "README.md"), "# Vendor documentation\n");
		const consistency = await fixture.service.consistency();
		assert.equal(consistency.consistent, true);
		assert.equal((await fixture.service.list()).length, 2);
		const audit = await fixture.service.auditIndex();
		assert.equal(audit.unlistedFiles.includes("README.md"), false);
	} finally {
		await fixture.cleanup();
	}
});

test("opening a second service over the same state works after restart", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const initial = await fixture.service.readCurrentMemory();
		await fixture.service.commitMemory({ content: "persisted", expectedRevision: initial.revision });
		const reopened = await KnowledgeService.open({
			markdownsDir: fixture.markdownsDir,
			stateDir: fixture.stateDir,
			readStatsFile: fixture.readStatsFile,
			clock: fixture.clock,
			timeZone: "UTC",
		});
		assert.equal((await reopened.readCurrentMemory()).content, "persisted");
	} finally {
		await fixture.cleanup();
	}
});

test("NUL and unpaired-surrogate content is rejected before any file is created", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await assert.rejects(
			() =>
				fixture.service.commit({
					name: "nul.md",
					content: "bad\u0000content",
					expectedRevision: null,
					operation: "write",
				}),
			(error: unknown) => errorCode(error) === "INTERNAL",
		);
		await assert.rejects(
			() =>
				fixture.service.commit({
					name: "surrogate.md",
					content: "bad\uD800content",
					expectedRevision: null,
					operation: "write",
				}),
			(error: unknown) => errorCode(error) === "INTERNAL",
		);
		await assert.rejects(
			() => fixture.service.read("nul.md"),
			(error: unknown) => errorCode(error) === "DOCUMENT_NOT_FOUND",
		);
		await assert.rejects(
			() => fixture.service.read("surrogate.md"),
			(error: unknown) => errorCode(error) === "DOCUMENT_NOT_FOUND",
		);
	} finally {
		await fixture.cleanup();
	}
});
