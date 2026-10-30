import { posix } from "node:path";
import {
	formatIndexWarning,
	INDEX_COLUMNS,
	INDEX_FILENAME,
	type IndexConsistency,
} from "../shared/documents.ts";
import { assertManagedDocumentName } from "../shared/managed-path.ts";

export interface ParsedMarkdownLink {
	readonly label: string;
	readonly target: string;
}

export interface KnowledgeIndexRow {
	readonly name: string;
	readonly description: string;
	readonly location: string;
	readonly target: string | undefined;
	readonly line: number;
	readonly valid: boolean;
	readonly warnings: readonly string[];
}

export interface KnowledgeIndexParseResult {
	readonly headerFound: boolean;
	readonly headerLine: number | undefined;
	readonly rows: readonly KnowledgeIndexRow[];
	readonly warnings: readonly string[];
}

export interface KnowledgeIndexAudit {
	readonly headerFound: boolean;
	readonly rows: readonly KnowledgeIndexRow[];
	readonly warnings: readonly string[];
	readonly missingFiles: readonly string[];
	readonly unlistedFiles: readonly string[];
	readonly duplicateEntries: readonly string[];
	readonly selfIndexed: boolean;
	readonly consistent: boolean;
}

interface FenceState {
	readonly marker: "`" | "~";
	readonly length: number;
}

function isIndentedCodeLine(line: string): boolean {
	return /^(?: {4,}|\t)/u.test(line);
}

function openingFence(line: string): FenceState | undefined {
	const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
	const run = match?.[1];
	if (!run) return undefined;
	const marker = run[0];
	if (marker !== "`" && marker !== "~") return undefined;
	return { marker, length: run.length };
}

function closesFence(line: string, fence: FenceState): boolean {
	const match = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
	const run = match?.[1];
	return run !== undefined && run[0] === fence.marker && run.length >= fence.length;
}

/** Split one Markdown table row. Escaped pipes do not delimit cells. */
export function splitMarkdownTableRow(line: string): string[] | undefined {
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
	return (
		cells !== undefined &&
		cells.length === INDEX_COLUMNS.length &&
		cells.every((cell) => /^:?-{3,}:?$/.test(cell))
	);
}

function findClosingBracket(text: string, start: number): number {
	let escaped = false;
	for (let index = start + 1; index < text.length; index++) {
		const character = text[index] ?? "";
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "]") return index;
	}
	return -1;
}

