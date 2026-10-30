import { posix } from "node:path";
import { RsiError } from "./errors.ts";
import { MEMORY_FILENAME, INDEX_FILENAME } from "./paths.ts";
import { assertManagedDocumentName } from "./managed-path.ts";
import { MAX_MANAGED_DOCUMENTS, MEMORY_MAX_WORDS, MANAGED_DOCUMENT_MAX_WORDS } from "./policy.ts";
import { formatTimestamp } from "./time.ts";
import { assertWordLimit, countWords } from "./words.ts";

export { INDEX_FILENAME, MEMORY_FILENAME };

/** The required index header, in order. */
export const INDEX_COLUMNS = ["md名", "description", "链接位置"] as const;

export interface IndexRow {
	readonly name: string;
	readonly description: string;
	readonly location: string;
	readonly line: number;
}

export interface IndexParseResult {
	readonly headerFound: boolean;
	readonly rows: readonly IndexRow[];
	readonly warnings: readonly string[];
}

function splitTableRow(line: string): string[] | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|")) return undefined;
	const cells: string[] = [];
	let current = "";
	let escaped = false;
	for (let index = 1; index < trimmed.length; index++) {
		const character = trimmed[index] ?? "";
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "|") {
			cells.push(current.trim());
			current = "";
			continue;
		}
		current += character;
	}
	if (current.trim().length > 0) cells.push(current.trim());
	return cells;
}

function isSeparatorRow(cells: readonly string[] | undefined): boolean {
	return cells !== undefined && cells.length === INDEX_COLUMNS.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function extractLocationTarget(location: string): string {
	const trimmed = location.trim().replace(/^`|`$/g, "");
	const link = /^\[[^\]]*]\(([^)]+)\)$/.exec(trimmed);
	return (link?.[1] ?? trimmed).trim();
}

function locationToFileName(location: string): string | undefined {
	const target = extractLocationTarget(location).replaceAll("\\", "/");
	const normalized = posix.normalize(target);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
		return undefined;
	}
	return posix.basename(normalized);
}

/** Parse the required three-column Markdown index. It never writes anything. */
export function parseMarkdownIndex(content: string): IndexParseResult {
	const lines = content.split(/\r?\n/);
	const warnings: string[] = [];
	let headerIndex = -1;
	let headerFound = false;
	for (let index = 0; index < lines.length; index++) {
		const cells = splitTableRow(lines[index] ?? "");
		if (cells?.length === INDEX_COLUMNS.length && cells.every((cell, column) => cell === INDEX_COLUMNS[column])) {
			headerIndex = index;
			headerFound = true;
			break;
		}
	}
	if (!headerFound) {
		return { headerFound: false, rows: [], warnings: [`Missing index table header: ${INDEX_COLUMNS.join(" | ")}`] };
	}
	const separator = splitTableRow(lines[headerIndex + 1] ?? "");
	if (!isSeparatorRow(separator)) {
		warnings.push("Index table is missing its separator row.");
	}
	const rows: IndexRow[] = [];
	for (let index = headerIndex + 2; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.trim().length === 0) {
			if (rows.length > 0) break;
			continue;
		}
		const cells = splitTableRow(line);
		if (cells === undefined) {
			if (rows.length > 0) break;
			continue;
		}
		if (cells.length !== INDEX_COLUMNS.length) {
			warnings.push(`Index line ${index + 1} has ${cells.length} columns; expected ${INDEX_COLUMNS.length}.`);
			continue;
		}
		const [name = "", description = "", location = ""] = cells;
		if (name.length === 0 || description.length === 0 || location.length === 0) {
			warnings.push(`Index line ${index + 1} has an empty required cell.`);
			continue;
		}
		rows.push({ name, description, location, line: index + 1 });
	}
	return { headerFound, rows, warnings };
}

export interface IndexConsistency {
	readonly consistent: boolean;
	readonly warnings: readonly string[];
	readonly missingFiles: readonly string[];
	readonly unlistedFiles: readonly string[];
	readonly duplicateEntries: readonly string[];
}

