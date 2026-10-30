import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { RsiError } from "../shared/errors.ts";
import { classifyPiInvocation } from "./command-policy.ts";
import { REAL_PI_CLI_ENV, SHIM_MARKER_ENV } from "./types.ts";

export interface PiShimOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	readonly shimPath?: string;
	readonly writeOut?: (text: string) => void;
	readonly writeErr?: (text: string) => void;
}

function isExecutableFile(path: string): boolean {
	try {
		const info = statSync(path);
		return info.isFile();
	} catch {
		return false;
	}
}

/** Resolve the real installed Pi CLI without ever resolving back to this shim. */
export function resolveRealPiCli(env: NodeJS.ProcessEnv, shimPath?: string): string {
	const configured = env[REAL_PI_CLI_ENV];
	if (configured !== undefined && configured.length > 0) {
		if (!isAbsolute(configured)) {
			throw new RsiError("AGENT_COMMAND_FORBIDDEN", `${REAL_PI_CLI_ENV} must be an absolute executable path.`);
		}
		if (!isExecutableFile(configured)) {
			throw new RsiError("AGENT_COMMAND_FORBIDDEN", `${REAL_PI_CLI_ENV} does not name a regular file.`);
		}
		return configured;
	}
	const shimReal = shimPath ? safeRealpath(shimPath) : undefined;
	const names =
		process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi", "pi.mjs"];
	for (const directory of (env.PATH ?? env.Path ?? "").split(delimiter)) {
		if (directory.length === 0) continue;
		for (const name of names) {
			const candidate = join(directory, name);
			if (!isExecutableFile(candidate)) continue;
			if (shimReal !== undefined && safeRealpath(candidate) === shimReal) continue;
			return resolve(candidate);
		}
	}
	throw new RsiError(
		"AGENT_COMMAND_FORBIDDEN",
		`Real Pi CLI not found. Set ${REAL_PI_CLI_ENV} to an absolute executable path and keep this shim earlier in PATH.`,
	);
}

function safeRealpath(path: string): string | undefined {
	try {
		return realpathSync.native(path);
	} catch {
		try {
			return realpathSync(path);
		} catch {
			return undefined;
		}
	}
}

async function forwardToRealPi(argv: readonly string[], options: PiShimOptions): Promise<number> {
	const cli = resolveRealPiCli(options.env, options.shimPath);
	return new Promise<number>((resolvePromise, reject) => {
		const isNodeScript = /\.(?:mjs|cjs|js)$/i.test(cli);
		const command = isNodeScript ? process.execPath : cli;
		const commandArgs = isNodeScript ? [cli, ...argv] : [...argv];
		const child = spawn(command, commandArgs, {
			cwd: options.cwd,
			env: { ...options.env, [SHIM_MARKER_ENV]: "1" },
			stdio: "inherit",
			shell: false,
			windowsHide: false,
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (signal) {
				const signalNumber = signal === "SIGTERM" ? 143 : signal === "SIGHUP" ? 129 : 130;
				resolvePromise(signalNumber);
			} else {
				resolvePromise(code ?? 1);
			}
		});
	});
}

/** Forward only native MCP commands; reject all other Pi CLI invocations. */
export async function runPiShim(args: readonly string[], options: PiShimOptions): Promise<number> {
	const writeErr = options.writeErr ?? ((text) => process.stderr.write(text));
	try {
		const invocation = classifyPiInvocation(args);
		switch (invocation.kind) {
			case "control-reload":
				writeErr("[rsi-pi] reload is forbidden.\n");
				return 2;
			case "forward":
				return await forwardToRealPi(invocation.argv, options);
			case "forbidden":
				writeErr(`[rsi-pi] ${invocation.command} is forbidden: ${invocation.reason}\n`);
				return 2;
			case "unsupported":
				writeErr(`[rsi-pi] ${invocation.command} is unavailable: ${invocation.reason}\n`);
				return 2;
			case "invalid":
				writeErr(`[rsi-pi] invalid invocation: ${invocation.reason}\n`);
				return 2;
		}
	} catch (error) {
		const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
		writeErr(`[rsi-pi] ${stack}\n`);
		return 1;
	}
}
