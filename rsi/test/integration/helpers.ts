import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRsiConfig, type RsiConfig } from "../../src/shared/config.ts";
import { verifyRuntimeLayout, type VerifiedRuntimeLayout } from "../../src/shared/layout-verify.ts";
import { LocalWorkerSandboxLauncher } from "../../src/sandbox/local-launcher.ts";
import { SupervisorRuntime } from "../../src/integration/runtime.ts";

export const RSI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TEST_MODEL_MODULE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "test-model.ts");
export const TEST_PROMPT_MARKER = "INTEGRATION-HUMAN-PROMPT-9C71";

/** Shell command using the actual Runtime pi shim on Linux and Git Bash. */
export function piShimCommand(command: string): string {
	const bin = join(RSI_ROOT, "bin").replaceAll("\\", "/");
	const nodeBin = dirname(process.execPath).replaceAll("\\", "/");
	return [
		"set -e",
		`RSI_BIN='${bin}'`,
		`NODE_BIN='${nodeBin}'`,
		'if command -v cygpath >/dev/null 2>&1; then RSI_BIN="$(cygpath -u "$RSI_BIN")"; NODE_BIN="$(cygpath -u "$NODE_BIN")"; fi',
		'export PATH="$RSI_BIN:$NODE_BIN:$PATH"',
		'export MSYS2_ARG_CONV_EXCL="/reload"',
		`pi ${command}`,
	].join("\n");
}

export interface TestResponseStep {
	readonly text?: string;
	readonly toolCalls?: ReadonlyArray<{
		readonly name: string;
		readonly arguments: Readonly<Record<string, unknown>>;
		readonly id?: string;
	}>;
	readonly stopReason?: "stop" | "length" | "error";
	readonly errorMessage?: string;
}

export interface CapturedRequest {
	readonly index: number;
	readonly atMs: number;
	readonly system: string;
	readonly messages: ReadonlyArray<{
		readonly role?: string;
		readonly toolCallId?: string;
		readonly toolName?: string;
		readonly isError?: boolean;
		readonly text?: string;
	}>;
}

async function freeTcpPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address() as AddressInfo;
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	return address.port;
}

function pipePath(name: string): string {
	return `\\\\.\\pipe\\rsi-int-${process.pid}-${name}-${Date.now()}`;
}

export async function waitFor<T>(
	predicate: () => Promise<T | undefined | false> | T | undefined | false,
	label: string,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value !== undefined && value !== false) return value as T;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

export interface RuntimeHarness {
	readonly root: string;
	readonly paths: RsiConfig["paths"];
	readonly config: RsiConfig;
	readonly verified: VerifiedRuntimeLayout;
	readonly runtime: SupervisorRuntime;
	readonly scriptFile: string;
	readonly captureFile: string;
	readonly logs: string[];
	setScript(steps: readonly TestResponseStep[]): Promise<void>;
	appendScript(steps: readonly TestResponseStep[]): Promise<void>;
	readonly captures: () => Promise<CapturedRequest[]>;
	clearCapture(): Promise<void>;
	readPromptFile(name: string): Promise<string>;
	writePromptFile(name: string, content: string): Promise<void>;
	cleanup(): Promise<void>;
}

export interface HarnessOptions {
	readonly sandboxed?: boolean;
	readonly openAiBaseUrl?: string;
	readonly extraWorkerEnv?: Readonly<Record<string, string>>;
	readonly candidateHooks?: {
		readonly beforeSourceRecheck?: () => Promise<void>;
		readonly afterBackup?: () => Promise<void> | void;
		readonly afterInstall?: () => Promise<void> | void;
	};
	readonly beforeStart?: (input: {
		readonly config: RsiConfig;
		readonly piAgentDir: string;
		readonly workspaceDir: string;
	}) => Promise<void>;
}

