import { RsiError } from "./errors.ts";

const WORD_CODE_POINT = /[\p{L}\p{N}]/u;
const MARK_CODE_POINT = /\p{M}/u;
const HAN = /\p{Script=Han}/u;
const HIRAGANA = /\p{Script=Hiragana}/u;
const KATAKANA = /\p{Script=Katakana}/u;
const HANGUL = /\p{Script=Hangul}/u;
const APOSTROPHES = new Set(["\u0027", "\u2019"]);

/** True when the code point is counted as one word by itself. */
export function isStandaloneWordCodePoint(codePoint: string): boolean {
	return HAN.test(codePoint) || HIRAGANA.test(codePoint) || KATAKANA.test(codePoint) || HANGUL.test(codePoint);
}

function isWordCodePoint(codePoint: string): boolean {
	return WORD_CODE_POINT.test(codePoint) || MARK_CODE_POINT.test(codePoint);
}

function isJoinableApostrophe(text: string, index: number, inRun: boolean): boolean {
	if (!inRun || !APOSTROPHES.has(text[index] ?? "")) return false;
	const next = text[index + 1];
	return next !== undefined && isWordCodePoint(next) && !isStandaloneWordCodePoint(next);
}

/**
 * Count words with a deterministic Unicode code-point algorithm.
 *
 * Definition:
 * - NFC normalization is applied only to the counting copy.
 * - Each Han, Hiragana, Katakana, or Hangul letter is one word. A Chinese
 *   paragraph therefore has one word per ideograph, never one word total.
 * - A maximal run of other Unicode letters/numbers/marks is one word.
 * - U+0027 and U+2019 join a run only when both sides are non-CJK word code points.
 * - Combining marks never start a word.
 * - Punctuation, symbols, emoji, and whitespace are not words. Hyphens split,
 *   decimal points split, and URLs split at punctuation.
 */
export function countWords(input: string): number {
	const text = input.normalize("NFC");
	let count = 0;
	let inRun = false;

	for (let index = 0; index < text.length; ) {
		const codePoint = String.fromCodePoint(text.codePointAt(index) ?? 0);
		const width = codePoint.length;
		if (isJoinableApostrophe(text, index, inRun)) {
			index += width;
			continue;
		}
		if (isStandaloneWordCodePoint(codePoint)) {
			count++;
			inRun = false;
			index += width;
			continue;
		}
		if (MARK_CODE_POINT.test(codePoint)) {
			// Marks belong to the preceding code point and never create a token.
			index += width;
			continue;
		}
		if (isWordCodePoint(codePoint)) {
			if (!inRun) count++;
			inRun = true;
			index += width;
			continue;
		}
		inRun = false;
		index += width;
	}

	return count;
}

export interface WordLimitResult {
	readonly ok: boolean;
	readonly words: number;
	readonly maxWords: number;
	readonly remaining: number;
}

/** Evaluate a word cap without mutating the supplied text. */
export function evaluateWordLimit(input: string, maxWords: number): WordLimitResult {
	if (!Number.isInteger(maxWords) || maxWords < 0) {
		throw new RsiError("INTERNAL", "maxWords must be a non-negative integer.");
	}
	const words = countWords(input);
	return {
		ok: words <= maxWords,
		words,
		maxWords,
		remaining: Math.max(0, maxWords - words),
	};
}

/** Throw when text exceeds a word cap. The caller must not write on this error. */
export function assertWordLimit(
	input: string,
	maxWords: number,
	code: "MEMORY_WORD_LIMIT" | "DOCUMENT_WORD_LIMIT",
	label: string,
): number {
	const result = evaluateWordLimit(input, maxWords);
	if (!result.ok) {
		throw new RsiError(code, `${label} exceeds ${maxWords} words (found ${result.words}).`, {
			details: { words: result.words, maxWords },
		});
	}
	return result.words;
}
