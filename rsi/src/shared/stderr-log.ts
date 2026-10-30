import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const WORKER_STDERR_LOG_MAX_BYTES = 256 * 1024;

const SECRET_KEY_PATTERN = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/iu;
const GENERIC_SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]"],
	[
		/((?:api[_-]?key|token|secret|password|credential|authorization)\s*[=:]\s*)[^\s,;"']+/giu,
		"$1[REDACTED]",
	],
	[/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{12,}\b/gu, "[REDACTED]"],
];

/** Values for secret-looking environment keys are redacted verbatim, then common token shapes. */
export function stderrRedactionValues(env: Readonly<Record<string, string | undefined>>): string[] {
	const values = new Set<string>();
	for (const [key, value] of Object.entries(env)) {
		if (!SECRET_KEY_PATTERN.test(key) || value === undefined || value.length < 4) continue;
		values.add(value);
	}
	return [...values].sort((left, right) => right.length - left.length);
}

export function redactStderrText(text: string, values: readonly string[] = []): string {
	let redacted = text;
	for (const value of values) {
		if (value.length >= 4) redacted = redacted.split(value).join("[REDACTED]");
	}
	for (const [pattern, replacement] of GENERIC_SECRET_PATTERNS) {
		redacted = redacted.replace(pattern, replacement);
	}
	return redacted;
}

function boundedTail(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const bytes = Buffer.from(text, "utf8");
	return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

/**
 * Synchronous bounded stderr writer used by both sandbox launchers. The file
 * always contains the most recent tail; credentials are removed before the
 * bytes are persisted so a Watchdog notice cannot replay them.
 */
export function appendWorkerStderrLog(
	path: string,
	chunk: string,
	redactions: readonly string[] = [],
): void {
	const redacted = redactStderrText(chunk, redactions);
	if (redacted.length === 0) return;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		let previous = "";
		try {
			previous = readFileSync(path, "utf8");
		} catch {
			previous = "";
		}
		const next = boundedTail(`${previous}${redacted}`, WORKER_STDERR_LOG_MAX_BYTES);
		writeFileSync(path, next, { encoding: "utf8", mode: 0o600 });
	} catch {
		// Diagnostics are best-effort; the Worker lifecycle must not depend on them.
	}
}

export function resetWorkerStderrLog(path: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
	} catch {
		// Best-effort diagnostics.
	}
}
