import { RsiError } from "../shared/errors.ts";

export const SANDBOX_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Variables that can turn data or a writable directory into code execution. */
export const FORBIDDEN_ENV_KEYS: readonly string[] = Object.freeze([
	"BASH_ENV",
	"BASHOPTS",
	"CDPATH",
	"ENV",
	"GCONV_PATH",
	"IFS",
	"LD_AUDIT",
	"LD_DEBUG",
	"LD_LIBRARY_PATH",
	"LD_PRELOAD",
	"NODE_OPTIONS",
	"NODE_PATH",
	"PERL5LIB",
	"PERL5OPT",
	"PS4",
	"PYTHONHOME",
	"PYTHONPATH",
	"RUBYOPT",
	"SHELLOPTS",
]);

const INHERITED_ENV_ALLOWLIST = new Set([
	"PATH",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"LC_NUMERIC",
	"LC_TIME",
	"TERM",
	"TZ",
]);

export interface SandboxEnvironmentInput {
	readonly inherited?: Readonly<Record<string, string | undefined>>;
	readonly explicit?: Readonly<Record<string, string>>;
	readonly base?: Readonly<Record<string, string>>;
	readonly home: string;
	readonly tmpDir: string;
	readonly workerUid: number;
	readonly timeZone?: string;
}

function assertEnvKey(key: string): void {
	if (!SANDBOX_ENV_NAME_PATTERN.test(key)) {
		throw new RsiError("SANDBOX_INVALID", `Environment variable name is invalid: ${key}`);
	}
	if (FORBIDDEN_ENV_KEYS.includes(key)) {
		throw new RsiError(
			"SANDBOX_INVALID",
			`Environment variable ${key} is forbidden because it can inject code into the Worker.`,
		);
	}
}

function assertEnvValue(key: string, value: string): void {
	if (typeof value !== "string") {
		throw new RsiError("SANDBOX_INVALID", `Environment variable ${key} must be a string.`);
	}
	if (value.includes("\u0000")) {
		throw new RsiError("SANDBOX_INVALID", `Environment variable ${key} must not contain NUL.`);
	}
}

/**
 * Build a deliberately small Worker environment.
 *
 * The Supervisor's complete environment is never inherited: secrets,
 * NODE_OPTIONS, preload paths, and terminal-injection variables are dropped.
 * Explicit values (for example model credentials) are allowed but validated.
 */
export function buildSandboxEnvironment(input: SandboxEnvironmentInput): Record<string, string> {
	const result: Record<string, string> = {};
	const inherited = input.inherited ?? {};
	for (const [key, value] of Object.entries(inherited)) {
		if (value === undefined || !INHERITED_ENV_ALLOWLIST.has(key)) continue;
		// Inherited values are not attacker-controlled in normal operation, but
		// still obey the same NUL/name checks.
		if (!SANDBOX_ENV_NAME_PATTERN.test(key) || value.includes("\u0000")) continue;
		result[key] = value;
	}
	if (result.PATH === undefined || result.PATH.length === 0) {
		result.PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
	}
	result.HOME = input.home;
	result.TMPDIR = input.tmpDir;
	result.USER = String(input.workerUid);
	result.LOGNAME = String(input.workerUid);
	result.RSI_SANDBOX = "bubblewrap";
	if (input.timeZone !== undefined && result.TZ === undefined) result.TZ = input.timeZone;

	for (const [key, value] of Object.entries(input.base ?? {})) {
		assertEnvKey(key);
		assertEnvValue(key, value);
		result[key] = value;
	}
	for (const [key, value] of Object.entries(input.explicit ?? {})) {
		assertEnvKey(key);
		assertEnvValue(key, value);
		result[key] = value;
	}

	const bytes = Buffer.byteLength(
		Object.entries(result)
			.map(([key, value]) => `${key}=${value}\u0000`)
			.join(""),
		"utf8",
	);
	if (bytes > 128 * 1024) {
		throw new RsiError("SANDBOX_INVALID", "Sandbox environment exceeds the 128 KiB limit.");
	}
	return result;
}

/** Environment passed to bwrap itself (trusted helper), not to the Worker. */
export function minimalHostEnvironment(): Record<string, string> {
	return { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
}
