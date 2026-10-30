import type {
	SandboxLaunchRequest,
	SandboxMount,
	SandboxPolicy,
} from "../shared/sandbox.ts";

export type SandboxExecutionPurpose = "worker" | "preflight" | "child";

/**
 * A Worker/preflight/child launch request.
 *
 * `workerEntry` is the executable. Extra arguments are passed without any
 * shell interpretation. Integration may set `executable` explicitly when the
 * runnable program differs from the logical worker entry (for example the
 * trusted Node executable with a Worker entry script in `args`).
 */
export interface SandboxExecutionRequest extends SandboxLaunchRequest {
	readonly executable?: string;
	/** One bounded bootstrap record written to the child's inherited stdin, then EOF. */
	readonly bootstrapInput?: string;
	readonly readOnlyMounts?: readonly SandboxMount[];
	readonly writableMounts?: readonly SandboxMount[];
	readonly timeoutMs?: number;
	readonly maxStdoutBytes?: number;
	readonly maxStderrBytes?: number;
	readonly purpose?: SandboxExecutionPurpose;
}

export interface SandboxExit {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly terminated: boolean;
	readonly startedAtMs: number;
	readonly exitedAtMs: number;
	readonly durationMs: number;
	readonly error: string | null;
}

export interface SandboxOutputSnapshot {
	readonly stdout: string;
	readonly stderr: string;
	readonly stdoutBytes: number;
	readonly stderrBytes: number;
	readonly stdoutTruncated: boolean;
	readonly stderrTruncated: boolean;
}

export interface SandboxProcessControlPort {
	readonly pid: number;
	readonly processGroupId: number;
	readonly exited: Promise<SandboxExit>;
	wait(): Promise<SandboxExit>;
	terminate(signal?: NodeJS.Signals): Promise<void>;
	killNow(signal?: NodeJS.Signals): boolean;
	signalTree(signal: NodeJS.Signals): Promise<readonly number[]>;
	descendants(): Promise<readonly number[]>;
	output(): SandboxOutputSnapshot;
}

export interface SandboxProcessHandle extends SandboxProcessControlPort {
	readonly startedAtMs: number;
}

export type SandboxMountReason =
	| "workspace"
	| "worker-home"
	| "plugin-edit"
	| "plugin-candidate"
	| "ipc"
	| "protected"
	| "protected-alias"
	| "extra-read-only"
	| "run";

export interface PlannedMount {
	readonly source: string;
	readonly target: string;
	readonly mode: "ro" | "rw";
	readonly reason: SandboxMountReason;
}

export interface HiddenMount {
	readonly target: string;
	readonly kind: "directory" | "file";
}

export interface BubblewrapFeatures {
	/**
	 * bwrap advertises `--disable-userns`. Kept for diagnostics only: it needs a
	 * writable /proc/sys/user/max_user_namespaces, which unprivileged containers
	 * do not have, so the runtime relies on the seccomp filter below.
	 */
	readonly disableUserns: boolean;
	/** bwrap supports `--seccomp FD`, required to block nested user namespaces. */
	readonly seccompFd: boolean;
	readonly unshareCgroupTry: boolean;
}

export const EMPTY_BUBBLEWRAP_FEATURES: BubblewrapFeatures = Object.freeze({
	disableUserns: false,
	seccompFd: false,
	unshareCgroupTry: false,
});

export interface SandboxPlan {
	readonly bwrapPath: string;
	readonly workerUid: number;
	readonly workerGid: number;
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly hostname: string;
	readonly writableMounts: readonly PlannedMount[];
	readonly readOnlyMounts: readonly PlannedMount[];
	readonly fileMasks: readonly string[];
	readonly hidden: readonly HiddenMount[];
	readonly protectedRoots: readonly string[];
	readonly hiddenRoots: readonly string[];
	readonly features: BubblewrapFeatures;
	/** Raw cBPF filter handed to `bwrap --seccomp FD`; null only for plan-only tests. */
	readonly nestedUsernsFilterPath: string | null;
	readonly purpose: SandboxExecutionPurpose;
}

export interface BubblewrapLauncherOptions {
	/** Required: a host UID distinct from the Supervisor UID. */
	readonly workerUid: number;
	readonly workerGid: number;
	/** Optional trusted util-linux setpriv path used to launch bwrap as the Worker UID. */
	readonly credentialHelperPath?: string;
	/** Defaults to process.geteuid()/getegid(). */
	readonly supervisorUid?: number;
	readonly supervisorGid?: number;
	readonly workerHomeDir: string;
	readonly tmpDir?: string;
	readonly timeZone?: string;
	readonly environment?: Readonly<Record<string, string>>;
	readonly additionalProtectedPaths?: readonly string[];
	readonly requiredProtectedPaths?: readonly string[];
	readonly additionalHiddenPaths?: readonly string[];
	readonly requiredHiddenPaths?: readonly string[];
	readonly readOnlyMounts?: readonly SandboxMount[];
	readonly writableMounts?: readonly SandboxMount[];
	/** Non-standard container sockets or daemon state paths to mask. */
	readonly sensitivePaths?: readonly string[];
	readonly maxStdoutBytes?: number;
	readonly maxStderrBytes?: number;
	readonly timeoutMs?: number;
	readonly terminationGraceMs?: number;
	readonly killWaitMs?: number;
	readonly probeTimeoutMs?: number;
	readonly hostname?: string;
}

