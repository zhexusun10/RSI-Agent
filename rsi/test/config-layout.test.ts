import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	parseRsiConfig,
	readImmutableSystemPrompt,
	verifyRuntimeLayout,
} from "../src/shared/index.ts";

async function makeConfigRoot() {
	const root = await mkdtemp(join(tmpdir(), "rsi-config-"));
	const dirs = ["workspace", "data", "state", "pi", "rsi", "data/markdowns"].map((part) => join(root, part));
	await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
	const systemPromptFile = join(root, "manual-prompt.txt");
	await writeFile(systemPromptFile, "external fixture text, not an agent prompt\n", "utf8");
	return {
		root,
		systemPromptFile,
		input: {
			version: 1,
			timeZone: "UTC",
			paths: {
				workspaceDir: join(root, "workspace"),
				dataDir: join(root, "data"),
				stateDir: join(root, "state"),
				piSourceDir: join(root, "pi"),
				rsiSourceDir: join(root, "rsi"),
				systemPromptFile,
			},
		},
	};
}

test("config derives the required markdown paths and defaults", async () => {
	const fixture = await makeConfigRoot();
	try {
		const config = parseRsiConfig(fixture.input);
		assert.equal(config.timeZone, "UTC");
		assert.equal(config.paths.markdownsDir, resolve(fixture.root, "data", "markdowns"));
		assert.equal(config.paths.memoryFile, resolve(fixture.root, "data", "markdowns", "Memory.md"));
		assert.equal(config.paths.indexFile, resolve(fixture.root, "data", "markdowns", "index.md"));
		assert.equal(config.ipc.maxFrameBytes, 1_048_576);
		assert.equal(config.sandbox.network, "unrestricted");
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("config rejects unknown keys, bad prompt extensions, and unsafe overlaps", async () => {
	const fixture = await makeConfigRoot();
	try {
		assert.throws(() => parseRsiConfig({ ...fixture.input, extra: true }), /Unknown/);
		assert.throws(
			() =>
				parseRsiConfig({
					...fixture.input,
					paths: { ...fixture.input.paths, systemPromptFile: join(fixture.root, "prompt.md") },
				}),
			/\.txt/,
		);
		assert.throws(
			() =>
				parseRsiConfig({
					...fixture.input,
					paths: { ...fixture.input.paths, dataDir: join(fixture.root, "workspace", "data") },
				}),
			/disjoint|overlap/i,
		);
		assert.throws(
			() =>
				parseRsiConfig({
					...fixture.input,
					ipc: { heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 },
				}),
			/greater/,
		);
		assert.throws(
			() => parseRsiConfig({ ...fixture.input, timeZone: "Not/AZone" }),
			/CONFIG_INVALID|Invalid IANA/,
		);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("runtime layout verification canonicalizes paths and fails closed on a missing prompt", async () => {
	const fixture = await makeConfigRoot();
	try {
		const config = parseRsiConfig(fixture.input);
		const verified = await verifyRuntimeLayout(config.paths);
		assert.equal(verified.markdownNames.length, 0);
		assert.equal(verified.manualPrompt.path, fixture.systemPromptFile);
		await rm(fixture.systemPromptFile);
		await assert.rejects(
			() => verifyRuntimeLayout(config.paths),
			(error: unknown) => (error as { code?: string }).code === "PROMPT_MISSING",
		);
		await writeFile(fixture.systemPromptFile, "restored fixture\n");
		await assert.rejects(
			() => readImmutableSystemPrompt(fixture.systemPromptFile + ".missing"),
			(error: unknown) => (error as { code?: string }).code === "PROMPT_MISSING",
		);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});
