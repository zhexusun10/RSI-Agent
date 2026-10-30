import { spawn, type ChildProcess } from "node:child_process";
import { appendWorkerStderrLog, resetWorkerStderrLog } from "../shared/stderr-log.ts";
import type { SandboxHandle, SandboxLauncher } from "../shared/sandbox.ts";
import { NodeProcessTreeKiller, sanitizedChildEnv } from "../reload/process-tree.ts";
import type { SandboxExecutionRequest } from "./types.ts";

const STDERR_TAIL_BYTES = 16_384;

/**
 * Development/integration launcher. It deliberately mirrors the production
 * bootstrap contract: the Worker receives its one-time credential over an
 * inherited stdin pipe, never through argv or the environment. It is never
 * selected by the production entry point, which requires bubblewrap.
 */
class LocalWorkerHandle implements SandboxHandle {
	readonly pid: number;
	readonly startedAtMs: number;
	private readonly child: ChildProcess;
	private readonly killer: NodeProcessTreeKiller;
	private readonly stderrChunks: string[] = [];
	private stderrBytes = 0;
	private readonly stderrLogPath: string | undefined;
	private readonly stderrRedactions: readonly string[];
	private readonly waitPromise: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
	private exit: { readonly exitCode: number | null; readonly signal: string | null } | null = null;
	private terminating = false;

	constructor(
		child: ChildProcess,
		killer: NodeProcessTreeKiller,
		stderrLogPath: string | undefined,
		stderrRedactions: readonly string[],
	) {
		if (child.pid === undefined) throw new Error("Child process did not receive a pid.");
		this.child = child;
		this.pid = child.pid;
		this.startedAtMs = Date.now();
		this.killer = killer;
		this.stderrLogPath = stderrLogPath;
		this.stderrRedactions = stderrRedactions;
		if (stderrLogPath !== undefined && stderrLogPath.length > 0) resetWorkerStderrLog(stderrLogPath);
		child.stdout?.resume();
		child.stderr?.on("data", (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (this.stderrLogPath !== undefined && this.stderrLogPath.length > 0) {
				appendWorkerStderrLog(this.stderrLogPath, text, this.stderrRedactions);
			}
			this.stderrChunks.push(text);
			this.stderrBytes += Buffer.byteLength(text, "utf8");
			while (this.stderrBytes > STDERR_TAIL_BYTES && this.stderrChunks.length > 0) {
				const removed = this.stderrChunks.shift() ?? "";
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

	output(): { readonly stdout: string; readonly stderr: string } {
		return { stdout: "", stderr: this.stderrChunks.join("") };
	}

	wait(): Promise<{ readonly exitCode: number | null; readonly signal: string | null }> {
		return this.waitPromise;
	}

	async terminate(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
		if (this.terminating || this.exit !== null) return;
		this.terminating = true;
		await this.killer.killTree(this.pid, signal);
		try {
			this.child.kill(signal);
		} catch {
			// Already gone.
		}
	}
}

export class LocalWorkerSandboxLauncher implements SandboxLauncher {
	private readonly killer: NodeProcessTreeKiller;

	constructor(killer: NodeProcessTreeKiller = new NodeProcessTreeKiller()) {
		this.killer = killer;
	}

	async launch(request: SandboxExecutionRequest, signal?: AbortSignal): Promise<SandboxHandle> {
		if (signal?.aborted) throw new Error("Launch aborted before start.");
		const executable = request.executable ?? process.execPath;
		const args =
			request.executable === undefined
				? [request.workerEntry, ...(request.args ?? [])]
				: [...(request.args ?? [])];
		const child = spawn(executable, args, {
			cwd: request.cwd,
			env: sanitizedChildEnv(request.env),
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
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
					rejectSpawn(new Error(`Could not launch Worker: ${error.message}`, { cause: error }));
				};
				child.once("spawn", onSpawn);
				child.once("error", onError);
			});
		}
		if (child.stdin === null) {
			child.kill("SIGKILL");
			throw new Error("Worker bootstrap stdin pipe was not created.");
		}
		child.stdin.on("error", () => undefined);
		if (request.bootstrapInput !== undefined) child.stdin.end(request.bootstrapInput);
		else child.stdin.end();
		return new LocalWorkerHandle(
			child,
			this.killer,
			request.stderrLogPath,
			request.stderrRedactions ?? [],
		);
	}
}