export async function startRuntimeHarness(options: HarnessOptions = {}): Promise<RuntimeHarness> {
	const root = await mkdtemp(join(tmpdir(), "rsi-int-"));
	const workspace = join(root, "workspace");
	const stateDir = join(root, "state");
	const dataDir = join(root, "data");
	const markdownsDir = join(dataDir, "markdowns");
	const pluginSourceDir = join(dataDir, "plugins");
	const piAgentDir = join(dataDir, "pi-agent");
	const piSessionDir = join(dataDir, "pi-sessions");
	const workerHomeDir = join(dataDir, "worker-home");
	const promptFile = join(root, "manual-prompt.txt");
	for (const directory of [
		workspace,
		stateDir,
		markdownsDir,
		pluginSourceDir,
		piAgentDir,
		piSessionDir,
		workerHomeDir,
		join(dataDir, "tools"),
		join(dataDir, "workflows"),
	]) {
		await mkdir(directory, { recursive: true });
	}
	await writeFile(promptFile, `${TEST_PROMPT_MARKER}\nHuman-authored system prompt for integration tests.\n`);
	const scriptFile = join(root, "script.json");
	const captureFile = join(root, "capture.jsonl");
	await writeFile(scriptFile, "[]\n");
	await writeFile(captureFile, "");
	const config = parseRsiConfig({
		version: 1,
		timeZone: "UTC",
		paths: {
			workspaceDir: workspace,
			dataDir,
			stateDir,
			markdownsDir,
			pluginSourceDir,
			piSourceDir: join(RSI_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"),
			rsiSourceDir: RSI_ROOT,
			systemPromptFile: promptFile,
			hostIpcSocketPath: join(stateDir, "run", "worker.sock"),
		},
		ipc: {
			heartbeatIntervalMs: 1_000,
			heartbeatTimeoutMs: 15_000,
			requestTimeoutMs: 15_000,
			preflightTimeoutMs: 15_000,
		},
		sandbox: {
			bwrapPath: "bwrap",
			network: "unrestricted",
			workerUid: 65_534,
			workerGid: 65_534,
		},
	});
	const verified = await verifyRuntimeLayout(config.paths);
	const port = await freeTcpPort();
	const endpoint = `tcp://127.0.0.1:${port}`;
	const controlEndpoint = process.platform === "win32" ? pipePath("control") : join(stateDir, "run", "control.sock");
	const operatorEndpoint =
		process.platform === "win32" ? pipePath("operator") : join(stateDir, "control", "operator.sock");
	const logs: string[] = [];
	const runtime = new SupervisorRuntime({
		config,
		verified,
		launcher: new LocalWorkerSandboxLauncher(),
		sandboxed: options.sandboxed ?? false,
		hostIpcEndpoint: endpoint,
		workerIpcEndpoint: endpoint,
		controlEndpoint,
		operatorEndpoint,
		healthFile: join(stateDir, "runtime", "health.json"),
		controlToken: "integration-token",
		testModelModule: TEST_MODEL_MODULE,
		testWorkerEnv: {
			RSI_TEST_SCRIPT_FILE: scriptFile,
			RSI_TEST_CAPTURE_FILE: captureFile,
			...(options.openAiBaseUrl === undefined
				? {}
				: { RSI_TEST_OPENAI_BASE_URL: options.openAiBaseUrl }),
			...(options.extraWorkerEnv ?? {}),
		},
		...(options.candidateHooks === undefined ? {} : { candidateHooks: options.candidateHooks }),
		installSignalHandlers: false,
		onLog: (line) => logs.push(line),
	});
	const harness: RuntimeHarness = {
		root,
		paths: config.paths,
		config,
		verified,
		runtime,
		scriptFile,
		captureFile,
		logs,
		async setScript(steps) {
			await writeFile(scriptFile, `${JSON.stringify(steps, null, 2)}\n`);
		},
		async appendScript(steps) {
			const current = JSON.parse(await readFile(scriptFile, "utf8")) as TestResponseStep[];
			await writeFile(scriptFile, `${JSON.stringify([...current, ...steps], null, 2)}\n`);
		},
		async captures() {
			const text = await readFile(captureFile, "utf8");
			return text
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as CapturedRequest);
		},
		async clearCapture() {
			await writeFile(captureFile, "");
		},
		async readPromptFile(name) {
			return await readFile(join(promptFile, "..", name), "utf8");
		},
		async writePromptFile(name, content) {
			await writeFile(join(root, name), content, "utf8");
		},
		async cleanup() {
			await runtime.stop("integration cleanup").catch(() => undefined);
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					await rm(root, { recursive: true, force: true });
					break;
				} catch (error) {
					if (attempt === 4) throw error;
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
				}
			}
		},
	};
	try {
		await options.beforeStart?.({ config, piAgentDir, workspaceDir: workspace });
		await runtime.start();
	} catch (error) {
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		await harness.cleanup().catch(() => undefined);
		throw new Error(`${message}\n--- runtime logs ---\n${logs.join("\n")}`, { cause: error });
	}
	return harness;
}
