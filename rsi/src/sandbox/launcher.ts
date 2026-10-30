import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { RsiError } from "../shared/errors.ts";
import type { SandboxLauncher } from "../shared/sandbox.ts";
import { createSandboxPolicy } from "../shared/sandbox.ts";
import { operatorPiConfigReadOnlyMounts } from "../shared/operator-config.ts";
import type { RsiConfig } from "../shared/config.ts";
import type { VerifiedRuntimeLayout } from "../shared/layout-verify.ts";
import { buildBubblewrapArgv } from "./argv.ts";
import { minimalHostEnvironment } from "./environment.ts";
import { createSandboxPlan, defaultExecutionLimits } from "./plan.ts";
import { assertPreflightOk, inspectBubblewrapRuntime } from "./preflight.ts";
import { BubblewrapSandboxProcess } from "./process.ts";
import type {
	BubblewrapLauncherOptions,
	BubblewrapPreflightReport,
	SandboxExecutionRequest,
	SandboxPlan,
	SandboxProcessHandle,
} from "./types.ts";

export interface PreparedSandbox {
	readonly report: BubblewrapPreflightReport;
	readonly plan: SandboxPlan | null;
}

function validateByteLimit(value: number | undefined, label: string): number {
	if (value === undefined) throw new RsiError("INTERNAL", `${label} is undefined.`);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RsiError("SANDBOX_INVALID", `${label} must be a non-negative integer.`);
	}
	return value;
}

function validateTimeout(value: number | undefined): number {
	if (value === undefined || value === 0) return 0;
	if (!Number.isFinite(value) || value < 0) {
		throw new RsiError("SANDBOX_INVALID", "Sandbox timeoutMs must be a non-negative finite number.");
	}
	return Math.floor(value);
}