function findClosingParenthesis(text: string, start: number): number {
	let depth = 0;
	let escaped = false;
	let inAngle = false;
	for (let index = start; index < text.length; index++) {
		const character = text[index] ?? "";
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "<" && depth === 1) {
			inAngle = true;
			continue;
		}
		if (character === ">" && inAngle) {
			inAngle = false;
			continue;
		}
		if (inAngle) continue;
		if (character === "(") depth++;
		else if (character === ")") {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function unescapeMarkdownTarget(value: string): string {
	let output = "";
	let escaped = false;
	for (const character of value) {
		if (escaped) {
			output += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		output += character;
	}
	if (escaped) output += "\\";
	return output;
}

/** Parse one inline Markdown link with a real destination. */
export function parseMarkdownLink(input: string): ParsedMarkdownLink | undefined {
	const text = input.trim();
	if (!text.startsWith("[")) return undefined;
	const labelEnd = findClosingBracket(text, 0);
	if (labelEnd < 0 || text[labelEnd + 1] !== "(") return undefined;
	const close = findClosingParenthesis(text, labelEnd + 1);
	if (close < 0) return undefined;
	const label = unescapeMarkdownTarget(text.slice(1, labelEnd));
	const inside = text.slice(labelEnd + 2, close).trim();
	if (inside.length === 0) return undefined;

	let target: string;
	let rest: string;
	if (inside.startsWith("<")) {
		const angleEnd = inside.indexOf(">");
		if (angleEnd < 0) return undefined;
		target = inside.slice(1, angleEnd);
		rest = inside.slice(angleEnd + 1).trim();
		if (target.includes("<") || target.includes(">")) return undefined;
	} else {
		let depth = 0;
		let escaped = false;
		let targetEnd = inside.length;
		for (let index = 0; index < inside.length; index++) {
			const character = inside[index] ?? "";
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === "(") depth++;
			else if (character === ")") depth = Math.max(0, depth - 1);
			else if (/\s/u.test(character) && depth === 0) {
				targetEnd = index;
				break;
			}
		}
		target = inside.slice(0, targetEnd);
		rest = inside.slice(targetEnd).trim();
	}
	if (target.length === 0) return undefined;
	// Only an optional title may follow the destination.
	if (rest.length > 0 && !/^(?:"[^"]*"|'[^']*'|\([^)]*\))$/u.test(rest)) return undefined;
	return { label, target: unescapeMarkdownTarget(target) };
}

export type LocalIndexTargetResult =
	| { readonly ok: true; readonly fileName: string; readonly decodedTarget: string }
	| { readonly ok: false; readonly reason: string };

/**
 * Normalize a local index link target. URL escaping is decoded before the
 * escape checks, so `%2e%2e%2f` cannot leave the flat knowledge directory.
 */
export function normalizeLocalIndexTarget(rawTarget: string): LocalIndexTargetResult {
	let target = rawTarget.trim();
	if (target.length === 0) return { ok: false, reason: "empty link target" };
	if (target.startsWith("//") || target.startsWith("/") || target.startsWith("\\")) {
		return { ok: false, reason: "absolute link target" };
	}
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)) {
		return { ok: false, reason: "external URL in local link column" };
	}
	const hashIndex = target.indexOf("#");
	if (hashIndex >= 0) target = target.slice(0, hashIndex);
	if (target.length === 0) return { ok: false, reason: "link target is only a fragment" };
	if (target.includes("\u0000")) return { ok: false, reason: "link target contains NUL" };

	let decoded: string;
	try {
		decoded = decodeURIComponent(target);
	} catch {
		return { ok: false, reason: "link target has invalid URL escaping" };
	}
	if (decoded.includes("\u0000")) return { ok: false, reason: "link target contains NUL" };
	if (decoded.includes("\\")) return { ok: false, reason: "link target uses a backslash" };
	if (decoded.startsWith("//") || decoded.startsWith("/") || /^[A-Za-z]:/u.test(decoded)) {
		return { ok: false, reason: "link target is absolute after URL decoding" };
	}

	let direct = decoded;
	while (direct.startsWith("./")) direct = direct.slice(2);
	if (direct === "." || direct === ".." || direct.startsWith("../") || direct.startsWith("/")) {
		return { ok: false, reason: "link target escapes the knowledge directory" };
	}
	if (direct.includes("/")) {
		return { ok: false, reason: "link target is not a direct Markdown filename" };
	}
	const normalized = posix.normalize(direct);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
		return { ok: false, reason: "link target escapes the knowledge directory" };
	}
	if (!normalized.toLowerCase().endsWith(".md")) {
		return { ok: false, reason: "link target is not a Markdown file" };
	}
	try {
		assertManagedDocumentName(normalized);
	} catch {
		return { ok: false, reason: "link target is not a valid managed Markdown name" };
	}
	return { ok: true, fileName: normalized, decodedTarget: normalized };
}

function stripCodeTicks(value: string): string {
	return value.trim().replace(/^`+|`+$/gu, "").trim();
}

function parseNameCell(cell: string): { name: string | undefined; linkTarget: string | undefined } {
	const link = parseMarkdownLink(cell);
	if (link) {
		const normalized = normalizeLocalIndexTarget(link.target);
		if (normalized.ok) {
			return { name: link.label.trim() || normalized.fileName, linkTarget: normalized.fileName };
		}
		return { name: stripCodeTicks(link.label), linkTarget: undefined };
	}
	return { name: stripCodeTicks(cell), linkTarget: undefined };
}

