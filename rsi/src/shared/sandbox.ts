import type { RuntimePaths } from "./paths.ts";
import { SANDBOX_IPC_SOCKET_PATH } from "./paths.ts";
import type { VerifiedRuntimeLayout } from "./layout-verify.ts";

export type SandboxMountMode = "ro" | "rw";

export interface SandboxMount {
	readonly source: string;
	readonly target: string;
	readonly mode: SandboxMountMode;
}

export interface ProtectedPath {
	readonly source: string;
	readonly target: string;
	readonly mode: "ro";
	readonly reason: "pi-source" | "rsi-source" | "manual-prompt" | "managed-markdowns";
}

export interface SandboxPolicy {
	readonly kind: "bubblewrap";
	readonly bwrapPath: string;
	readonly network: "unrestricted";
	readonly capabilities: readonly [];
	readonly noNewPrivileges: true;
	readonly unsharePid: true;
	readonly unshareIpc: true;
	readonly unshareUts: true;
	readonly procfs: "isolated";
	readonly rootFilesystem: "container-root";
	readonly protected: readonly ProtectedPath[];
	readonly canonicalProtected: readonly string[];
	readonly hidden: readonly string[];
	readonly writable: readonly SandboxMount[];
	readonly ipc: {
		readonly transport: "unix";
		readonly hostSocketPath: string;
		readonly workerSocketPath: typeof SANDBOX_IPC_SOCKET_PATH;
		readonly stdoutIsProtocol: false;
	};
	readonly hardlinkPolicy: "broker-owned-nlink-1-and-protected-hardlinks";
}

export interface SandboxLaunchRequest {
	readonly policy: SandboxPolicy;
	readonly workerEntry: string;
	readonly args?: readonly string[];
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	/** Optional Supervisor-owned bounded/redacted log for the child's stderr stream. */
	readonly stderrLogPath?: string;
	readonly stderrRedactions?: readonly string[];
}

export interface SandboxHandle {
	readonly pid: number;
	readonly startedAtMs: number;
	wait(): Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
	terminate(signal?: NodeJS.Signals): Promise<void>;
}

/** The Supervisor launches bwrap; plugins are never loaded in the Supervisor. */
export interface SandboxLauncher {
	launch(request: SandboxLaunchRequest, signal?: AbortSignal): Promise<SandboxHandle>;
}

/** Build the security-relevant part of the Worker policy. Actual bwrap argv is module-owned. */
export function createSandboxPolicy(
	paths: RuntimePaths,
	bwrapPath: string,
	verified: Pick<VerifiedRuntimeLayout, "protectedPaths" | "canonicalStateDir">,
): SandboxPolicy {
	const protectedEntries: ProtectedPath[] = [];
	const addProtected = (source: string, target: string, reason: ProtectedPath["reason"]): void => {
		if (!protectedEntries.some((entry) => entry.source === source && entry.target === target && entry.reason === reason)) {
			protectedEntries.push({ source, target, mode: "ro", reason });
		}
	};
	addProtected(paths.piSourceDir, paths.piSourceDir, "pi-source");
	addProtected(paths.rsiSourceDir, paths.rsiSourceDir, "rsi-source");
	addProtected(paths.systemPromptFile, paths.systemPromptFile, "manual-prompt");
	addProtected(paths.markdownsDir, paths.markdownsDir, "managed-markdowns");
	for (const entry of verified.protectedPaths) {
		addProtected(entry.configured, entry.configured, entry.kind);
		addProtected(entry.canonical, entry.canonical, entry.kind);
	}
	const canonicalProtected = [...new Set(protectedEntries.map((entry) => entry.source))];
	const hidden = [
		...new Set([
			paths.stateDir,
			paths.snapshotDir,
			paths.controlDir,
			paths.logsDir,
			...(verified.canonicalStateDir === paths.stateDir ? [] : [verified.canonicalStateDir]),
		]),
	];
	return {
		kind: "bubblewrap",
		bwrapPath,
		network: "unrestricted",
		capabilities: [],
		noNewPrivileges: true,
		unsharePid: true,
		unshareIpc: true,
		unshareUts: true,
		procfs: "isolated",
		rootFilesystem: "container-root",
		protected: protectedEntries,
		canonicalProtected,
		hidden,
		writable: [
			{ source: paths.workspaceDir, target: paths.workspaceDir, mode: "rw" },
			{ source: paths.pluginSourceDir, target: paths.pluginSourceDir, mode: "rw" },
			{ source: paths.piAgentDir, target: paths.piAgentDir, mode: "rw" },
			{ source: paths.piSessionDir, target: paths.piSessionDir, mode: "rw" },
			{ source: paths.workerHomeDir, target: paths.workerHomeDir, mode: "rw" },
			{ source: paths.runDir, target: "/run/rsi", mode: "ro" },
		],
		ipc: {
			transport: "unix",
			hostSocketPath: paths.ipcSocketPath,
			workerSocketPath: SANDBOX_IPC_SOCKET_PATH,
			stdoutIsProtocol: false,
		},
		hardlinkPolicy: "broker-owned-nlink-1-and-protected-hardlinks",
	};
}

export interface SandboxPreflightReport {
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly protectedHardlinksEnabled: boolean;
	readonly workerUidDistinct: boolean;
	readonly aliasRisks: readonly string[];
}
