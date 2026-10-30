import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { RsiError } from "./errors.ts";

export const MEMORY_FILENAME = "Memory.md";
export const INDEX_FILENAME = "index.md";
export const SANDBOX_IPC_SOCKET_PATH = "/run/rsi/worker.sock";

export interface RuntimePathInput {
	readonly workspaceDir: string;
	readonly dataDir: string;
	readonly stateDir: string;
	readonly piSourceDir: string;
	readonly rsiSourceDir: string;
	readonly systemPromptFile: string;
	readonly markdownsDir?: string;
	readonly pluginSourceDir?: string;
	readonly hostIpcSocketPath?: string;
}

/** All paths the Supervisor, Worker, broker, and Watchdog share. */
export interface RuntimePaths {
	readonly workspaceDir: string;
	readonly dataDir: string;
	readonly markdownsDir: string;
	readonly pluginSourceDir: string;
	readonly memoryFile: string;
	readonly indexFile: string;
	readonly piSourceDir: string;
	readonly rsiSourceDir: string;
	readonly systemPromptFile: string;
	readonly stateDir: string;
	readonly snapshotDir: string;
	readonly controlDir: string;
	readonly runDir: string;
	readonly readStatsDir: string;
	readonly pluginStateDir: string;
	readonly pluginStateFile: string;
	readonly readStatsFile: string;
	readonly sleepStateFile: string;
	readonly watchdogStateFile: string;
	readonly logsDir: string;
	readonly piAgentDir: string;
	readonly piSessionDir: string;
	readonly workerHomeDir: string;
	readonly ipcSocketPath: string;
	readonly sandboxIpcSocketPath: string;
}

export function requireAbsolutePath(value: string, label: string): string {
	if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
		throw new RsiError("CONFIG_INVALID", `${label} must be an absolute path.`);
	}
	return resolve(value);
}

export function assertNoNul(value: string, label: string): string {
	if (value.includes("\u0000")) {
		throw new RsiError("CONFIG_INVALID", `${label} must not contain NUL.`);
	}
	return value;
}