/** Parse the required three-column index table while ignoring fenced code. */
export function parseKnowledgeIndex(content: string): KnowledgeIndexParseResult {
	const lines = content.split(/\r?\n/u);
	const warnings: string[] = [];
	let fence: FenceState | undefined;
	let headerLine: number | undefined;
	let headerCells: string[] | undefined;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (fence) {
			if (closesFence(line, fence)) fence = undefined;
			continue;
		}
		const opened = openingFence(line);
		if (opened) {
			fence = opened;
			continue;
		}
		if (isIndentedCodeLine(line)) continue;
		const cells = splitMarkdownTableRow(line);
		if (
			cells?.length === INDEX_COLUMNS.length &&
			cells.every((cell, column) => cell === INDEX_COLUMNS[column])
		) {
			headerLine = index + 1;
			headerCells = cells;
			break;
		}
	}

	if (headerLine === undefined || headerCells === undefined) {
		return {
			headerFound: false,
			headerLine: undefined,
			rows: [],
			warnings: [`Missing index table header: ${INDEX_COLUMNS.join(" | ")}`],
		};
	}

	const separatorIndex = headerLine;
	const separatorCells = splitMarkdownTableRow(lines[separatorIndex] ?? "");
	if (!isSeparatorRow(separatorCells)) {
		warnings.push("Index table is missing a valid separator row.");
	}

	const rows: KnowledgeIndexRow[] = [];
	let index = headerLine + 1;
	let fenceAfterHeader: FenceState | undefined;
	for (; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (fenceAfterHeader) {
			if (closesFence(line, fenceAfterHeader)) fenceAfterHeader = undefined;
			continue;
		}
		const opened = openingFence(line);
		if (opened) {
			fenceAfterHeader = opened;
			continue;
		}
		if (line.trim().length === 0) break;
		if (isIndentedCodeLine(line)) continue;
		const cells = splitMarkdownTableRow(line);
		if (cells === undefined) break;
		const lineNumber = index + 1;
		if (cells.length !== INDEX_COLUMNS.length) {
			warnings.push(`Index line ${lineNumber} has ${cells.length} columns; expected ${INDEX_COLUMNS.length}.`);
			continue;
		}
		const [nameCell = "", description = "", location = ""] = cells;
		const rowWarnings: string[] = [];
		if (nameCell.length === 0 || description.length === 0 || location.length === 0) {
			rowWarnings.push(`Index line ${lineNumber} has an empty required cell.`);
		}
		const parsedName = parseNameCell(nameCell);
		let name = parsedName.name;
		if (!name || name.length === 0) {
			rowWarnings.push(`Index line ${lineNumber} has an invalid md名.`);
			name = undefined;
		} else {
			try {
				name = assertManagedDocumentName(name);
			} catch {
				rowWarnings.push(`Index line ${lineNumber} has an invalid md名: ${name}`);
				name = undefined;
			}
		}
		if (parsedName.linkTarget !== undefined && name !== undefined && parsedName.linkTarget !== name) {
			rowWarnings.push(
				`Index line ${lineNumber} md名 (${name}) does not match its own link (${parsedName.linkTarget}).`,
			);
		}
		const link = parseMarkdownLink(location);
		let target: string | undefined;
		if (!link) {
			rowWarnings.push(`Index line ${lineNumber} 链接位置 is not a Markdown link.`);
		} else {
			const normalized = normalizeLocalIndexTarget(link.target);
			if (!normalized.ok) {
				rowWarnings.push(`Index line ${lineNumber} has an invalid 链接位置: ${normalized.reason}.`);
			} else {
				target = normalized.fileName;
				if (name !== undefined && target !== name) {
					rowWarnings.push(
						`Index line ${lineNumber} md名 (${name}) does not match 链接位置 (${target}).`,
					);
				}
			}
		}
		rows.push({
			name: name ?? nameCell.trim(),
			description,
			location,
			target,
			line: lineNumber,
			valid: rowWarnings.length === 0,
			warnings: rowWarnings,
		});
		warnings.push(...rowWarnings);
	}

	return { headerFound: true, headerLine, rows, warnings };
}

