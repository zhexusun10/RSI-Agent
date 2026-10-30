import { chmod, chown, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRsiConfig, type RsiConfig } from "../../src/shared/config.ts";
import { verifyRuntimeLayout, type VerifiedRuntimeLayout } from "../../src/shared/layout-verify.ts";
import { createBubblewrapLauncherForConfig } from "../../src/sandbox/launcher.ts";
import { inspectBubblewrapRuntime } from "../../src/sandbox/preflight.ts";
import type { BubblewrapPreflightReport, SandboxProcessHandle } from "../../src/sandbox/types.ts";
import { SupervisorRuntime } from "../../src/integration/runtime.ts";

export const TARGET_RSI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TARGET_MODEL_MODULE = resolve(
	TARGET_RSI_ROOT,
	"test",
	"integration",
	"fixtures",
	"test-model.ts",
);
export const TARGET_STRICT = process.env.RSI_TARGET_STRICT === "1";
export const TARGET_WORKER_UID = Number.parseInt(process.env.RSI_TARGET_WORKER_UID ?? "10002", 10);
export const TARGET_WORKER_GID = Number.parseInt(process.env.RSI_TARGET_WORKER_GID ?? "10002", 10);

export interface TargetResponseStep {
	readonly text?: string;
	readonly toolCalls?: ReadonlyArray<{
		readonly name: string;
		readonly arguments: Readonly<Record<string, unknown>>;
		readonly id?: string;
	}>;
	readonly stopReason?: "stop" | "length" | "error";
	readonly errorMessage?: string;
}

export type TargetScript =
	| readonly TargetResponseStep[]
	| {
			readonly steps: readonly TargetResponseStep[];
			readonly postRecovery?: readonly TargetResponseStep[];
	  };

export interface TargetPrerequisites {
	readonly skipReason?: string;
	readonly report?: BubblewrapPreflightReport;
}

function strictFailure(message: string): never {
	throw new Error(
		`Linux target acceptance prerequisites failed: ${message}. ` +
			"This target check does not turn a missing Linux/namespace/Docker prerequisite into a skip.",
	);
}

/**
 * The target runner sets RSI_TARGET_STRICT=1. Normal unit-test discovery on a
 * non-Linux development host may skip this file, but the target runner never
 * accepts a missing namespace/userns/bwrap prerequisite as success.
 */