export interface SandboxPreflightCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly message: string;
	readonly hint?: string;
}

export type SandboxCredentialStrategy = "setpriv" | "spawn-uid" | "none";

export interface BubblewrapPreflightReport {
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly protectedHardlinksEnabled: boolean;
	readonly workerUidDistinct: boolean;
	readonly aliasRisks: readonly string[];
	readonly platform: NodeJS.Platform;
	readonly bwrapPath: string | null;
	readonly bwrapVersion: string | null;
	readonly features: BubblewrapFeatures;
	readonly credentialStrategy: SandboxCredentialStrategy;
	readonly credentialHelperPath: string | null;
	readonly checks: readonly SandboxPreflightCheck[];
	// Compatibility fields added by the unified runtime preflight. Older report
	// producers (for example a launcher-side failure literal) may omit them;
	// falsy/undefined is always treated as "not verified".
	readonly protectedSymlinksEnabled?: boolean;
	readonly workerGidDistinct?: boolean;
	readonly probeExecuted?: boolean;
	readonly namespaceVerified?: boolean;
	readonly mountVerified?: boolean;
	readonly capEffZero?: boolean;
	readonly supplementaryGroupsCleared?: boolean;
	readonly hostIdentityVerified?: boolean;
	readonly observedHostUid?: number | null;
	readonly observedHostGid?: number | null;
	readonly observedNamespaceUid?: number | null;
	readonly observedNamespaceGid?: number | null;
	readonly probeHostPid?: number | null;
	readonly probeNamespacePid?: number | null;
	readonly nestedUsernsBlocked?: boolean;
	readonly nestedUsernsFilterPath?: string | null;
}

/** Host sysctl reader seam used by the preflight and by non-Linux tests. */
export type SandboxSysctlReader = (path: string) => Promise<string>;

/** Options for the single runtime preflight shared by CLI, deployment and launcher. */
export interface BubblewrapRuntimePreflightOptions {
	readonly workerUid: number;
	readonly workerGid: number;
	readonly supervisorUid?: number;
	readonly supervisorGid?: number;
	readonly probeTimeoutMs?: number;
	readonly credentialHelperPath?: string;
	/**
	 * Test-only host sysctl reader. Production callers never set this and no
	 * config/environment value can reach it; the default reads the real OS.
	 */
	readonly readSysctl?: SandboxSysctlReader;
}

export interface SandboxPlanContext {
	readonly bwrapPath?: string;
	readonly features?: BubblewrapFeatures;
	readonly nestedUsernsFilterPath?: string | null;
	readonly mountInfoText?: string;
}

export interface SandboxPolicyExpectations {
	readonly requiredProtectedPaths?: readonly string[];
	readonly requiredHiddenPaths?: readonly string[];
}

export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
export const DEFAULT_TIMEOUT_MS = 0;
export const DEFAULT_TERMINATION_GRACE_MS = 2_000;
export const DEFAULT_KILL_WAIT_MS = 2_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** The candidate snapshot is exposed read-only below this sandbox-only root. */
export const SANDBOX_PLUGIN_ROOT = "/run/rsi-plugins";

/** Known container control sockets. Deployments may add non-standard paths. */
export const DEFAULT_SENSITIVE_PATHS: readonly string[] = Object.freeze([
	"/var/run/docker.sock",
	"/run/docker.sock",
	"/var/run/containerd/containerd.sock",
	"/run/containerd/containerd.sock",
	"/var/run/podman/podman.sock",
	"/run/podman/podman.sock",
	"/var/run/buildkit/buildkitd.sock",
	"/run/buildkit/buildkitd.sock",
]);

export function sandboxPluginCandidatePath(generation: number): string {
	if (!Number.isSafeInteger(generation) || generation < 1) {
		throw new Error("Plugin candidate generation must be a positive safe integer.");
	}
	return `${SANDBOX_PLUGIN_ROOT}/g${generation}`;
}

/** Expose a verified candidate snapshot at the sandbox-only read-only path. */
export function pluginCandidateMount(source: string, generation: number): SandboxMount {
	return { source, target: sandboxPluginCandidatePath(generation), mode: "ro" };
}

export type { SandboxPolicy };
