import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { appendWorkerStderrLog, resetWorkerStderrLog } from "../shared/stderr-log.ts";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { SandboxHandle, SandboxLaunchRequest, SandboxLauncher } from "../shared/sandbox.ts";
import type { SandboxExecutionRequest } from "../sandbox/types.ts";

const execFileAsync = promisify(execFile);

export const CHILD_STDERR_PATH_ENV = "RSI_RELOAD_CHILD_STDERR_PATH";
export const CHILD_STDERR_TAIL_BYTES = 16_384;

/** Do not leak Node's test-runner/coverage control environment into candidate children. */
export function sanitizedChildEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "NODE_TEST_CONTEXT" || key === "NODE_TEST_FILE" || key === "NODE_UNIQUE_ID" || key === "NODE_V8_COVERAGE") {
			continue;
		}
		env[key] = value;
	}
	return { ...env, ...extra };
}

export interface ProcessTreeKiller {
	killTree(pid: number, signal?: NodeJS.Signals): Promise<void>;
	isAlive(pid: number): boolean;
}

export class NodeProcessTreeKiller implements ProcessTreeKiller {
	async killTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
		if (!Number.isInteger(pid) || pid <= 1) return;
		if (process.platform === "win32") {
			try {
				await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
			} catch {
				// The process may already be gone.
			}
			return;
		}
		try {
			process.kill(-pid, signal);
		} catch {
			// Fall back to the direct pid if the group no longer exists.
		}
		try {
			process.kill(pid, signal);
		} catch {
			// Already exited.
		}
	}

	isAlive(pid: number): boolean {
		if (!Number.isInteger(pid) || pid <= 1) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
}

class LocalSandboxHandle implements SandboxHandle {
	readonly pid: number;
	readonly startedAtMs: number;
	private readonly child: ChildProcess;
	private readonly killer: ProcessTreeKiller;
	private readonly stderrTail: string[] = [];
	private stderrBytes = 0;
	private readonly stderrPath: string | undefined;
	private readonly stderrRedactions: readonly string[];
	private readonly waitPromise: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
	private exit: { readonly exitCode: number | null; readonly signal: string | null } | null = null;
	private terminating = false;

	constructor(
		child: ChildProcess,
		killer: ProcessTreeKiller,
		stderrPath: string | undefined,
		stderrRedactions: readonly string[] = [],
	) {
		if (child.pid === undefined) throw new Error("Child process did not receive a pid.");
		this.child = child;
		this.pid = child.pid;
		this.startedAtMs = Date.now();
		this.killer = killer;
		this.stderrPath = stderrPath;
		this.stderrRedactions = stderrRedactions;
		if (stderrPath !== undefined && stderrPath.length > 0) {
			resetWorkerStderrLog(stderrPath);
		}
		child.stdout?.resume();
		child.stderr?.on("data", (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (this.stderrPath !== undefined && this.stderrPath.length > 0) {
				appendWorkerStderrLog(this.stderrPath, text, this.stderrRedactions);
			}
			this.stderrTail.push(text);
			this.stderrBytes += Buffer.byteLength(text, "utf8");
			while (this.stderrBytes > CHILD_STDERR_TAIL_BYTES && this.stderrTail.length > 0) {
				const removed = this.stderrTail.shift() ?? "";
				this.stderrBytes -= Buffer.byteLength(removed, "utf8");
			}
		});
		this.waitPromise = new Promise((resolve) => {
			child.once("error", () => {
				this.exit = { exitCode: null, signal: null };
				resolve(this.exit);
			});
			child.once("close", (exitCode, signal) => {
				this.exit = { exitCode, signal };
				resolve(this.exit);
			});
		});
	}

	stderr(): string {
		return this.stderrTail.join("");
	}

	output(): { readonly stdout: string; readonly stderr: string } {
		return { stdout: "", stderr: this.stderr() };
	}

	wait(): Promise<{ readonly exitCode: number | null; readonly signal: string | null }> {
		return this.waitPromise;
	}

	async terminate(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
		if (this.terminating || this.exit !== null) return;
		this.terminating = true;
		await this.killer.killTree(this.pid, signal);
		// Ensure a short-lived direct child cannot keep the parent waiting forever.
		try {
			this.child.kill(signal);
		} catch {
			// Already gone.
		}
	}

}

/**
 * A local SandboxLauncher implementation for development and tests.
 *
 * Production must inject the bwrap-backed launcher. This implementation still
 * uses a detached process group on POSIX so the parent can terminate the whole
 * tree on deadline. It deliberately ignores the bwrap fields of the policy.
 */
export class LocalProcessGroupLauncher implements SandboxLauncher {
	private readonly killer: ProcessTreeKiller;

	constructor(killer: ProcessTreeKiller = new NodeProcessTreeKiller()) {
		this.killer = killer;
	}

	async launch(request: SandboxLaunchRequest, signal?: AbortSignal): Promise<SandboxHandle> {
		if (signal?.aborted) throw new Error("Launch aborted before start.");
		const execution = request as SandboxExecutionRequest;
		const explicitExecutable = execution.executable;
		const executable = explicitExecutable ?? process.execPath;
		let args: string[];
		if (explicitExecutable === undefined) {
			// Legacy/local Worker entries are scripts; Node is the launcher.
			args = [request.workerEntry, ...(request.args ?? [])];
		} else {
			args = [...(request.args ?? [])];
			if (args.length === 0 && resolve(explicitExecutable) !== resolve(request.workerEntry)) {
				// An explicit executable with no argv must still run the logical entry.
				args.push(request.workerEntry);
			}
		}
		const child = spawn(executable, args, {
			cwd: request.cwd,
			env: sanitizedChildEnv(request.env),
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		// On Windows, Node may return a ChildProcess before pid is assigned.
		// Waiting for "spawn" also turns launch failures into a useful diagnostic
		// instead of a confusing undefined pid later.
		if (child.pid === undefined) {
			await new Promise<void>((resolveSpawn, rejectSpawn) => {
				const cleanup = (): void => {
					child.off("spawn", onSpawn);
					child.off("error", onError);
				};
				const onSpawn = (): void => {
					cleanup();
					resolveSpawn();
				};
				const onError = (error: Error): void => {
					cleanup();
					rejectSpawn(new Error(`Could not launch preflight child: ${error.message}`, { cause: error }));
				};
				child.once("spawn", onSpawn);
				child.once("error", onError);
			});
		}
		const stderrPath = request.stderrLogPath ?? request.env?.[CHILD_STDERR_PATH_ENV];
		const handle = new LocalSandboxHandle(
			child,
			this.killer,
			stderrPath,
			request.stderrRedactions ?? [],
		);
		return handle;
	}
}
