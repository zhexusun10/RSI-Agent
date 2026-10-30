import assert from "node:assert/strict";
import test from "node:test";
import {
	assertWordLimit,
	countWords,
	evaluateWordLimit,
	formatMemoryUsage,
	MEMORY_MAX_WORDS,
	validateMemoryContent,
} from "../src/shared/index.ts";

test("countWords counts English runs and splits punctuation", () => {
	assert.equal(countWords(""), 0);
	assert.equal(countWords("hello world"), 2);
	assert.equal(countWords("don't stop"), 2);
	assert.equal(countWords("state-of-the-art"), 4);
	assert.equal(countWords("hello,world"), 2);
	assert.equal(countWords("C++"), 1);
	assert.equal(countWords("3.14"), 2);
	assert.equal(countWords("https://example.com/a"), 4);
});

test("countWords counts each CJK letter instead of one paragraph", () => {
	assert.equal(countWords("你好世界"), 4);
	assert.equal(countWords("人工智能"), 4);
	assert.equal(countWords("こんにちは"), 5);
	assert.equal(countWords("한국어"), 3);
});

test("countWords handles mixed text, marks, and emoji deterministically", () => {
	assert.equal(countWords("GPT-4 支持中文"), 6);
	assert.equal(countWords("e\u0301"), 1);
	assert.equal(countWords("ok 😀 done"), 2);
	assert.equal(countWords("中A文B"), 4);
});

test("word limits and Memory metadata are exact", () => {
	const fiveHundred = "中".repeat(MEMORY_MAX_WORDS);
	const over = `${fiveHundred}文`;
	assert.equal(countWords(fiveHundred), MEMORY_MAX_WORDS);
	assert.equal(evaluateWordLimit(fiveHundred, MEMORY_MAX_WORDS).ok, true);
	assert.equal(evaluateWordLimit(over, MEMORY_MAX_WORDS).ok, false);
	assert.throws(
		() => assertWordLimit(over, MEMORY_MAX_WORDS, "MEMORY_WORD_LIMIT", "Memory.md"),
		(error: unknown) => (error as { code?: string }).code === "MEMORY_WORD_LIMIT",
	);
	assert.equal(validateMemoryContent(fiveHundred).usage, "[System Meta: Current Memory Usage: 500 / 500 words]");
	assert.equal(formatMemoryUsage(0), "[System Meta: Current Memory Usage: 0 / 500 words]");
});