export async function detectTargetPrerequisites(): Promise<TargetPrerequisites> {
	if (process.platform !== "linux") {
		const message = `requires Linux; current platform is ${process.platform}`;
		if (TARGET_STRICT) strictFailure(message);
		return { skipReason: message };
	}
	if (!TARGET_STRICT) {
		return {
			skipReason:
				"target acceptance runs only through rsi/scripts/linux-validation.mjs or linux-soak.mjs with RSI_TARGET_STRICT=1",
		};
	}
	const euid = typeof process.geteuid === "function" ? process.geteuid() : 1;
	if (euid !== 0) {
		const message = "requires a root Supervisor able to start bwrap as a distinct non-root Worker UID";
		if (TARGET_STRICT) strictFailure(message);
		return { skipReason: message };
	}
	if (!Number.isSafeInteger(TARGET_WORKER_UID) || TARGET_WORKER_UID <= 0 || TARGET_WORKER_UID === euid) {
		const message = `invalid Worker UID ${String(TARGET_WORKER_UID)}`;
		if (TARGET_STRICT) strictFailure(message);
		return { skipReason: message };
	}
	if (!Number.isSafeInteger(TARGET_WORKER_GID) || TARGET_WORKER_GID <= 0) {
		const message = `invalid Worker GID ${String(TARGET_WORKER_GID)}`;
		if (TARGET_STRICT) strictFailure(message);
		return { skipReason: message };
	}
	let report: BubblewrapPreflightReport;
	try {
		report = await inspectBubblewrapRuntime(
			{
				workerUid: TARGET_WORKER_UID,
				workerGid: TARGET_WORKER_GID,
				supervisorUid: euid,
				probeTimeoutMs: 30_000,
			},
			process.env.RSI_TEST_BWRAP ?? "bwrap",
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (TARGET_STRICT) strictFailure(message);
		return { skipReason: message };
	}
	if (!report.ok || report.bwrapPath === null) {
		const message = report.errors.join(" | ") || "bubblewrap preflight failed";
		if (TARGET_STRICT) strictFailure(message);
		return { skipReason: message };
	}
	if (!report.features.seccompFd) {
		const message = "bubblewrap does not support the required --seccomp FD feature";
		if (TARGET_STRICT) strictFailure(message);
		return { skipReason: message };
	}
	if (report.nestedUsernsBlocked !== true) {
		const message = "the sandbox did not verify that nested user-namespace creation is blocked";
		if (TARGET_STRICT) strictFailure(message);
		return { skipReason: message };
	}
	// The target job consumes the same report as `rsi --check` and the deployment
	// wrapper. Do not re-probe or re-read sysctls here with a weaker check.
	const unverified = [
		["probeExecuted", report.probeExecuted],
		["hostIdentityVerified", report.hostIdentityVerified],
		["namespaceVerified", report.namespaceVerified],
		["mountVerified", report.mountVerified],
		["capEffZero", report.capEffZero],
		["supplementaryGroupsCleared", report.supplementaryGroupsCleared],
		["protectedHardlinksEnabled", report.protectedHardlinksEnabled],
		["protectedSymlinksEnabled", report.protectedSymlinksEnabled],
	] as const;
	const missing = unverified.filter(([, value]) => value !== true).map(([name]) => name);
	if (missing.length > 0) {
		const message = `runtime preflight did not verify ${missing.join(", ")}`;
		if (TARGET_STRICT) strictFailure(message);
		return { skipReason: message };
	}
	return { report };
}

export function waitFor<T>(
	predicate: () => Promise<T | undefined | false> | T | undefined | false,
	label: string,
	timeoutMs = 30_000,
): Promise<T> {
	return (async () => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const value = await predicate();
			if (value !== undefined && value !== false) return value as T;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
		throw new Error(`Timed out waiting for ${label}`);
	})();
}

export async function readJson<T = Record<string, unknown>>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

export interface TargetHarness {
	readonly root: string;
	readonly stateDir: string;
	readonly promptFile: string;
	readonly paths: RsiConfig["paths"];
	readonly config: RsiConfig;
	readonly verified: VerifiedRuntimeLayout;
	readonly runtime: SupervisorRuntime;
	readonly launcher: ReturnType<typeof createBubblewrapLauncherForConfig>["launcher"];
	readonly policy: ReturnType<typeof createBubblewrapLauncherForConfig>["policy"];
	readonly scriptFile: string;
	readonly captureFile: string;
	readonly logs: string[];
	setScript(script: TargetScript): Promise<void>;
	captures(): Promise<Array<{ index: number; atMs: number; system: string; messages: Array<{ role?: string; toolCallId?: string; toolName?: string; text?: string; isError?: boolean }> }>>;
	stop(): Promise<void>;
	cleanup(): Promise<void>;
}

export interface TargetHarnessOptions {
	readonly root?: string;
	readonly stateDir?: string;
	readonly promptFile?: string;
	readonly preserveOnCleanup?: boolean;
	readonly expectEmptyVolumes?: boolean;
	readonly openAiBaseUrl?: string;
	readonly testWorkerEnv?: Readonly<Record<string, string>>;
	readonly beforeStart?: (input: {
		readonly config: RsiConfig;
		readonly workspaceDir: string;
		readonly markdownsDir: string;
	}) => Promise<void>;
}

const TEST_PROMPT = [
	"TARGET-VALIDATION-HUMAN-PROMPT-FIXTURE",
	"This temporary fixture is not a production Agent prompt and is never installed by deployment.",
	"",
].join("\n");

