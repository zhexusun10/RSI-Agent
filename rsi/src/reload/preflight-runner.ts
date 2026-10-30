import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { RsiError } from "../shared/errors.ts";
import { isPathWithin } from "../shared/paths.ts";
import type { PreflightCheckResult, PreflightReport } from "../shared/preflight.ts";
import type { PreflightPort } from "../shared/ports.ts";
import type { SandboxHandle, SandboxLauncher, SandboxPolicy } from "../shared/sandbox.ts";
import type { Clock } from "../shared/time.ts";
import type { SandboxExecutionRequest } from "../sandbox/types.ts";
import type { ImmutableCandidateStore } from "./candidate-store.ts";
import { NodeProcessTreeKiller, type ProcessTreeKiller } from "./process-tree.ts";
import type { PreflightDiagnostics, PreflightOutcome, ReloadCandidate } from "./types.ts";
import {
	RELOAD_KILL_GRACE_MS,
	RELOAD_MAX_CHILD_OUTPUT_BYTES,
	RELOAD_MAX_CHILD_STDERR_BYTES,
	RELOAD_MOCK_LOAD_TIMEOUT_MS,
	RELOAD_MOCK_SETTLE_MS,
	RELOAD_STATIC_CHECK_TIMEOUT_MS,
} from "./types.ts";
import {
	PREFLIGHT_KIND_ENV,
	PREFLIGHT_MANIFEST_ENV,
	PREFLIGHT_RESULT_ENV,
	PREFLIGHT_SETTLE_MS_ENV,
	type MockLoadWorkerResult,
	type PreflightWorkerKind,
	type PreflightWorkerResult,
	type StaticCheckWorkerResult,
} from "./workers/child-protocol.ts";
import { CHILD_STDERR_PATH_ENV } from "./process-tree.ts";
import { RELOAD_MANIFEST_FILENAME } from "./types.ts";

const STATIC_WORKER = fileURLToPath(new URL("./workers/static-check-worker.ts", import.meta.url));
const MOCK_WORKER = fileURLToPath(new URL("./workers/mock-load-worker.ts", import.meta.url));
const DEFAULT_PREFLIGHT_TEMP_ROOT = join(tmpdir(), "rsi-preflight");

function pathInside(parent: string, candidate: string): boolean {
	return isPathWithin(resolve(parent), resolve(candidate));
}

function lexicalPathIsAllowed(candidate: string, workerEntry: string, protectedRoots: readonly string[]): boolean {
	if (!isAbsolute(candidate)) return false;
	const workerRoot = resolve(dirname(workerEntry));
	if (pathInside(workerRoot, candidate)) return false;
	return !protectedRoots.some((root) => pathInside(root, candidate));
}

async function usablePreflightCwd(
	candidate: string,
	workerEntry: string,
	protectedRoots: readonly string[],
): Promise<string | null> {
	if (!lexicalPathIsAllowed(candidate, workerEntry, protectedRoots)) return null;
	let info;
	try {
		info = await lstat(candidate);
	} catch {
		return null;
	}
	if (info.isSymbolicLink() || !info.isDirectory()) return null;
	let canonical: string;
	try {
		canonical = await realpath(candidate);
	} catch {
		return null;
	}
	if (!lexicalPathIsAllowed(canonical, workerEntry, protectedRoots)) return null;
	for (const root of protectedRoots) {
		const canonicalRoot = await realpath(root).catch(() => resolve(root));
		if (pathInside(canonicalRoot, canonical)) return null;
	}
	const workerRoot = await realpath(dirname(workerEntry)).catch(() => resolve(dirname(workerEntry)));
	if (pathInside(workerRoot, canonical)) return null;
	return resolve(candidate);
}

/**
 * Return an existing preflight working directory that is not the protected
 * source tree (or hidden control state). When the caller supplies an unsafe
 * cwd, use its dedicated staging parent or the OS preflight root instead. The
 * directory must be traversable by the distinct Worker UID inside bwrap.
 */