function abortError(): RsiError {
	return new RsiError("SANDBOX_INVALID", "Sandbox launch was aborted before the Worker started.");
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/**
 * bwrap runs as the unprivileged Worker, so it cannot create mount targets
 * below root-owned directories such as /run. The trusted Supervisor creates
 * only the validated target directories/files before spawning.
 */
async function ensureMountTargets(plan: SandboxPlan): Promise<void> {
	for (const mount of [...plan.writableMounts, ...plan.readOnlyMounts]) {
		try {
			await lstat(mount.target);
			continue;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const source = await lstat(mount.source);
		if (source.isDirectory()) {
			await mkdir(mount.target, { recursive: true, mode: 0o755 });
		} else {
			await mkdir(posix.dirname(mount.target), { recursive: true, mode: 0o755 });
			await writeFile(mount.target, "", { flag: "wx", mode: 0o644 });
		}
	}
}

async function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const onSpawn = (): void => {
			child.off("error", onError);
			resolve();
		};
		const onError = (error: Error): void => {
			child.off("spawn", onSpawn);
			reject(new RsiError("SANDBOX_INVALID", `Could not start bubblewrap: ${error.message}`, { cause: error }));
		};
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}

/**
 * Bubblewrap launcher for the real Pi Worker, preflight children, or any child
 * process. The Supervisor constructs the entire argv here and never imports
 * Worker/plugin code.
 */
export class BubblewrapSandboxLauncher implements SandboxLauncher {
	readonly options: BubblewrapLauncherOptions;
	private readonly runtimePreflights = new Map<string, Promise<BubblewrapPreflightReport>>();

	constructor(options: BubblewrapLauncherOptions) {
		this.options = options;
		const limits = defaultExecutionLimits(options);
		validateByteLimit(limits.maxStdoutBytes, "maxStdoutBytes");
		validateByteLimit(limits.maxStderrBytes, "maxStderrBytes");
		validateTimeout(limits.timeoutMs);
		if (limits.terminationGraceMs < 0 || limits.killWaitMs < 0) {
			throw new RsiError("SANDBOX_INVALID", "Termination timeouts must not be negative.");
		}
	}

	private runtimePreflight(bwrapCommand: string): Promise<BubblewrapPreflightReport> {
		const cached = this.runtimePreflights.get(bwrapCommand);
		if (cached !== undefined) return cached;
		const pending = inspectBubblewrapRuntime(this.options, bwrapCommand);
		this.runtimePreflights.set(bwrapCommand, pending);
		return pending;
	}

	/** Full fail-closed preflight including canonical paths, aliases, and hidden state. */
	async preflight(request: SandboxExecutionRequest): Promise<BubblewrapPreflightReport> {
		const prepared = await this.prepare(request).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			return {
				report: {
					ok: false,
					errors: [message],
					protectedHardlinksEnabled: false,
					workerUidDistinct: false,
					aliasRisks: [message],
					platform: process.platform,
					bwrapPath: null,
					bwrapVersion: null,
					features: { disableUserns: false, seccompFd: false, unshareCgroupTry: false },
					credentialStrategy: "none",
					credentialHelperPath: null,
					checks: [{ name: "plan", ok: false, message }],
				} satisfies BubblewrapPreflightReport,
				plan: null,
			};
		});
		return prepared.report;
	}

	private async prepare(request: SandboxExecutionRequest): Promise<PreparedSandbox> {
		const report = await this.runtimePreflight(request.policy.bwrapPath);
		if (!report.ok || report.bwrapPath === null) {
			return { report, plan: null };
		}
		try {
			const plan = await createSandboxPlan(request, this.options, {
				bwrapPath: report.bwrapPath,
				features: report.features,
				nestedUsernsFilterPath: report.nestedUsernsFilterPath ?? null,
			});
			return { report, plan };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				report: {
					...report,
					ok: false,
					errors: [...report.errors, message],
					aliasRisks: [...report.aliasRisks, message],
				},
				plan: null,
			};
		}
	}

	async launch(
		request: SandboxExecutionRequest,
		signal?: AbortSignal,
	): Promise<SandboxProcessHandle> {
		if (isAborted(signal)) throw abortError();
		const prepared = await this.prepare(request);
		assertPreflightOk(prepared.report);
		if (isAborted(signal)) throw abortError();
		const plan = prepared.plan;
		if (plan === null) {
			throw new RsiError("SANDBOX_INVALID", "Sandbox plan was not produced; refusing to launch without a sandbox.");
		}
		await ensureMountTargets(plan);
		const limits = defaultExecutionLimits(this.options);
		const timeoutMs = validateTimeout(request.timeoutMs ?? limits.timeoutMs);
		const maxStdoutBytes = validateByteLimit(
			request.maxStdoutBytes ?? limits.maxStdoutBytes,
			"maxStdoutBytes",
		);
		const maxStderrBytes = validateByteLimit(
			request.maxStderrBytes ?? limits.maxStderrBytes,
			"maxStderrBytes",
		);
		if (plan.nestedUsernsFilterPath === null) {
			throw new RsiError(
				"SANDBOX_INVALID",
				"The nested-userns seccomp filter is missing; refusing to launch without user-namespace containment.",
			);
		}
		const argv = buildBubblewrapArgv(plan);
		const report = prepared.report;
		const command =
			report.credentialStrategy === "setpriv" && report.credentialHelperPath !== null
				? [
						report.credentialHelperPath,
						"--reuid",
						String(plan.workerUid),
						"--regid",
						String(plan.workerGid),
						"--clear-groups",
						"--",
						plan.bwrapPath,
						...argv,
					]
				: [plan.bwrapPath, ...argv];
		const seccompFd = openSync(plan.nestedUsernsFilterPath, "r");
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command[0] ?? plan.bwrapPath, command.slice(1), {
				cwd: "/",
				detached: true,
				stdio:
					request.bootstrapInput === undefined
						? ["ignore", "pipe", "pipe", seccompFd]
						: ["pipe", "pipe", "pipe", seccompFd],
				env: minimalHostEnvironment(),
				windowsHide: true,
				...(report.credentialStrategy === "spawn-uid"
					? { uid: plan.workerUid, gid: plan.workerGid }
					: {}),
			});
		} catch (error) {
			closeSync(seccompFd);
			throw error;
		}
		closeSync(seccompFd);
		await waitForSpawn(child);
		if (request.bootstrapInput !== undefined) {
			if (child.stdin === null) {
				child.kill("SIGKILL");
				throw new RsiError("SANDBOX_INVALID", "Worker bootstrap stdin pipe was not created.");
			}
			// The credential travels only over the inherited pipe. It is never in
			// argv or the Worker environment and is closed immediately after the
			// single bounded record.
			child.stdin.on("error", () => undefined);
			child.stdin.end(request.bootstrapInput);
		}
		const handle = new BubblewrapSandboxProcess(child, {
			...(request.stderrLogPath === undefined ? {} : { stderrLogPath: request.stderrLogPath }),
			...(request.stderrRedactions === undefined ? {} : { stderrRedactions: request.stderrRedactions }),
			maxStdoutBytes,
			maxStderrBytes,
			terminationGraceMs: limits.terminationGraceMs,
			killWaitMs: limits.killWaitMs,
		});

		let timer: NodeJS.Timeout | undefined;
		let abortListener: (() => void) | undefined;
		const clear = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			if (abortListener !== undefined) signal?.removeEventListener("abort", abortListener);
		};
		void handle.exited.then(clear, clear);

		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				handle.markTimedOut();
				void handle.terminate("SIGTERM");
			}, timeoutMs);
			timer.unref();
		}
		if (signal !== undefined) {
			abortListener = (): void => {
				handle.markAborted();
				void handle.terminate("SIGTERM");
			};
			if (signal.aborted) abortListener();
			else signal.addEventListener("abort", abortListener, { once: true });
		}
		return handle;
	}
}

