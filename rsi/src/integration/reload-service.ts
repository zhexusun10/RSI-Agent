import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { RsiError, asRsiError } from "../shared/errors.ts";
import { assertMcpConfigurationAllowed } from "../pi/mcp-cap.ts";
import type { RuntimeEventPublisher } from "../shared/events.ts";
import type { PreflightReport } from "../shared/preflight.ts";
import type { PluginCandidate } from "../shared/plugins.ts";
import { REQUIRED_PLUGIN_PINS } from "../shared/plugins.ts";
import type { RuntimePaths } from "../shared/paths.ts";
import type { SandboxHandle, SandboxLauncher, SandboxMount, SandboxPolicy } from "../shared/sandbox.ts";
import type { Clock } from "../shared/time.ts";
import type { ImmutableCandidateStore } from "../reload/candidate-store.ts";
import { NodeProcessTreeKiller } from "../reload/process-tree.ts";
import { ensurePreflightWorkingDirectory, formatPreflightToolError } from "../reload/preflight-runner.ts";
import type { ReloadCoordinator } from "../reload/reload-coordinator.ts";
import type { ReloadRequestResult, ReloadCandidate } from "../reload/types.ts";
import type { SandboxExecutionRequest } from "../sandbox/types.ts";
import {
	PREFLIGHT_MANIFEST_ENV,
	PREFLIGHT_RESULT_ENV,
} from "../reload/workers/child-protocol.ts";
import { CHILD_STDERR_PATH_ENV } from "../reload/process-tree.ts";

export const SANDBOX_PLUGIN_ROOT = "/run/rsi-plugins";
export const SANDBOX_PREFLIGHT_ROOT = "/run/rsi-preflight";

export interface ReloadServiceOptions {
	readonly paths: RuntimePaths;
	readonly clock: Clock;
	readonly coordinator: ReloadCoordinator;
	readonly candidateStore: ImmutableCandidateStore;
	readonly events?: RuntimeEventPublisher;
	readonly sandboxPathMapping: boolean;
	readonly candidateHooks?: {
		readonly beforeSourceRecheck?: () => Promise<void>;
		readonly afterBackup?: () => Promise<void> | void;
		readonly afterInstall?: () => Promise<void> | void;
	};
	readonly onDiagnostic?: (message: string) => void;
}

export interface WorkerReloadView {
	readonly candidate: PluginCandidate;
	readonly report: PreflightReport;
}

function mapSnapshotPath(path: string, snapshotDir: string, sandbox: boolean): string {
	if (!sandbox) return path;
	const rel = relative(resolve(snapshotDir), resolve(path));
	if (rel === "" || rel.startsWith("..") || resolve(snapshotDir) === resolve(path)) {
		throw new RsiError("PATH_OUTSIDE_ROOT", `Candidate path is outside the snapshot store: ${path}`);
	}
	return posix.join(SANDBOX_PLUGIN_ROOT, ...rel.split(sep));
}

/**
 * Supervisor-side candidate preparation and sandbox path projection.
 *
 * Reloads use an empty candidate: the Worker loads only the two pinned Pi
 * packages and native MCP support. Agent-writable Pi extensions are never
 * imported, even during preflight or recovery.
 */
export class ReloadService {
	readonly options: ReloadServiceOptions;
	private readonly reports = new Map<string, PreflightReport>();
	private readonly views = new Map<string, PluginCandidate>();
	private queuedWorkerReload: { readonly reason: string; readonly candidateId?: string } | null = null;
	private reloading = false;

	constructor(options: ReloadServiceOptions) {
		this.options = options;
	}

	private trustedDependencyRoots(): string[] {
		return [join(this.options.paths.rsiSourceDir, "node_modules")];
	}

	async prepareCandidate(_options: { readonly allowEmpty?: boolean } = {}): Promise<ReloadCandidate> {
		return await this.options.coordinator.prepareCandidate({
			sourceRoots: [],
			trustedDependencyRoots: this.trustedDependencyRoots(),
			packages: REQUIRED_PLUGIN_PINS,
			now: this.options.clock.now(),
			allowEmpty: true,
		});
	}