export async function ensurePreflightWorkingDirectory(input: {
	readonly cwd: string;
	readonly workerEntry: string;
	readonly protectedRoots?: readonly string[];
	readonly fallbackCwd?: string;
}): Promise<string> {
	const protectedRoots = input.protectedRoots ?? [];
	const safe = await usablePreflightCwd(input.cwd, input.workerEntry, protectedRoots);
	if (safe !== null) return safe;
	const candidates = [input.fallbackCwd, DEFAULT_PREFLIGHT_TEMP_ROOT].filter(
		(value): value is string => value !== undefined && value.length > 0,
	);
	for (const candidate of candidates) {
		const directory = resolve(candidate);
		if (!lexicalPathIsAllowed(directory, input.workerEntry, protectedRoots)) continue;
		await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => undefined);
		await chmod(directory, 0o777).catch(() => undefined);
		const usable = await usablePreflightCwd(directory, input.workerEntry, protectedRoots);
		if (usable !== null) return usable;
	}
	throw new RsiError("PREFLIGHT_FAILED", "Could not create a safe preflight working directory.");
}

async function readPreflightTail(path: string, maxBytes: number): Promise<string> {
	try {
		const before = await lstat(path);
		if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) return "";
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const handle = await open(path, constants.O_RDONLY | noFollow);
		try {
			const opened = await handle.stat();
			if (
				!opened.isFile() ||
				opened.nlink !== 1 ||
				opened.dev !== before.dev ||
				opened.ino !== before.ino
			) {
				return "";
			}
			const length = Math.min(opened.size, maxBytes);
			const buffer = Buffer.alloc(length);
			if (length > 0) await handle.read(buffer, 0, length, Math.max(0, opened.size - length));
			return buffer.toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return "";
	}
}

