import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { RsiError } from "./errors.ts";

export const OPERATOR_PI_CONFIG_FILES = ["settings.json", "models.json", "auth.json"] as const;
type OperatorPiConfigName = (typeof OPERATOR_PI_CONFIG_FILES)[number];

const EMPTY_CONFIG: Readonly<Record<OperatorPiConfigName, string>> = {
	"settings.json": "{}\n",
	"models.json": '{\n  "providers": {}\n}\n',
	"auth.json": "{}\n",
};

export interface OperatorPiConfigFileState {
	readonly name: OperatorPiConfigName;
	readonly exists: boolean;
	readonly digest: string | null;
	readonly size: number | null;
}

export interface OperatorPiConfigBaseline {
	readonly version: 1;
	readonly capturedAtMs: number;
	readonly files: readonly OperatorPiConfigFileState[];
}

export function operatorPiConfigPaths(piAgentDir: string): readonly {
	readonly name: OperatorPiConfigName;
	readonly path: string;
}[] {
	const root = resolve(piAgentDir);
	return OPERATOR_PI_CONFIG_FILES.map((name) => ({ name, path: join(root, name) }));
}

/** Create valid empty operator files exactly once. Existing files are never rewritten. */
export function ensureOperatorPiConfigFilesSync(piAgentDir: string): readonly string[] {
	const root = resolve(piAgentDir);
	mkdirSync(root, { recursive: true, mode: 0o755 });
	const paths: string[] = [];
	for (const { name, path } of operatorPiConfigPaths(root)) {
		let info;
		try {
			info = lstatSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			writeFileSync(path, EMPTY_CONFIG[name], { flag: "wx", mode: 0o644 });
			chmodSync(path, 0o644);
			paths.push(path);
			continue;
		}
		if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
			throw new RsiError("CONFIG_INVALID", `Operator Pi config must be a single-link regular file: ${path}`);
		}
		paths.push(path);
	}
	return paths;
}

export function operatorPiConfigReadOnlyMounts(piAgentDir: string): readonly {
	readonly source: string;
	readonly target: string;
	readonly mode: "ro";
}[] {
	return ensureOperatorPiConfigFilesSync(piAgentDir).map((path) => ({ source: path, target: path, mode: "ro" as const }));
}

async function inspectOperatorConfigFile(path: string, name: OperatorPiConfigName): Promise<OperatorPiConfigFileState> {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { name, exists: false, digest: null, size: null };
		}
		throw new RsiError("CONFIG_INVALID", `Cannot inspect operator Pi config ${path}.`, { cause: error });
	}
	if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
		throw new RsiError(
			"CONFIG_INVALID",
			`Operator Pi config must be a single-link regular file: ${path}`,
		);
	}
	const bytes = await readFile(path);
	return {
		name,
		exists: true,
		digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
		size: bytes.length,
	};
}

export async function snapshotOperatorPiConfig(piAgentDir: string): Promise<readonly OperatorPiConfigFileState[]> {
	return await Promise.all(
		operatorPiConfigPaths(piAgentDir).map(({ name, path }) => inspectOperatorConfigFile(path, name)),
	);
}

async function writeBaseline(path: string, baseline: OperatorPiConfigBaseline): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
	await rename(temp, path);
}

function parseBaseline(value: unknown): OperatorPiConfigBaseline {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RsiError("CONFIG_INVALID", "Invalid operator Pi config baseline.");
	}
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || !Array.isArray(record.files) || typeof record.capturedAtMs !== "number") {
		throw new RsiError("CONFIG_INVALID", "Invalid operator Pi config baseline.");
	}
	const files: OperatorPiConfigFileState[] = [];
	for (const entry of record.files) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new RsiError("CONFIG_INVALID", "Invalid operator Pi config baseline file entry.");
		}
		const item = entry as Record<string, unknown>;
		if (
			typeof item.name !== "string" ||
			!OPERATOR_PI_CONFIG_FILES.includes(item.name as OperatorPiConfigName) ||
			typeof item.exists !== "boolean" ||
			(item.digest !== null && typeof item.digest !== "string") ||
			(item.size !== null && typeof item.size !== "number")
		) {
			throw new RsiError("CONFIG_INVALID", "Invalid operator Pi config baseline file entry.");
		}
		files.push({
			name: item.name as OperatorPiConfigName,
			exists: item.exists,
			digest: item.digest as string | null,
			size: item.size as number | null,
		});
	}
	if (files.length !== OPERATOR_PI_CONFIG_FILES.length) {
		throw new RsiError("CONFIG_INVALID", "Operator Pi config baseline is incomplete.");
	}
	return { version: 1, capturedAtMs: record.capturedAtMs, files };
}

async function readBaseline(path: string): Promise<OperatorPiConfigBaseline> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new RsiError("CONFIG_INVALID", "Operator Pi config baseline is missing; refusing a Worker restart.");
		}
		throw new RsiError("CONFIG_INVALID", "Cannot read operator Pi config baseline.", { cause: error });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new RsiError("CONFIG_INVALID", "Operator Pi config baseline is not valid JSON.", { cause: error });
	}
	return parseBaseline(parsed);
}

function sameState(left: readonly OperatorPiConfigFileState[], right: readonly OperatorPiConfigFileState[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((entry, index) => {
		
		const other = right[index];
		return (
			other !== undefined &&
			entry.name === other.name &&
			entry.exists === other.exists &&
			entry.digest === other.digest &&
			entry.size === other.size
		);
	});
}

/**
 * Capture the operator-owned Pi settings/models/auth once per state volume.
 * Missing files are part of the baseline too, so a later Agent-created file is
 * a configuration change rather than a silent new model/provider route.
 */
export async function ensureOperatorPiConfigBaseline(piAgentDir: string, baselinePath: string): Promise<void> {
	await ensureOperatorPiConfigFilesSync(piAgentDir);
	const current = await snapshotOperatorPiConfig(piAgentDir);
	let existing: OperatorPiConfigBaseline | null = null;
	try {
		existing = await readBaseline(baselinePath);
	} catch (error) {
		if (!(error instanceof RsiError) || !/baseline is missing/u.test(error.message)) throw error;
	}
	if (existing === null) {
		await writeBaseline(baselinePath, {
			version: 1,
			capturedAtMs: Date.now(),
			files: current,
		});
		return;
	}
	if (!sameState(existing.files, current)) {
		throw new RsiError(
			"CONFIG_INVALID",
			"Operator Pi settings/models/auth changed outside Supervisor control. Refusing to start or restart with a non-operator-owned model route.",
			{ details: { changedFiles: changedNames(existing.files, current) } },
		);
	}
}

export async function assertOperatorPiConfigUnchanged(piAgentDir: string, baselinePath: string): Promise<void> {
	const baseline = await readBaseline(baselinePath);
	const current = await snapshotOperatorPiConfig(piAgentDir);
	if (!sameState(baseline.files, current)) {
		throw new RsiError(
			"CONFIG_INVALID",
			"Operator Pi settings/models/auth changed while the runtime was active. Worker restart is refused.",
			{ details: { changedFiles: changedNames(baseline.files, current) } },
		);
	}
}

function changedNames(
	baseline: readonly OperatorPiConfigFileState[],
	current: readonly OperatorPiConfigFileState[],
): string[] {
	return current
		.filter((entry, index) => {
			const previous = baseline[index];
			return (
				previous === undefined ||
				previous.exists !== entry.exists ||
				previous.digest !== entry.digest ||
				previous.size !== entry.size
			);
		})
		.map((entry) => entry.name);
}