	private assertPinnedOnly(candidate: ReloadCandidate): void {
		if (candidate.manifest.sources.length !== 0 || candidate.manifest.entries.length !== 0 || candidate.manifest.fileCount !== 0) {
			throw new RsiError(
				"AGENT_COMMAND_FORBIDDEN",
				"Loading additional Pi extensions is disabled. A legacy extension snapshot cannot be loaded or restored; an operator must migrate the reload state.",
			);
		}
	}

	async validate(candidate: ReloadCandidate): Promise<PreflightReport> {
		this.assertPinnedOnly(candidate);
		const cached = this.reports.get(candidate.candidateId);
		if (cached !== undefined) return cached;
		const outcome = await this.options.coordinator.validateCandidate(candidate);
		this.reports.set(candidate.candidateId, outcome.report);
		this.views.set(candidate.candidateId, await this.workerView(candidate));
		return outcome.report;
	}

	async resolveValidated(candidateId: string): Promise<ReloadCandidate> {
		const candidate = await this.options.coordinator.resolveCandidate(candidateId);
		if (candidate === null) {
			throw new RsiError("PREFLIGHT_FAILED", `Unknown candidate: ${candidateId}`);
		}
		this.assertPinnedOnly(candidate);
		return candidate;
	}

	/**
	 * Called by the Worker before its real session.reload. In the direct Worker
	 * entry path a fresh snapshot is made; when the Supervisor initiated the
	 * reload, the exact already-validated candidate is reused.
	 */
	async preflightForWorker(candidateId: string | undefined): Promise<PreflightReport> {
		if (candidateId !== undefined) {
			const cached = this.reports.get(candidateId);
			if (cached !== undefined) {
				const view = this.views.get(candidateId);
				return view === undefined ? cached : { ...cached, entryPaths: view.entryPaths ?? [] };
			}
			const candidate = await this.resolveValidated(candidateId);
			const report = await this.validate(candidate);
			const view = this.views.get(candidateId);
			return view === undefined ? report : { ...report, entryPaths: view.entryPaths ?? [] };
		}
		const candidate = await this.prepareCandidate();
		const report = await this.validate(candidate);
		const view = this.views.get(candidate.candidateId);
		return view === undefined ? report : { ...report, entryPaths: view.entryPaths ?? [] };
	}

	/** Persist the Worker-initiated reload after external preflight. */
	async beginWorkerReload(candidateId: string, reason: string): Promise<{ attemptId: string; requiredHealthTurns: 3 }> {
		const started = await this.options.coordinator.beginWorkerReload({ candidateId, reason });
		this.options.events?.emit("reload.started", {
			attemptId: started.attemptId,
			generation: (await this.resolveValidated(candidateId)).generation,
			candidateDigest: (await this.resolveValidated(candidateId)).digest,
			atMs: this.options.clock.now().getTime(),
		});
		return started;
	}

	async completeWorkerReload(attemptId: string, generation: number, digest: `sha256:${string}`): Promise<void> {
		await this.options.coordinator.completeWorkerReload({ attemptId, generation, digest });
	}

	async failWorkerReload(attemptId: string, reason: string): Promise<void> {
		await this.options.coordinator.failWorkerReload(attemptId, reason);
	}

	/** Build the exact read-only entry set the Worker must load. */
	async workerView(candidate: ReloadCandidate): Promise<PluginCandidate> {
		this.assertPinnedOnly(candidate);
		const sandbox = this.options.sandboxPathMapping;
		const mappedRoot = mapSnapshotPath(candidate.path, this.options.paths.snapshotDir, sandbox);
		const entryPaths = candidate.manifest.entries.map((entry) =>
			sandbox ? posix.join(mappedRoot, ...entry.split("/")) : join(mappedRoot, ...entry.split("/")),
		);
		return {
			candidateId: candidate.candidateId,
			generation: candidate.generation,
			path: mappedRoot,
			digest: candidate.digest,
			packages: candidate.packages,
			createdAtMs: candidate.createdAtMs,
			readOnly: true,
			entryPaths,
		};
	}

