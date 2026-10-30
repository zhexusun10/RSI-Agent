import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertManagedDocumentName,
	inspectManagedMarkdownPath,
	listManagedMarkdownNames,
} from "../src/shared/index.ts";

async function makeRoot() {
	return mkdtemp(join(tmpdir(), "rsi-docs-"));
}

test("managed names are flat Markdown names", () => {
	assert.equal(assertManagedDocumentName("architecture.md"), "architecture.md");
	assert.equal(assertManagedDocumentName("记忆.md"), "记忆.md");
	for (const name of ["../x.md", "sub/x.md", ".hidden.md", "a|b.md", "x.txt", "x.MD"]) {
		assert.throws(() => assertManagedDocumentName(name), /Managed Markdown/);
	}
});

test("managed path inspection rejects hardlinks and missing paths", async () => {
	const root = await makeRoot();
	try {
		await writeFile(join(root, "a.md"), "one\n");
		const missing = await inspectManagedMarkdownPath(root, "missing.md", { allowMissing: true });
		assert.equal(missing.exists, false);
		await assert.rejects(
			() => inspectManagedMarkdownPath(root, "missing.md"),
			(error: unknown) => (error as { code?: string }).code === "DOCUMENT_NOT_FOUND",
		);
		await link(join(root, "a.md"), join(root, "b.md"));
		await assert.rejects(
			() => inspectManagedMarkdownPath(root, "a.md"),
			(error: unknown) => (error as { code?: string }).code === "PATH_HARDLINK_FORBIDDEN",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("managed listing rejects nested directories", async () => {
	const root = await makeRoot();
	try {
		await writeFile(join(root, "a.md"), "one\n");
		assert.deepEqual((await listManagedMarkdownNames(root)).names, ["a.md"]);
		await mkdir(join(root, "nested"));
		await assert.rejects(
			() => listManagedMarkdownNames(root),
			(error: unknown) => (error as { code?: string }).code === "DOCUMENT_NAME_INVALID",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("managed listing rejects symlinks when the platform permits creating one", async () => {
	const root = await makeRoot();
	try {
		await writeFile(join(root, "a.md"), "one\n");
		try {
			await symlink(join(root, "a.md"), join(root, "alias.md"));
		} catch {
			return;
		}
		await assert.rejects(
			() => listManagedMarkdownNames(root),
			(error: unknown) => (error as { code?: string }).code === "PATH_SYMLINK_FORBIDDEN",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