/** Compare the index rows with the actual direct Markdown files. No filesystem access. */
export function auditIndex(content: string, actualNames: readonly string[]): IndexConsistency {
	const parsed = parseMarkdownIndex(content);
	const warnings = [...parsed.warnings];
	const actual = new Set(actualNames);
	const names = new Map<string, IndexRow[]>();
	for (const row of parsed.rows) {
		const byLocation = locationToFileName(row.location);
		const nameFile = extractLocationTarget(row.name).replaceAll("\\", "/");
		const nameBase = posix.basename(posix.normalize(nameFile));
		if (byLocation === undefined || !byLocation.endsWith(".md")) {
			warnings.push(`Index line ${row.line} has an invalid 链接位置.`);
			continue;
		}
		if (nameBase !== byLocation) {
			warnings.push(`Index line ${row.line} md名 (${nameBase}) does not match 链接位置 (${byLocation}).`);
		}
		const list = names.get(byLocation) ?? [];
		list.push(row);
		names.set(byLocation, list);
	}
	const duplicates = [...names.entries()].filter(([, rows]) => rows.length > 1).map(([name]) => name);
	for (const duplicate of duplicates) {
		warnings.push(`Index contains duplicate entry: ${duplicate}`);
	}
	const missingFiles = [...names.keys()].filter((name) => !actual.has(name)).sort();
	const unlistedFiles = [...actual].filter((name) => !names.has(name)).sort();
	if (missingFiles.length > 0) warnings.push(`Index references missing files: ${missingFiles.join(", ")}`);
	if (unlistedFiles.length > 0) warnings.push(`Managed files missing from index: ${unlistedFiles.join(", ")}`);
	const consistent = warnings.length === 0 && missingFiles.length === 0 && unlistedFiles.length === 0;
	return {
		consistent,
		warnings,
		missingFiles,
		unlistedFiles,
		duplicateEntries: duplicates.sort(),
	};
}

/** One warning line appended to every tool result while the index is inconsistent. */
export function formatIndexWarning(consistency: IndexConsistency): string | undefined {
	if (consistency.consistent) return undefined;
	return `[System Meta: Index Warning: ${consistency.warnings.join("; ")}]`;
}

export interface ManagedDocumentStat {
	readonly name: string;
	readonly words: number;
	readonly mtimeMs: number;
	readonly readsLast24h: number;
}

/**
 * Render the request-time index report. This text is appended to read(index.md)
 * output and is never written back to index.md.
 */
export function renderIndexReadReport(
	stats: readonly ManagedDocumentStat[],
	now: Date,
	timeZone: string,
): string {
	const generatedAt = formatTimestamp(now, timeZone);
	const rows = [...stats].sort((left, right) => left.name.localeCompare(right.name, "en"));
	const table = [
		"Managed Markdown statistics (request-time; not written to index.md):",
		`Generated: ${generatedAt} (${timeZone})`,
		"| md名 | words | mtime | readsLast24h |",
		"| --- | ---: | --- | ---: |",
		...rows.map(
			(stat) =>
				`| ${stat.name} | ${stat.words} | ${formatTimestamp(stat.mtimeMs, timeZone)} | ${Math.max(0, Math.trunc(stat.readsLast24h))} |`,
		),
	];
	return table.join("\n");
}

/** Validate a proposed managed write without touching the existing file. */
export function validateManagedDocumentWrite(input: {
	readonly name: string;
	readonly content: string;
	readonly existingNames: readonly string[];
}): number {
	const name = assertManagedDocumentName(input.name);
	const existing = new Set(input.existingNames);
	if (!existing.has(name) && existing.size >= MAX_MANAGED_DOCUMENTS) {
		throw new RsiError(
			"DOCUMENT_COUNT_LIMIT",
			`At most ${MAX_MANAGED_DOCUMENTS} managed Markdown files are allowed.`,
			{ details: { count: existing.size, max: MAX_MANAGED_DOCUMENTS } },
		);
	}
	if (name === MEMORY_FILENAME) {
		return assertWordLimit(input.content, MEMORY_MAX_WORDS, "MEMORY_WORD_LIMIT", "Memory.md");
	}
	return assertWordLimit(input.content, MANAGED_DOCUMENT_MAX_WORDS, "DOCUMENT_WORD_LIMIT", name);
}

/** Count words for index reports and quota checks. */
export function countManagedDocumentWords(content: string): number {
	return countWords(content);
}

export type DocumentOperation = "write" | "edit" | "memory";

/** A broker transaction. The broker re-reads the revision and commits under one lock. */
export interface DocumentCommitRequest {
	readonly name: string;
	readonly content: string;
	readonly expectedRevision: string | null;
	readonly operation: DocumentOperation;
	readonly requestedByToolCallId?: string;
}

export interface DocumentMutationResult {
	readonly name: string;
	readonly revision: string;
	readonly words: number;
	readonly created: boolean;
	readonly memoryUsage?: string;
	readonly indexWarnings: readonly string[];
	readonly committedAtMs: number;
}

/** Read statistics are kept outside the Worker and never written into Markdown. */
export interface ReadStatRecord {
	readonly name: string;
	readonly readAtMs: number;
}
