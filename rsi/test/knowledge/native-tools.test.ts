import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	createEditToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createManagedNativeToolOperations } from "../../src/knowledge/native-tools.ts";
import { createKnowledgeFixture, errorCode, readBytes } from "./helpers.ts";

test("native write through broker operations preserves create and overwrite messages", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const operations = createManagedNativeToolOperations(fixture.service);
		const definition = createWriteToolDefinition(fixture.markdownsDir, { operations: operations.write });
		const first = await definition.execute(
			"write-1",
			{ path: join(fixture.markdownsDir, "native-write.md"), content: "first" },
			undefined,
			undefined,
			{ cwd: fixture.markdownsDir } as never,
		);
		assert.equal(first.content[0]?.type, "text");
		assert.match((first.content[0] as { text: string }).text, /Successfully wrote to/u);
		assert.equal((await fixture.service.read("native-write.md")).content, "first");

		await definition.execute(
			"write-2",
			{ path: join(fixture.markdownsDir, "native-write.md"), content: "second" },
			undefined,
			undefined,
			{ cwd: fixture.markdownsDir } as never,
		);
		assert.equal((await fixture.service.read("native-write.md")).content, "second");
	} finally {
		await fixture.cleanup();
	}
});

test("native edit through broker operations preserves CRLF, BOM, fuzzy matching, and details", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		await fixture.service.commit({
			name: "crlf.md",
			content: "line one\r\nline two\r\n",
			expectedRevision: null,
			operation: "write",
		});
		await fixture.service.commit({
			name: "bom.md",
			content: "\uFEFFhello world\n",
			expectedRevision: null,
			operation: "write",
		});
		await fixture.service.commit({
			name: "fuzzy.md",
			content: "“smart quotes” and a dash – here\n",
			expectedRevision: null,
			operation: "write",
		});
		const operations = createManagedNativeToolOperations(fixture.service);
		const definition = createEditToolDefinition(fixture.markdownsDir, { operations: operations.edit });

		const crlf = await definition.execute(
			"edit-crlf",
			{ path: join(fixture.markdownsDir, "crlf.md"), edits: [{ oldText: "line two", newText: "LINE TWO" }] },
			undefined,
			undefined,
			{ cwd: fixture.markdownsDir } as never,
		);
		assert.match((crlf.content[0] as { text: string }).text, /Successfully replaced 1 block/u);
		assert.equal((await fixture.service.read("crlf.md")).content, "line one\r\nLINE TWO\r\n");
		assert.equal(typeof (crlf.details as { diff?: unknown }).diff, "string");

		await definition.execute(
			"edit-bom",
			{ path: join(fixture.markdownsDir, "bom.md"), edits: [{ oldText: "hello world", newText: "changed" }] },
			undefined,
			undefined,
			{ cwd: fixture.markdownsDir } as never,
		);
		assert.equal((await fixture.service.read("bom.md")).content, "\uFEFFchanged\n");

		await definition.execute(
			"edit-fuzzy",
			{
				path: join(fixture.markdownsDir, "fuzzy.md"),
				edits: [
					{ oldText: "\"smart quotes\"", newText: "'plain'" },
					{ oldText: "dash - here", newText: "dash and here" },
				],
			},
			undefined,
			undefined,
			{ cwd: fixture.markdownsDir } as never,
		);
		assert.equal((await fixture.service.read("fuzzy.md")).content, "'plain' and a dash and here\n");
	} finally {
		await fixture.cleanup();
	}
});

test("native edit failures leave the document unchanged and surface native messages", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const created = await fixture.service.commit({
			name: "edit-fail.md",
			content: "only one match\n",
			expectedRevision: null,
			operation: "write",
		});
		const before = await readBytes(join(fixture.markdownsDir, "edit-fail.md"));
		const operations = createManagedNativeToolOperations(fixture.service);
		const definition = createEditToolDefinition(fixture.markdownsDir, { operations: operations.edit });
		await assert.rejects(
			() =>
				definition.execute(
					"edit-missing",
					{ path: join(fixture.markdownsDir, "edit-fail.md"), edits: [{ oldText: "not present", newText: "x" }] },
					undefined,
					undefined,
					{ cwd: fixture.markdownsDir } as never,
				),
			/Could not find the exact text/u,
		);
		assert.deepEqual(await readBytes(join(fixture.markdownsDir, "edit-fail.md")), before);
		assert.equal((await fixture.service.read("edit-fail.md")).revision, created.revision);
	} finally {
		await fixture.cleanup();
	}
});

test("broker operations reject unmanaged paths, nested parents, and aliases", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const operations = createManagedNativeToolOperations(fixture.service);
		const outside = join(fixture.baseDir, "workspace", "outside.md");
		await mkdir(join(fixture.baseDir, "workspace"));
		await writeFile(outside, "outside");
		await assert.rejects(
			() => operations.read.readFile(outside),
			(error: unknown) => errorCode(error) === "PATH_OUTSIDE_ROOT",
		);
		await assert.rejects(
			() => operations.write.writeFile(outside, "changed"),
			(error: unknown) => errorCode(error) === "PATH_OUTSIDE_ROOT",
		);
		await assert.rejects(
			() => operations.edit.readFile(outside),
			(error: unknown) => errorCode(error) === "PATH_OUTSIDE_ROOT",
		);
		await assert.rejects(
			() => operations.write.mkdir(join(fixture.markdownsDir, "nested")),
			(error: unknown) => errorCode(error) === "DOCUMENT_NAME_INVALID",
		);
		assert.equal(await readFile(outside, "utf8"), "outside");

		let symlinkCreated = false;
		try {
			await symlink(fixture.markdownsDir, join(fixture.baseDir, "workspace", "alias-dir"));
			symlinkCreated = true;
		} catch {
			// Windows without symlink privilege cannot create this integration fixture.
		}
		if (symlinkCreated) {
			await assert.rejects(
				() => operations.read.readFile(join(fixture.baseDir, "workspace", "alias-dir", "index.md")),
				(error: unknown) => errorCode(error) === "PATH_SYMLINK_FORBIDDEN",
			);
		}
	} finally {
		await fixture.cleanup();
	}
});

test("managed edit result is rejected atomically when the edit crosses 1000 words", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const created = await fixture.service.commit({
			name: "large-edit.md",
			content: "start",
			expectedRevision: null,
			operation: "write",
		});
		const before = await readBytes(join(fixture.markdownsDir, "large-edit.md"));
		const over = Array.from({ length: 1_001 }, (_, index) => `w${index}`).join(" ");
		await assert.rejects(
			() =>
				fixture.service.editDocument(
					"large-edit.md",
					[{ oldText: "start", newText: over }],
					created.revision,
				),
			(error: unknown) => errorCode(error) === "DOCUMENT_WORD_LIMIT",
		);
		assert.deepEqual(await readBytes(join(fixture.markdownsDir, "large-edit.md")), before);
	} finally {
		await fixture.cleanup();
	}
});