/** True when candidate is parent or is contained by parent. */
export function isPathWithin(parent: string, candidate: string): boolean {
	const parentResolved = resolve(parent);
	const candidateResolved = resolve(candidate);
	const rel = relative(parentResolved, candidateResolved);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Throw unless candidate is strictly below parent (or equal when allowEqual is true). */
export function assertPathWithin(
	parent: string,
	candidate: string,
	label: string,
	allowEqual = false,
): void {
	if (allowEqual && resolve(parent) === resolve(candidate)) return;
	if (!isPathWithin(parent, candidate) || resolve(parent) === resolve(candidate)) {
		throw new RsiError("PATH_OUTSIDE_ROOT", `${label} must be inside ${parent}.`);
	}
}

export function assertDisjointPath(left: string, right: string, label: string): void {
	if (isPathWithin(left, right) || isPathWithin(right, left)) {
		throw new RsiError("CONFIG_INVALID", `${label} must not overlap: ${left} and ${right}.`);
	}
}

export function toPosixPath(value: string): string {
	return value.split(sep).join("/");
}

export function deriveRuntimePaths(input: RuntimePathInput): RuntimePaths {
	const workspaceDir = requireAbsolutePath(input.workspaceDir, "workspaceDir");
	const dataDir = requireAbsolutePath(input.dataDir, "dataDir");
	const stateDir = requireAbsolutePath(input.stateDir, "stateDir");
	const piSourceDir = requireAbsolutePath(input.piSourceDir, "piSourceDir");
	const rsiSourceDir = requireAbsolutePath(input.rsiSourceDir, "rsiSourceDir");
	const systemPromptFile = requireAbsolutePath(input.systemPromptFile, "systemPromptFile");
	const markdownsDir = requireAbsolutePath(input.markdownsDir ?? join(dataDir, "markdowns"), "markdownsDir");
	const pluginSourceDir = requireAbsolutePath(
		input.pluginSourceDir ?? join(dataDir, "plugins"),
		"pluginSourceDir",
	);
	const runDir = join(stateDir, "run");
	const ipcSocketPath = requireAbsolutePath(
		input.hostIpcSocketPath ?? join(runDir, "worker.sock"),
		"hostIpcSocketPath",
	);
	return {
		workspaceDir,
		dataDir,
		markdownsDir,
		pluginSourceDir,
		memoryFile: join(markdownsDir, MEMORY_FILENAME),
		indexFile: join(markdownsDir, INDEX_FILENAME),
		piSourceDir,
		rsiSourceDir,
		systemPromptFile,
		stateDir,
		snapshotDir: join(stateDir, "snapshots"),
		controlDir: join(stateDir, "control"),
		runDir,
		readStatsDir: join(stateDir, "read-stats"),
		pluginStateDir: join(stateDir, "plugins"),
		pluginStateFile: join(stateDir, "plugins", "state.json"),
		readStatsFile: join(stateDir, "read-stats", "reads.json"),
		sleepStateFile: join(stateDir, "sleep.json"),
		watchdogStateFile: join(stateDir, "watchdog.json"),
		logsDir: join(stateDir, "logs"),
		piAgentDir: join(dataDir, "pi-agent"),
		piSessionDir: join(dataDir, "pi-sessions"),
		workerHomeDir: join(dataDir, "worker-home"),
		ipcSocketPath,
		sandboxIpcSocketPath: SANDBOX_IPC_SOCKET_PATH,
	};
}

/** Synchronous layout policy: protects paths from broad writable disk access and state exposure. */
export function assertRuntimePathPolicy(paths: RuntimePaths): void {
	const root = resolve(sep);
	if (paths.workspaceDir === root) {
		throw new RsiError("CONFIG_INVALID", "workspaceDir must not be the filesystem root.");
	}
	if (paths.stateDir === root || paths.markdownsDir === root || paths.pluginSourceDir === root) {
		throw new RsiError(
			"CONFIG_INVALID",
			"stateDir, markdownsDir and pluginSourceDir must not be the filesystem root.",
		);
	}
	const protectedRoots = [paths.piSourceDir, paths.rsiSourceDir, paths.systemPromptFile, paths.markdownsDir];
	for (const protectedPath of protectedRoots) {
		if (isPathWithin(paths.workspaceDir, protectedPath) || isPathWithin(protectedPath, paths.workspaceDir)) {
			throw new RsiError(
				"CONFIG_INVALID",
				`Protected path ${protectedPath} and workspaceDir must be disjoint.`,
			);
		}
	}
	if (isPathWithin(paths.workspaceDir, paths.stateDir) || isPathWithin(paths.stateDir, paths.workspaceDir)) {
		throw new RsiError("CONFIG_INVALID", "stateDir and workspaceDir must be disjoint.");
	}
	if (isPathWithin(paths.markdownsDir, paths.stateDir) || isPathWithin(paths.stateDir, paths.markdownsDir)) {
		throw new RsiError("CONFIG_INVALID", "stateDir and markdownsDir must be disjoint.");
	}
	if (isPathWithin(paths.workspaceDir, paths.markdownsDir) || isPathWithin(paths.markdownsDir, paths.workspaceDir)) {
		throw new RsiError("CONFIG_INVALID", "markdownsDir and workspaceDir must be disjoint.");
	}
	if (
		isPathWithin(paths.pluginSourceDir, paths.markdownsDir) ||
		isPathWithin(paths.markdownsDir, paths.pluginSourceDir) ||
		isPathWithin(paths.pluginSourceDir, paths.stateDir) ||
		isPathWithin(paths.stateDir, paths.pluginSourceDir) ||
		isPathWithin(paths.pluginSourceDir, paths.workspaceDir) ||
		isPathWithin(paths.workspaceDir, paths.pluginSourceDir)
	) {
		throw new RsiError(
			"CONFIG_INVALID",
			"pluginSourceDir must be disjoint from workspaceDir, markdownsDir and stateDir.",
		);
	}
	if (!isPathWithin(paths.stateDir, paths.ipcSocketPath)) {
		throw new RsiError("CONFIG_INVALID", "hostIpcSocketPath must be inside stateDir.");
	}
	for (const derived of [
		paths.snapshotDir,
		paths.controlDir,
		paths.runDir,
		paths.readStatsDir,
		paths.pluginStateDir,
		paths.logsDir,
	]) {
		assertPathWithin(paths.stateDir, derived, "Control-state path");
	}
	if (paths.systemPromptFile === paths.markdownsDir) {
		throw new RsiError("CONFIG_INVALID", "systemPromptFile must not be the markdowns directory.");
	}
	if (!paths.systemPromptFile.toLowerCase().endsWith(".txt")) {
		throw new RsiError("CONFIG_INVALID", "systemPromptFile must be an external .txt file.");
	}
}