	async prepareSupervisorReload(input: {
		readonly reason: string;
		readonly candidateId?: string;
	}): Promise<{ readonly candidate: ReloadCandidate; readonly report: PreflightReport }> {
		// Count project entries conservatively as well as global entries. The Worker
		// repeats Pi's native cap before any MCP server is connected.
		await assertMcpConfigurationAllowed({
			agentDir: this.options.paths.piAgentDir,
			cwd: this.options.paths.workspaceDir,
			projectTrusted: true,
		});
		let candidate: ReloadCandidate;
		if (input.candidateId !== undefined) {
			candidate = await this.resolveValidated(input.candidateId);
		} else {
			candidate = await this.prepareCandidate();
		}
		const report = await this.validate(candidate);
		if (!report.ok) {
			const errors = [...report.staticSyntaxCheck.errors, ...report.mockLoad.errors];
			throw new RsiError("PREFLIGHT_FAILED", formatPreflightToolError(report), {
				details: { candidateId: candidate.candidateId, digest: candidate.digest, errors },
			});
		}
		return { candidate, report };
	}

	/** Supervisor/operator driven reload; waits for the real Worker load result. */
	async requestSupervisorReload(input: {
		readonly reason: string;
		readonly candidateId?: string;
		readonly source: "control" | "operation" | "worker";
	}): Promise<ReloadRequestResult> {
		const prepared = await this.prepareSupervisorReload(input);
		this.options.onDiagnostic?.(`coordinator reload request candidate=${prepared.candidate.candidateId}`);
		const result = await this.options.coordinator.requestReload({
			reason: input.reason,
			source: input.source === "operation" ? "control" : input.source === "worker" ? "worker" : "control",
			candidateId: prepared.candidate.candidateId,
		});
		if (result.ok) {
			this.reports.delete(prepared.candidate.candidateId);
			this.views.delete(prepared.candidate.candidateId);
		}
		return result;
	}

	/** Agent/CLI reload request: prepare now, run after the active turn settles. */
	async requestDeferredReload(input: { readonly reason: string; readonly candidateId?: string }): Promise<string> {
		const prepared = await this.prepareSupervisorReload(input);
		if (this.reloading) {
			throw new RsiError("RELOAD_FAILED", "A reload is already in progress.");
		}
		this.queuedWorkerReload = {
			reason: input.reason,
			candidateId: prepared.candidate.candidateId,
		};
		return `Reload candidate ${prepared.candidate.candidateId} passed preflight; it will be loaded after the active turn settles.`;
	}

	/** Invoke after agent_settled or immediately when the Worker is already idle. */
	async flushDeferredReload(workerIdle: boolean): Promise<void> {
		if (!workerIdle || this.queuedWorkerReload === null || this.reloading) return;
		const request = this.queuedWorkerReload;
		this.queuedWorkerReload = null;
		this.reloading = true;
		try {
			this.options.onDiagnostic?.(`deferred reload dispatch candidate=${request.candidateId ?? "new"}`);
			const result = await this.requestSupervisorReload({
				reason: request.reason,
				source: "worker",
				...(request.candidateId === undefined ? {} : { candidateId: request.candidateId }),
			});
			if (!result.ok) {
				this.options.onDiagnostic?.(`Deferred reload failed: ${result.error}`);
			}
		} catch (error) {
			const failure = asRsiError(error, "RELOAD_FAILED");
			this.options.onDiagnostic?.(`Deferred reload failed: ${failure.message}`);
		} finally {
			this.reloading = false;
		}
	}

	get hasDeferredReload(): boolean {
		return this.queuedWorkerReload !== null;
	}

	async initialBaseline(): Promise<{ candidate: ReloadCandidate; lkgCreated: boolean } | null> {
		const existingLkg = await this.options.coordinator.getLkg();
		if (existingLkg !== null) return null;
		const state = await this.options.coordinator.currentState();
		if (state.active !== null) {
			throw new RsiError(
				"RELOAD_FAILED",
				"An active plugin generation exists without an LKG; refusing to start from untrusted state.",
			);
		}
		const candidate = await this.prepareCandidate({ allowEmpty: true });
		await this.validate(candidate);
		const baseline = await this.options.coordinator.initializeBaseline(candidate);
		if (!baseline.ok) {
			throw new RsiError("RELOAD_FAILED", `Initial plugin baseline failed: ${baseline.error ?? "unknown error"}`);
		}
		return { candidate, lkgCreated: true };
	}

	async lkgCandidate(snapshotPath: string): Promise<ReloadCandidate> {
		const verified = await this.options.candidateStore.verifyCandidate(snapshotPath);
		this.assertPinnedOnly(verified.candidate);
		return verified.candidate;
	}
}