export function createBubblewrapLauncher(options: BubblewrapLauncherOptions): BubblewrapSandboxLauncher {
	return new BubblewrapSandboxLauncher(options);
}

export interface ConfiguredBubblewrapSandbox {
	readonly launcher: BubblewrapSandboxLauncher;
	readonly policy: ReturnType<typeof createSandboxPolicy>;
}

/**
 * Integration helper. It fails closed when the config does not name a distinct
 * Worker UID/GID; it never falls back to an unsandboxed launch.
 */
export function createBubblewrapLauncherForConfig(
	config: RsiConfig,
	verified: VerifiedRuntimeLayout,
	overrides: Partial<Omit<BubblewrapLauncherOptions, "workerUid" | "workerGid" | "workerHomeDir">> & {
		readonly workerUid?: number;
		readonly workerGid?: number;
	} = {},
): ConfiguredBubblewrapSandbox {
	const workerUid = overrides.workerUid ?? config.sandbox.workerUid;
	const workerGid = overrides.workerGid ?? config.sandbox.workerGid;
	if (workerUid === undefined || workerGid === undefined) {
		throw new RsiError(
			"SANDBOX_INVALID",
			"Configuration must set sandbox.workerUid and sandbox.workerGid to a dedicated, non-root identity.",
		);
	}
	const policy = createSandboxPolicy(config.paths, config.sandbox.bwrapPath, verified);
	// The operator's Pi config files are read-only overlays on the otherwise
	// writable agent directory. Creating missing files first also prevents an
	// Agent from creating a new settings/models/auth route during this run.
	const operatorConfigMounts = operatorPiConfigReadOnlyMounts(config.paths.piAgentDir);
	const readOnlyMounts = [...(overrides.readOnlyMounts ?? []), ...operatorConfigMounts];
	const launcher = new BubblewrapSandboxLauncher({
		...overrides,
		readOnlyMounts,
		workerUid,
		workerGid,
		workerHomeDir: config.paths.workerHomeDir,
		timeZone: config.timeZone,
		requiredProtectedPaths: [
			config.paths.piSourceDir,
			config.paths.rsiSourceDir,
			config.paths.systemPromptFile,
			config.paths.markdownsDir,
			...verified.protectedPaths.map((entry) => entry.canonical),
		],
		requiredHiddenPaths: [
			config.paths.stateDir,
			config.paths.snapshotDir,
			config.paths.controlDir,
			config.paths.pluginStateDir,
			config.paths.readStatsDir,
			config.paths.logsDir,
			config.paths.sleepStateFile,
			config.paths.watchdogStateFile,
		],
	});
	return { launcher, policy };
}