function rejectAfter(ms: number): { readonly promise: Promise<"timeout">; cancel(): void } {
	let timer: NodeJS.Timeout | undefined;
	const promise = new Promise<"timeout">((resolveTimeout) => {
		timer = setTimeout(() => resolveTimeout("timeout"), ms);
	});
	return {
		promise,
		cancel() {
			if (timer !== undefined) clearTimeout(timer);
		},
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function appendDiagnostics(
	errors: readonly string[],
	kind: string,
	input: { timedOut: boolean; exitCode: number | null; signal: string | null; stderr: string; timeoutMs: number },
): string[] {
	const output = [...errors];
	if (input.timedOut) output.push(`${kind} timed out after ${input.timeoutMs}ms; process tree was terminated.`);
	if (!input.timedOut && input.exitCode !== null && input.exitCode !== 0) {
		output.push(`${kind} exited with code ${input.exitCode}.`);
	}
	if (!input.timedOut && input.signal !== null) output.push(`${kind} was terminated by signal ${input.signal}.`);
	const stderr = input.stderr.trim();
	if (stderr.length > 0) output.push(`${kind} stderr tail:\n${stderr.slice(-RELOAD_MAX_CHILD_STDERR_BYTES)}`);
	return output;
}

interface ChildRunInput {
	readonly kind: PreflightWorkerKind;
	readonly workerEntry: string;
	readonly candidate: ReloadCandidate;
	readonly timeoutMs: number;
	readonly env: Record<string, string>;
	readonly signal?: AbortSignal;
}

interface ChildRunOutput {
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly durationMs: number;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly stderr: string;
	readonly result: PreflightWorkerResult | null;
	readonly resultReadError: string | null;
}

/** Preflight launcher adapter: candidate is mounted through the public SandboxLauncher. */
export class SandboxLauncherPreflight {
	private readonly launcher: SandboxLauncher;
	private readonly policy: SandboxPolicy;
	private readonly killer: ProcessTreeKiller;

	constructor(launcher: SandboxLauncher, policy: SandboxPolicy, killer: ProcessTreeKiller = new NodeProcessTreeKiller()) {
		this.launcher = launcher;
		this.policy = policy;
		this.killer = killer;
	}

	private protectedRoots(): string[] {
		return [
			...this.policy.canonicalProtected,
			...this.policy.protected.map((entry) => entry.source),
			...this.policy.hidden,
		];
	}

	async launch(input: {
		readonly workerEntry: string;
		readonly cwd: string;
		readonly env: Readonly<Record<string, string>>;
		readonly signal?: AbortSignal;
	}): Promise<SandboxHandle> {
		const workerEntry = resolve(input.workerEntry);
		const resultPath = input.env[PREFLIGHT_RESULT_ENV];
		const cwd = await ensurePreflightWorkingDirectory({
			cwd: input.cwd,
			workerEntry,
			protectedRoots: this.protectedRoots(),
			...(resultPath === undefined ? {} : { fallbackCwd: dirname(resultPath) }),
		});
		const request: SandboxExecutionRequest = {
			policy: this.policy,
			workerEntry,
			executable: process.execPath,
			args: [workerEntry],
			cwd,
			env: input.env,
		};
		return await this.launcher.launch(request, input.signal);
	}

	async killTree(pid: number): Promise<void> {
		await this.killer.killTree(pid, "SIGKILL");
	}
}

export interface PreflightLauncherPort {
	launch(input: {
		readonly workerEntry: string;
		readonly cwd: string;
		readonly env: Readonly<Record<string, string>>;
		readonly signal?: AbortSignal;
	}): Promise<SandboxHandle>;
	killTree?(pid: number): Promise<void>;
}

async function runChild(
	launcher: PreflightLauncherPort,
	input: ChildRunInput & { readonly tempRoot?: string },
): Promise<ChildRunOutput> {
	const startedAt = Date.now();
	const tempRoot = resolve(input.tempRoot ?? DEFAULT_PREFLIGHT_TEMP_ROOT);
	await mkdir(tempRoot, { recursive: true, mode: 0o711 });
	// The Worker UID must traverse the dedicated staging root but does not need
	// to enumerate it. Each child gets its own removable directory below it.
	await chmod(tempRoot, 0o711).catch(() => undefined);
	const tempDir = join(tempRoot, randomUUID());
	const resultPath = join(tempDir, "result.json");
	const stderrPath = join(tempDir, "stderr.log");
	const stagingCwd = join(tempDir, "cwd");
	const timeout = rejectAfter(input.timeoutMs);
	let timedOut = false;
	let aborted = false;
	let handle: SandboxHandle | null = null;
	let exit: { readonly exitCode: number | null; readonly signal: string | null } | null = null;
	let launchError: string | null = null;
	try {
		await mkdir(tempDir, { recursive: true, mode: 0o700 });
		await mkdir(stagingCwd, { recursive: true, mode: 0o700 });
		// Preflight children run as the distinct Worker UID inside bwrap. Their
		// result and staging directories must be writable without exposing the
		// Supervisor's hidden state tree.
		await chmod(tempDir, 0o777).catch(() => undefined);
		await chmod(stagingCwd, 0o777).catch(() => undefined);
		// The container Supervisor deliberately lacks CAP_DAC_OVERRIDE. A file
		// created mode 0600 by the distinct Worker UID would be unreadable even
		// to root. Pre-create the result as Supervisor-owned and let the child
		// write it; no-follow and single-link checks still fail closed on aliases.
		await writeFile(resultPath, "", { flag: "wx", mode: 0o666 });
		await chmod(resultPath, 0o666);
		if (input.signal?.aborted) {
			aborted = true;
		} else {
			const env: Record<string, string> = {
				...input.env,
				[PREFLIGHT_MANIFEST_ENV]: join(input.candidate.path, RELOAD_MANIFEST_FILENAME),
				[PREFLIGHT_RESULT_ENV]: resultPath,
				[PREFLIGHT_KIND_ENV]: input.kind,
				[CHILD_STDERR_PATH_ENV]: stderrPath,
				...(input.kind === "mock" ? { [PREFLIGHT_SETTLE_MS_ENV]: String(RELOAD_MOCK_SETTLE_MS) } : {}),
			};
			handle = await launcher.launch({
				workerEntry: input.workerEntry,
				// A short, dedicated staging directory avoids both the protected RSI
				// source tree and Windows MAX_PATH cwd failures. Candidate entries are
				// absolute, so module resolution does not depend on this cwd.
				cwd: stagingCwd,
				env,
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
			const waitPromise = handle.wait();
			const abortPromise = new Promise<"aborted">((resolveAbort) => {
				if (input.signal === undefined) return;
				if (input.signal.aborted) resolveAbort("aborted");
				else input.signal.addEventListener("abort", () => resolveAbort("aborted"), { once: true });
			});
			const winner = await Promise.race([
				waitPromise.then((value) => ({ kind: "exit" as const, value })),
				timeout.promise.then(() => ({ kind: "timeout" as const })),
				abortPromise.then(() => ({ kind: "aborted" as const })),
			]);
			if (winner.kind === "exit") {
				exit = winner.value;
			} else {
				timedOut = winner.kind === "timeout";
				aborted = winner.kind === "aborted";
				await handle.terminate("SIGKILL").catch(() => undefined);
				await launcher.killTree?.(handle.pid).catch(() => undefined);
				const completed = await Promise.race([
					waitPromise,
					delay(RELOAD_KILL_GRACE_MS).then(() => null),
				]);
				if (completed !== null) exit = completed;
				else {
					await handle.terminate("SIGKILL").catch(() => undefined);
					await launcher.killTree?.(handle.pid).catch(() => undefined);
				}
			}
		}
	} catch (error) {
		launchError = `Could not start preflight child: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
	} finally {
		timeout.cancel();
	}
	const durationMs = Date.now() - startedAt;
	const stderr = await readPreflightTail(stderrPath, RELOAD_MAX_CHILD_STDERR_BYTES);
	let result: PreflightWorkerResult | null = null;
	let resultReadError: string | null = launchError;
	try {
		const text = await readPreflightTail(resultPath, RELOAD_MAX_CHILD_OUTPUT_BYTES);
		if (text.trim().length === 0) {
			if (!aborted && resultReadError === null) resultReadError = "Child produced no preflight result.";
		} else {
			const parsed = JSON.parse(text) as PreflightWorkerResult;
			if (parsed.kind !== input.kind || !Array.isArray(parsed.errors)) {
				resultReadError = "Child returned an invalid preflight result shape.";
			} else {
				result = parsed;
			}
		}
	} catch (error) {
		resultReadError = `Could not parse child preflight result: ${String(error)}`;
	}
	await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	return {
		timedOut,
		aborted,
		durationMs,
		exitCode: exit?.exitCode ?? null,
		signal: exit?.signal ?? null,
		stderr,
		result,
		resultReadError,
	};
}
function resultErrors(
	kind: string,
	output: ChildRunOutput,
	timeoutMs: number,
): string[] {
	const childErrors = output.result?.errors ?? [];
	let errors = [...childErrors];
	if (output.aborted) errors.push(`${kind} was aborted.`);
	errors = appendDiagnostics(errors, kind, {
		timedOut: output.timedOut,
		exitCode: output.exitCode,
		signal: output.signal,
		stderr: output.stderr,
		timeoutMs,
	});
	if (output.resultReadError !== null) errors.push(output.resultReadError);
	if (output.result !== null && output.result.stack !== undefined) {
		errors.push(`${kind} child stack:\n${output.result.stack}`);
	}
	if (output.result !== null && !output.timedOut && output.exitCode !== 0) {
		errors.push(`${kind} did not finish successfully (exit ${String(output.exitCode)}).`);
	}
	return [...new Set(errors)];
}

function checkResult(errors: readonly string[], durationMs: number): PreflightCheckResult {
	return { ok: errors.length === 0, durationMs, errors };
}

export interface ReloadPreflightOptions {
	readonly candidateStore: ImmutableCandidateStore;
	readonly launcher: PreflightLauncherPort;
	readonly clock: Clock;
	readonly staticTimeoutMs?: number;
	readonly mockTimeoutMs?: number;
	readonly candidateResolver?: (candidateId?: string) => Promise<ReloadCandidate | null>;
	/** Host directory for ephemeral child results; defaults to the OS preflight staging root. */
	readonly tempRoot?: string;
}

/** Static syntax and hard 3-second Mock load preflight in external child processes. */
export class ReloadPreflight implements PreflightPort {
	readonly candidateStore: ImmutableCandidateStore;
	readonly launcher: PreflightLauncherPort;
	readonly clock: Clock;
	readonly staticTimeoutMs: number;
	readonly mockTimeoutMs: number;
	private readonly candidateResolver: ((candidateId?: string) => Promise<ReloadCandidate | null>) | undefined;
	private readonly tempRoot: string | undefined;

	constructor(options: ReloadPreflightOptions) {
		this.candidateStore = options.candidateStore;
		this.launcher = options.launcher;
		this.clock = options.clock;
		this.staticTimeoutMs = Math.min(options.staticTimeoutMs ?? RELOAD_STATIC_CHECK_TIMEOUT_MS, 120_000);
		this.mockTimeoutMs = Math.min(options.mockTimeoutMs ?? RELOAD_MOCK_LOAD_TIMEOUT_MS, RELOAD_MOCK_LOAD_TIMEOUT_MS);
		this.candidateResolver = options.candidateResolver;
		this.tempRoot = options.tempRoot;
	}

	async preflight(candidateId?: string, signal?: AbortSignal): Promise<PreflightReport> {
		if (this.candidateResolver === undefined) {
			throw new RsiError("PREFLIGHT_FAILED", "No candidate resolver is wired into preflight.");
		}
		const candidate = await this.candidateResolver(candidateId);
		if (candidate === null) {
			throw new RsiError("PREFLIGHT_FAILED", `Unknown candidate: ${candidateId ?? "<newest>"}`);
		}
		return (await this.run(candidate, signal)).report;
	}

	async run(candidate: ReloadCandidate, signal?: AbortSignal): Promise<PreflightOutcome> {
		const startVerification = await this.candidateStore.verifyCandidate(candidate.path);
		if (startVerification.digest !== candidate.digest) {
			throw new RsiError("CANDIDATE_CHANGED", "Candidate digest changed before preflight.");
		}
		const staticOutput = await runChild(this.launcher, {
			kind: "static",
			workerEntry: STATIC_WORKER,
			candidate,
			timeoutMs: this.staticTimeoutMs,
			env: {},
			...(this.tempRoot === undefined ? {} : { tempRoot: this.tempRoot }),
			...(signal === undefined ? {} : { signal }),
		});
		const staticErrors = resultErrors("Static syntax check", staticOutput, this.staticTimeoutMs);
		const staticCheck = checkResult(staticErrors, staticOutput.durationMs);
		const afterStatic = await this.candidateStore.verifyCandidate(candidate.path);
		if (afterStatic.digest !== candidate.digest) {
			throw new RsiError("CANDIDATE_CHANGED", "Candidate changed after static syntax check.");
		}

		let mockOutput: ChildRunOutput | null = null;
		let mockErrors: string[];
		if (!staticCheck.ok) {
			mockErrors = ["Mock load skipped because static syntax preflight failed."];
		} else {
			mockOutput = await runChild(this.launcher, {
				kind: "mock",
				workerEntry: MOCK_WORKER,
				candidate,
				timeoutMs: this.mockTimeoutMs,
				env: {},
				...(this.tempRoot === undefined ? {} : { tempRoot: this.tempRoot }),
				...(signal === undefined ? {} : { signal }),
			});
			mockErrors = resultErrors("Mock load", mockOutput, this.mockTimeoutMs);
			if (mockOutput.result !== null && mockOutput.result.kind === "mock") {
				const mock = mockOutput.result as MockLoadWorkerResult;
				if (mock.ok && mock.extensionCount === 0 && candidate.manifest.entries.length > 0) {
					mockErrors.push("Mock load reported success but loaded no extensions.");
				}
			}
		}
		const afterMock = await this.candidateStore.verifyCandidate(candidate.path);
		if (afterMock.digest !== candidate.digest) {
			throw new RsiError("CANDIDATE_CHANGED", "Candidate changed after Mock load.");
		}
		const mockLoad = checkResult(mockErrors, mockOutput?.durationMs ?? 0);
		const report: PreflightReport = {
			candidateId: candidate.candidateId,
			generation: candidate.generation,
			digest: candidate.digest,
			staticSyntaxCheck: staticCheck,
			mockLoad,
			ok: staticCheck.ok && mockLoad.ok,
			completedAtMs: this.clock.now().getTime(),
		};
		const diagnostics: PreflightDiagnostics = {
			staticSyntaxCheck: {
				timedOut: staticOutput.timedOut,
				exitCode: staticOutput.exitCode,
				signal: staticOutput.signal,
				stderr: staticOutput.stderr.slice(-RELOAD_MAX_CHILD_STDERR_BYTES),
			},
			mockLoad: {
				timedOut: mockOutput?.timedOut ?? false,
				exitCode: mockOutput?.exitCode ?? null,
				signal: mockOutput?.signal ?? null,
				stderr: (mockOutput?.stderr ?? "").slice(-RELOAD_MAX_CHILD_STDERR_BYTES),
			},
		};
		return { report, diagnostics };
	}
}

export function formatPreflightToolError(report: PreflightReport): string {
	const lines = [`Plugin preflight failed for ${report.candidateId} (generation ${report.generation}).`];
	if (!report.staticSyntaxCheck.ok) {
		lines.push("Static syntax check:");
		for (const error of report.staticSyntaxCheck.errors) lines.push(`  - ${error}`);
	}
	if (!report.mockLoad.ok) {
		lines.push("Mock load:");
		for (const error of report.mockLoad.errors) lines.push(`  - ${error}`);
	}
	lines.push("Real Pi reload was not performed.");
	return lines.join("\n");
}

export type { StaticCheckWorkerResult, MockLoadWorkerResult };
