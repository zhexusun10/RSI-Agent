import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createMemorySnapshot,
	evaluateMemoryUpdate,
	formatMemoryUsage,
	injectMemoryAtRequestBoundary,
	MEMORY_MAX_WORDS,
	validateMemoryContent,
} from "../src/shared/index.ts";

test("Memory validation caps at 500 words and reports exact metadata", () => {
	const memory = "中".repeat(500);
	assert.equal(validateMemoryContent(memory).words, 500);
	assert.equal(validateMemoryContent(memory).usage, "[System Meta: Current Memory Usage: 500 / 500 words]");
	assert.throws(
		() => evaluateMemoryUpdate("old", `${memory}文`),
		(error: unknown) => (error as { code?: string }).code === "MEMORY_WORD_LIMIT",
	);
	assert.equal(formatMemoryUsage(7), "[System Meta: Current Memory Usage: 7 / 500 words]");
});

test("Memory snapshots have a revision and empty Memory starts at zero", () => {
	const empty = createMemorySnapshot({ content: "", updatedAtMs: 1 });
	assert.equal(empty.words, 0);
	assert.equal(empty.maxWords, MEMORY_MAX_WORDS);
	assert.equal(empty.revision, "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	const changed = createMemorySnapshot({ content: "new", updatedAtMs: 2 });
	assert.notEqual(changed.revision, empty.revision);
});

test("latest Memory is injected into the leading system message at a request boundary", () => {
	const originalSystem = {
		role: "system" as const,
		content: "MANUAL",
		sections: { rules: "R", memory: "OLD" },
		timestamp: 1,
	};
	const user = { role: "user" as const, content: "hello", timestamp: 2 };
	const laterSystem = {
		role: "system" as const,
		content: "",
		sections: { memory: "STALE", tools: "T" },
		timestamp: 3,
	};
	const messages = [originalSystem, user, laterSystem] as unknown as AgentMessage[];
	const result = injectMemoryAtRequestBoundary(messages, { content: "NEW MEMORY" });
	assert.equal(result.length, 2);
	assert.equal(result[0]?.role, "system");
	const head = result[0] as { sections?: Record<string, string | null> };
	assert.equal(head.sections?.memory, "NEW MEMORY");
	assert.equal(head.sections?.rules, "R");
	assert.equal(head.sections?.tools, "T");
	assert.equal(result[1]?.role, "user");
	assert.equal(originalSystem.sections.memory, "OLD");
	assert.equal(messages.length, 3);
});

test("Memory injection fails closed without a system message", () => {
	const messages = [{ role: "user" as const, content: "hello", timestamp: 1 }] as unknown as AgentMessage[];
	assert.throws(
		() => injectMemoryAtRequestBoundary(messages, { content: "x" }),
		(error: unknown) => (error as { code?: string }).code === "INTERNAL",
	);
});
