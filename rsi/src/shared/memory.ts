import { RsiError } from "./errors.ts";
import { EMPTY_CONTENT_REVISION, sha256Text, type ContentRevision } from "./hash.ts";
import { MEMORY_FILENAME } from "./paths.ts";
import { MEMORY_MAX_WORDS } from "./policy.ts";
import { assertWordLimit, countWords } from "./words.ts";

export { MEMORY_FILENAME, MEMORY_MAX_WORDS };

export interface MemorySnapshot {
	readonly name: typeof MEMORY_FILENAME;
	readonly content: string;
	readonly words: number;
	readonly maxWords: typeof MEMORY_MAX_WORDS;
	readonly revision: ContentRevision;
	readonly updatedAtMs: number;
}

export interface MemoryValidation {
	readonly ok: boolean;
	readonly words: number;
	readonly maxWords: typeof MEMORY_MAX_WORDS;
	readonly usage: string;
}

/** Exactly the metadata suffix required after a successful Memory modification. */
export function formatMemoryUsage(words: number, maxWords: number = MEMORY_MAX_WORDS): string {
	if (!Number.isInteger(words) || words < 0 || !Number.isInteger(maxWords) || maxWords < 0) {
		throw new RsiError("INTERNAL", "Memory usage values must be non-negative integers.");
	}
	return `[System Meta: Current Memory Usage: ${words} / ${maxWords} words]`;
}

export function validateMemoryContent(content: string): MemoryValidation {
	const words = assertWordLimit(content, MEMORY_MAX_WORDS, "MEMORY_WORD_LIMIT", MEMORY_FILENAME);
	return { ok: true, words, maxWords: MEMORY_MAX_WORDS, usage: formatMemoryUsage(words) };
}

/** Check a proposed Memory update without any write. The caller must keep old bytes on failure. */
export function evaluateMemoryUpdate(current: string, next: string): {
	readonly ok: true;
	readonly content: string;
	readonly words: number;
	readonly revision: ContentRevision;
	readonly usage: string;
} {
	const words = countWords(next);
	if (words > MEMORY_MAX_WORDS) {
		throw new RsiError("MEMORY_WORD_LIMIT", `Memory.md exceeds ${MEMORY_MAX_WORDS} words (found ${words}).`, {
			details: { words, maxWords: MEMORY_MAX_WORDS, currentRevision: sha256Text(current) },
		});
	}
	return {
		ok: true,
		content: next,
		words,
		revision: sha256Text(next),
		usage: formatMemoryUsage(words),
	};
}

export function createMemorySnapshot(input: {
	content: string;
	updatedAtMs: number;
}): MemorySnapshot {
	const words = countWords(input.content);
	if (words > MEMORY_MAX_WORDS) {
		throw new RsiError("MEMORY_WORD_LIMIT", `Memory.md exceeds ${MEMORY_MAX_WORDS} words (found ${words}).`);
	}
	return {
		name: MEMORY_FILENAME,
		content: input.content,
		words,
		maxWords: MEMORY_MAX_WORDS,
		revision: input.content.length === 0 ? EMPTY_CONTENT_REVISION : sha256Text(input.content),
		updatedAtMs: input.updatedAtMs,
	};
}