export async function startTargetHarness(options: TargetHarnessOptions = {}): Promise<TargetHarness> {
	const prerequisites = await detectTargetPrerequisites();
	if (prerequisites.skipReason !== undefined || prerequisites.report === undefined) {
		throw new Error(`Target harness was started without prerequisites: ${prerequisites.skipReason ?? "unknown"}`);
	}
	const report = prerequisites.report;
	const dataBase = resolve(process.env.RSI_TARGET_DATA_ROOT ?? tmpdir());
	const stateBase = resolve(process.env.RSI_TARGET_STATE_ROOT ?? tmpdir());
	await mkdir(dataBase, { recursive: true });
	await mkdir(stateBase, { recursive: true });
	if (options.expectEmptyVolumes === true) {
		const { readdir } = await import("node:fs/promises");
		const [dataEntries, stateEntries] = await Promise.all([readdir(dataBase), readdir(stateBase)]);
		if (dataEntries.length > 0 || stateEntries.length > 0) {
			throw new Error(
				`Target acceptance requires clean volumes, but ${dataBase} or ${stateBase} was not empty.`,
			);
		}
	}

	const root = options.root ?? (await mkdtemp(join(dataBase, "rsi-target-")));
	const stateDir = options.stateDir ?? (await mkdtemp(join(stateBase, "rsi-target-state-")));
	if (options.root !== undefined) await mkdir(root, { recursive: true, mode: 0o755 });
	if (options.stateDir !== undefined) await mkdir(stateDir, { recursive: true, mode: 0o700 });
	const workspace = join(root, "workspace");
	const dataDir = join(root, "data");
	const markdownsDir = join(dataDir, "markdowns");
	const pluginSourceDir = join(dataDir, "plugins");
	const piAgentDir = join(dataDir, "pi-agent");
	const piSessionDir = join(dataDir, "pi-sessions");
	const workerHomeDir = join(dataDir, "worker-home");
	const promptFile = options.promptFile ?? join(root, "target-human-prompt.txt");
	const scriptFile = join(root, "script.json");
	const captureFile = join(root, "capture.jsonl");

	await chmod(root, 0o755);
	await chmod(stateDir, 0o711);
	for (const directory of [
		workspace,
		markdownsDir,
		pluginSourceDir,
		piAgentDir,
		piSessionDir,
		workerHomeDir,
		join(dataDir, "tools"),
		join(dataDir, "workflows"),
	]) {
		await mkdir(directory, { recursive: true, mode: 0o755 });
	}
	if (options.promptFile === undefined && process.env.RSI_TARGET_PROMPT_FILE === undefined) {
		await writeFile(promptFile, TEST_PROMPT, { mode: 0o644 });
	}
	const effectivePromptFile =
		options.promptFile ?? process.env.RSI_TARGET_PROMPT_FILE ?? promptFile;
	await writeFile(scriptFile, "[]\n", { mode: 0o644 });
	await writeFile(captureFile, "", { mode: 0o666 });
	await chmod(captureFile, 0o666);
	await chmod(pluginSourceDir, 0o777);
	await chmod(workspace, 0o777);
	await chmod(markdownsDir, 0o755);
	for (const directory of [workspace, pluginSourceDir, piAgentDir, piSessionDir, workerHomeDir, join(dataDir, "tools"), join(dataDir, "workflows")]) {
		await chown(directory, TARGET_WORKER_UID, TARGET_WORKER_GID);
	}

	const config = parseRsiConfig({
		version: 1,
		timeZone: "UTC",
		paths: {
			workspaceDir: workspace,
			dataDir,
			stateDir,
			markdownsDir,
			pluginSourceDir,
			piSourceDir: join(TARGET_RSI_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"),
			rsiSourceDir: TARGET_RSI_ROOT,
			systemPromptFile: effectivePromptFile,
			hostIpcSocketPath: join(stateDir, "run", "worker.sock"),
		},
		ipc: {
			heartbeatIntervalMs: 1_000,
			heartbeatTimeoutMs: 15_000,
			requestTimeoutMs: 15_000,
			preflightTimeoutMs: 20_000,
		},
		sandbox: {
			bwrapPath: report.bwrapPath ?? "bwrap",
			network: "unrestricted",
			workerUid: TARGET_WORKER_UID,
			workerGid: TARGET_WORKER_GID,
		},
	});
	const verified = await verifyRuntimeLayout(config.paths);
	const configured = createBubblewrapLauncherForConfig(config, verified, {
		readOnlyMounts: [{ source: config.paths.snapshotDir, target: "/run/rsi-plugins", mode: "ro" }],
		terminationGraceMs: 1_000,
		killWaitMs: 2_000,
		maxStdoutBytes: 1_048_576,
		maxStderrBytes: 1_048_576,
	});
	const logs: string[] = [];
	const runtime = new SupervisorRuntime({
		config,
		verified,
		launcher: configured.launcher,
		policy: configured.policy,
		sandboxed: true,
		hostIpcEndpoint: join(stateDir, "run", "worker.sock"),
		workerIpcEndpoint: "/run/rsi/worker.sock",
		controlEndpoint: join(stateDir, "run", "control.sock"),
		operatorEndpoint: join(stateDir, "control", "operator.sock"),
		healthFile: join(stateDir, "runtime", "health.json"),
		controlToken: "target-validation-token",
		testModelModule: TARGET_MODEL_MODULE,
		testWorkerEnv: {
			RSI_TEST_SCRIPT_FILE: scriptFile,
			RSI_TEST_CAPTURE_FILE: captureFile,
			RSI_TARGET_SUPERVISOR_PID: String(process.pid),
			...(options.openAiBaseUrl === undefined ? {} : { RSI_TEST_OPENAI_BASE_URL: options.openAiBaseUrl }),
			...(options.testWorkerEnv ?? {}),
		},
		installSignalHandlers: false,
		onLog: (line) => logs.push(line),
	});
	const harness: TargetHarness = {
		root,
		stateDir,
		promptFile: effectivePromptFile,
		paths: config.paths,
		config,
		verified,
		runtime,
		launcher: configured.launcher,
		policy: configured.policy,
		scriptFile,
		captureFile,
		logs,
		async setScript(script) {
			await writeFile(scriptFile, `${JSON.stringify(script, null, 2)}\n`, { mode: 0o644 });
		},
		async captures() {
			const text = await readFile(captureFile, "utf8");
			return text
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as Awaited<ReturnType<TargetHarness["captures"]>>[number]);
		},
		async stop() {
			await runtime.stop("target validation cleanup").catch(() => undefined);
		},
		async cleanup() {
			await harness.stop();
			if (options.preserveOnCleanup === true) return;
			await rm(root, { recursive: true, force: true });
			await rm(stateDir, { recursive: true, force: true });
		},
	};
	try {
		await options.beforeStart?.({ config, workspaceDir: workspace, markdownsDir });
		await runtime.start();
	} catch (error) {
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		await harness.cleanup().catch(() => undefined);
		throw new Error(`${message}\n--- target runtime logs ---\n${logs.join("\n")}`, { cause: error });
	}
	return harness;
}

export async function runSandboxCommand(
	harness: TargetHarness,
	command: string,
	timeoutMs = 60_000,
): Promise<{ handle: SandboxProcessHandle; stdout: string; stderr: string; exitCode: number | null }> {
	const handle = await harness.launcher.launch({
		policy: harness.policy,
		workerEntry: "/bin/bash",
		args: ["-c", command],
		cwd: harness.paths.workspaceDir,
		env: {
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			HOME: harness.paths.workerHomeDir,
			TMPDIR: "/tmp",
			RSI_TARGET_SUPERVISOR_PID: String(process.pid),
		},
		timeoutMs,
		maxStdoutBytes: 1_048_576,
		maxStderrBytes: 1_048_576,
	});
	const exit = await handle.wait();
	const output = handle.output();
	return {
		handle,
		stdout: output.stdout,
		stderr: output.stderr,
		exitCode: exit.exitCode,
	};
}