/** Compare the index with the actual flat set of managed Markdown names. */
export function auditKnowledgeIndex(
	content: string,
	actualNames: readonly string[],
): KnowledgeIndexAudit {
	const parsed = parseKnowledgeIndex(content);
	const warnings = [...parsed.warnings];
	const actual = new Set(actualNames);
	const entries = new Map<string, KnowledgeIndexRow[]>();
	for (const row of parsed.rows) {
		if (row.target === undefined) continue;
		const list = entries.get(row.target) ?? [];
		list.push(row);
		entries.set(row.target, list);
		if (!actual.has(row.target)) {
			warnings.push(`Index line ${row.line} references a missing managed file: ${row.target}`);
		}
	}

	const duplicates = [...entries.entries()]
		.filter(([, rows]) => rows.length > 1)
		.map(([name]) => name)
		.sort((left, right) => left.localeCompare(right, "en"));
	for (const duplicate of duplicates) {
		warnings.push(`Index contains duplicate entry: ${duplicate}`);
	}
	const missingFiles = [...entries.keys()].filter((name) => !actual.has(name)).sort();
	const unlistedFiles = [...actual].filter((name) => !entries.has(name)).sort();
	if (unlistedFiles.length > 0) {
		warnings.push(`Managed files missing from index: ${unlistedFiles.join(", ")}`);
	}

	const selfIndexed = parsed.rows.some((row) => row.target === INDEX_FILENAME);
	if (!selfIndexed) {
		warnings.push(`Index does not list itself (${INDEX_FILENAME}).`);
	}

	const consistent = warnings.length === 0 && missingFiles.length === 0 && unlistedFiles.length === 0;
	return {
		headerFound: parsed.headerFound,
		rows: parsed.rows,
		warnings,
		missingFiles,
		unlistedFiles,
		duplicateEntries: duplicates,
		selfIndexed,
		consistent,
	};
}

export function toIndexConsistency(audit: KnowledgeIndexAudit): IndexConsistency {
	return {
		consistent: audit.consistent,
		warnings: audit.warnings,
		missingFiles: audit.missingFiles,
		unlistedFiles: audit.unlistedFiles,
		duplicateEntries: audit.duplicateEntries,
	};
}

/** One canonical metadata line appended to every result while the index is inconsistent. */
export function formatKnowledgeIndexWarning(audit: KnowledgeIndexAudit): string | undefined {
	if (audit.consistent) return undefined;
	return formatIndexWarning(toIndexConsistency(audit));
}

export const INDEX_SELF_DESCRIPTION = "Managed Markdown index.";
export const MEMORY_INDEX_DESCRIPTION = "Agent-maintained Memory.";

/** Initial index content. It is written only when index.md is absent. */
export function createInitialIndexContent(input: {
	readonly includeMemory: boolean;
	readonly selfDescription?: string;
	readonly memoryDescription?: string;
}): string {
	const rows = [
		`| ${INDEX_FILENAME} | ${input.selfDescription ?? INDEX_SELF_DESCRIPTION} | [${INDEX_FILENAME}](${INDEX_FILENAME}) |`,
	];
	if (input.includeMemory) {
		rows.push(
			`| Memory.md | ${input.memoryDescription ?? MEMORY_INDEX_DESCRIPTION} | [Memory.md](Memory.md) |`,
		);
	}
	return ["# Managed Markdown Index", "", `| ${INDEX_COLUMNS.join(" | ")} |`, "| --- | --- | --- |", ...rows, ""].join(
		"\n",
	);
}