export interface MappedPreflightLauncherOptions {
	readonly launcher: SandboxLauncher;
	readonly policy: SandboxPolicy;
	readonly snapshotDir: string;
	readonly sandboxPathMapping: boolean;
}

/**
 * Translate host candidate/temp paths to the sandbox view for preflight
 * children. Static/Mock preflight uses the same bwrap boundary as the Worker;
 * the Supervisor never imports candidate code.
 */
export class MappedPreflightLauncher {
	private readonly options: MappedPreflightLauncherOptions;
	private readonly killer = new NodeProcessTreeKiller();

	constructor(options: MappedPreflightLauncherOptions) {
		this.options = options;
	}

	async launch(input: {
		readonly workerEntry: string;
		readonly cwd: string;
		readonly env: Readonly<Record<string, string>>;
		readonly signal?: AbortSignal;
	}): Promise<SandboxHandle> {
		let env: Record<string, string> = { ...input.env };
		const mounts: SandboxMount[] = [];
		let fallbackCwd: string | undefined;
		if (this.options.sandboxPathMapping) {
			const manifestPath = env[PREFLIGHT_MANIFEST_ENV];
			const resultPath = env[PREFLIGHT_RESULT_ENV];
			const stderrPath = env[CHILD_STDERR_PATH_ENV];
			if (manifestPath === undefined || resultPath === undefined || stderrPath === undefined) {
				throw new RsiError("PREFLIGHT_FAILED", "Preflight child paths are missing.");
			}
			const candidateRoot = dirname(manifestPath);
			const mappedCandidateRoot = mapSnapshotPath(
				candidateRoot,
				this.options.snapshotDir,
				true,
			);
			const tempHost = dirname(resultPath);
			const mappedTemp = posix.join(SANDBOX_PREFLIGHT_ROOT, basename(tempHost));
			const mapTempPath = (hostPath: string): string => {
				const rel = relative(resolve(tempHost), resolve(hostPath));
				if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
					throw new RsiError(
						"PREFLIGHT_FAILED",
						`Preflight diagnostic path is outside its staging directory: ${hostPath}`,
					);
				}
				return posix.join(mappedTemp, ...rel.split(sep));
			};
			const manifestRel = relative(resolve(candidateRoot), resolve(manifestPath));
			if (manifestRel === "" || manifestRel === ".." || manifestRel.startsWith(`..${sep}`) || isAbsolute(manifestRel)) {
				throw new RsiError("PREFLIGHT_FAILED", "Preflight manifest is outside the candidate snapshot.");
			}
			env = {
				...env,
				[PREFLIGHT_MANIFEST_ENV]: posix.join(mappedCandidateRoot, ...manifestRel.split(sep)),
				[PREFLIGHT_RESULT_ENV]: mapTempPath(resultPath),
				[CHILD_STDERR_PATH_ENV]: mapTempPath(stderrPath),
			};
			fallbackCwd = tempHost;
			mounts.push(
				{
					source: this.options.snapshotDir,
					target: SANDBOX_PLUGIN_ROOT,
					mode: "ro",
				},
				{ source: tempHost, target: mappedTemp, mode: "rw" },
			);
		}
		const workerEntry = resolve(input.workerEntry);
		const protectedRoots = [
			...this.options.policy.canonicalProtected,
			...this.options.policy.protected.map((entry) => entry.source),
			...this.options.policy.hidden,
			this.options.snapshotDir,
		];
		const cwd = await ensurePreflightWorkingDirectory({
			cwd: input.cwd,
			workerEntry,
			protectedRoots,
			...(fallbackCwd === undefined ? {} : { fallbackCwd }),
		});
		const request: SandboxExecutionRequest = {
			policy: this.options.policy,
			workerEntry,
			// bwrap execs argv directly. The .ts preflight entries have no shebang,
			// so the trusted Node executable must be the executable and the entry
			// must be passed as its first argument.
			executable: process.execPath,
			args: [workerEntry],
			cwd,
			env,
			...(mounts.length === 0
				? {}
				: {
						readOnlyMounts: mounts.filter((mount) => mount.mode === "ro"),
						writableMounts: mounts.filter((mount) => mount.mode === "rw"),
					}),
		};
		return await this.options.launcher.launch(request, input.signal);
	}

	async killTree(pid: number): Promise<void> {
		await this.killer.killTree(pid, "SIGKILL");
	}
}
