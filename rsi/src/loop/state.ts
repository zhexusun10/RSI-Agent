import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isRsiError, RsiError } from "../shared/errors.ts";
import { assertPathWithin } from "../shared/paths.ts";
import { parseSleepRequest, type SleepRequest, type SleepState } from "../shared/sleep.ts";
import type { Clock } from "../shared/time.ts";

export const LOOP_STATE_VERSION = 1;
export const LOOP_STATE_MAX_BYTES = 256 * 1024;

export type ContinuationKind = "runtime-wake" | "sleep-wake" | "technical-retry" | "operator-input";
export type ContinuationStatus = "pending" | "dispatching" | "accepted" | "failed" | "skipped";

/**
 * The shared SleepState plus the external fields the Supervisor needs to make
 * wake delivery idempotent. The terminal `sleep.json` file is this ledger, not
 * an in-process timer.
 */
export interface PersistedSleepState extends SleepState {
	readonly generationAtRequest: number | null;
	readonly wakeId: string;
	readonly wakeNotifiedAtMs: number | null;
}

export interface PersistedContinuation {
	readonly id: string;
	readonly kind: ContinuationKind;
	readonly createdAtMs: number;
	readonly status: ContinuationStatus;
	readonly sourceRunId: string | null;
	readonly dispatchedAtMs: number | null;
	readonly acceptedRunId: string | null;
	readonly error: string | null;
}

export interface LoopState {
	readonly version: 1;
	/** Monotonic revision. A restart or duplicate event must not reuse it. */
	readonly revision: number;
	readonly generation: number | null;
	readonly sessionId: string | null;
	readonly sleep: PersistedSleepState | null;
	readonly continuation: PersistedContinuation | null;
	readonly pendingOperatorInputs: number;
	readonly stoppedReason: string | null;
	readonly lastSettledRunId: string | null;
	readonly lastError: string | null;
	readonly updatedAtMs: number;
}

export interface LoopStateStore {
	read(): Promise<LoopState>;
	update(mutator: (state: LoopState, now: Date) => LoopState): Promise<LoopState>;
	transact<T>(
		mutator: (state: LoopState, now: Date) => { readonly state: LoopState; readonly result: T },
	): Promise<{ readonly state: LoopState; readonly result: T; readonly persisted: boolean }>;
}

export interface AtomicLoopStateStoreOptions {
	readonly filePath: string;
	readonly stateDir: string;
	readonly clock: Clock;
}

export function initialLoopState(now: Date, generation: number | null = null, sessionId: string | null = null): LoopState {
	return {
		version: LOOP_STATE_VERSION,
		revision: 0,
		generation,
		sessionId,
		sleep: null,
		continuation: null,
		pendingOperatorInputs: 0,
		stoppedReason: null,
		lastSettledRunId: null,
		lastError: null,
		updatedAtMs: now.getTime(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(record).every((key) => allowed.includes(key));
}

function finiteInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function nonNegativeInteger(value: unknown): value is number {
	return finiteInteger(value) && value >= 0;
}

function assertRequest(value: unknown): asserts value is SleepRequest {
	if (!isRecord(value)) {
		throw new RsiError("INTERNAL", "Persisted sleep request must be an object.");
	}
	if (value.kind === "relative") {
		if (!hasOnlyKeys(value, ["kind", "duration"])) {
			throw new RsiError("INTERNAL", "Persisted relative sleep request has unknown fields.");
		}
		const duration = value.duration;
		if (!isRecord(duration) || !hasOnlyKeys(duration, ["raw", "amount", "unit"])) {
			throw new RsiError("INTERNAL", "Persisted relative sleep duration is invalid.");
		}
		if (
			typeof duration.raw !== "string" ||
			!nonNegativeInteger(duration.amount) ||
			(duration.unit !== "s" && duration.unit !== "m" && duration.unit !== "h")
		) {
			throw new RsiError("INTERNAL", "Persisted relative sleep duration is invalid.");
		}
		const parsed = parseSleepRequest({ duration: duration.raw });
		if (parsed.kind !== "relative" || parsed.duration.amount !== duration.amount || parsed.duration.unit !== duration.unit) {
			throw new RsiError("INTERNAL", "Persisted relative sleep duration does not match its spelling.");
		}
		return;
	}
	if (value.kind === "absolute") {
		if (!hasOnlyKeys(value, ["kind", "until", "normalizedUntil"])) {
			throw new RsiError("INTERNAL", "Persisted absolute sleep request has unknown fields.");
		}
		if (typeof value.until !== "string" || typeof value.normalizedUntil !== "string") {
			throw new RsiError("INTERNAL", "Persisted absolute sleep request is invalid.");
		}
		const parsed = parseSleepRequest({ until: value.until });
		if (parsed.kind !== "absolute" || parsed.normalizedUntil !== value.normalizedUntil) {
			throw new RsiError("INTERNAL", "Persisted absolute sleep request does not match its spelling.");
		}
		return;
	}
	throw new RsiError("INTERNAL", "Persisted sleep request kind is invalid.");
}

function parseSleepRecord(value: unknown): PersistedSleepState {
	if (!isRecord(value)) {
		throw new RsiError("INTERNAL", "Persisted sleep record must be an object.");
	}
	const allowed = [
		"version",
		"sleepId",
		"source",
		"request",
		"requestedAtMs",
		"deadlineMs",
		"timeZone",
		"status",
		"updatedAtMs",
		"generationAtRequest",
		"wakeId",
		"wakeNotifiedAtMs",
	] as const;
	if (!hasOnlyKeys(value, allowed)) {
		throw new RsiError("INTERNAL", "Persisted sleep record has unknown fields.");
	}
	if (value.version !== 1 || value.source !== "explicit-sleep-tool") {
		throw new RsiError("INTERNAL", "Persisted sleep record has an unsupported version or source.");
	}
	if (typeof value.sleepId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.sleepId)) {
		throw new RsiError("INTERNAL", "Persisted sleepId is invalid.");
	}
	assertRequest(value.request);
	if (!finiteInteger(value.requestedAtMs) || !finiteInteger(value.deadlineMs) || value.deadlineMs <= value.requestedAtMs) {
		throw new RsiError("INTERNAL", "Persisted sleep deadline is invalid.");
	}
	if (typeof value.timeZone !== "string" || value.timeZone.length === 0) {
		throw new RsiError("INTERNAL", "Persisted sleep time zone is invalid.");
	}
	if (value.status !== "active" && value.status !== "completed" && value.status !== "cancelled") {
		throw new RsiError("INTERNAL", "Persisted sleep status is invalid.");
	}
	if (!finiteInteger(value.updatedAtMs)) {
		throw new RsiError("INTERNAL", "Persisted sleep updatedAtMs is invalid.");
	}
	if (value.generationAtRequest !== null && !nonNegativeInteger(value.generationAtRequest)) {
		throw new RsiError("INTERNAL", "Persisted sleep generation is invalid.");
	}
	if (typeof value.wakeId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value.wakeId)) {
		throw new RsiError("INTERNAL", "Persisted sleep wakeId is invalid.");
	}
	if (value.wakeNotifiedAtMs !== null && !finiteInteger(value.wakeNotifiedAtMs)) {
		throw new RsiError("INTERNAL", "Persisted sleep notification time is invalid.");
	}
	return value as unknown as PersistedSleepState;
}

function parseContinuation(value: unknown): PersistedContinuation {
	if (!isRecord(value)) {
		throw new RsiError("INTERNAL", "Persisted continuation must be an object.");
	}
	const allowed = [
		"id",
		"kind",
		"createdAtMs",
		"status",
		"sourceRunId",
		"dispatchedAtMs",
		"acceptedRunId",
		"error",
	] as const;
	if (!hasOnlyKeys(value, allowed)) {
		throw new RsiError("INTERNAL", "Persisted continuation has unknown fields.");
	}
	if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value.id)) {
		throw new RsiError("INTERNAL", "Persisted continuation id is invalid.");
	}
	if (
		value.kind !== "runtime-wake" &&
		value.kind !== "sleep-wake" &&
		value.kind !== "technical-retry" &&
		value.kind !== "operator-input"
	) {
		throw new RsiError("INTERNAL", "Persisted continuation kind is invalid.");
	}
	if (!finiteInteger(value.createdAtMs)) {
		throw new RsiError("INTERNAL", "Persisted continuation createdAtMs is invalid.");
	}
	if (
		value.status !== "pending" &&
		value.status !== "dispatching" &&
		value.status !== "accepted" &&
		value.status !== "failed" &&
		value.status !== "skipped"
	) {
		throw new RsiError("INTERNAL", "Persisted continuation status is invalid.");
	}
	for (const key of ["sourceRunId", "acceptedRunId", "error"] as const) {
		const entry = value[key];
		if (entry !== null && typeof entry !== "string") {
			throw new RsiError("INTERNAL", `Persisted continuation ${key} is invalid.`);
		}
	}
	if (value.dispatchedAtMs !== null && !finiteInteger(value.dispatchedAtMs)) {
		throw new RsiError("INTERNAL", "Persisted continuation dispatchedAtMs is invalid.");
	}
	return value as unknown as PersistedContinuation;
}

/** Strictly parse the external state file; malformed state fails closed. */
export function parseLoopState(value: unknown): LoopState {
	if (!isRecord(value)) {
		throw new RsiError("INTERNAL", "Loop state must be a JSON object.");
	}
	const allowed = [
		"version",
		"revision",
		"generation",
		"sessionId",
		"sleep",
		"continuation",
		"pendingOperatorInputs",
		"stoppedReason",
		"lastSettledRunId",
		"lastError",
		"updatedAtMs",
	] as const;
	if (!hasOnlyKeys(value, allowed)) {
		throw new RsiError("INTERNAL", "Loop state has unknown fields.");
	}
	if (value.version !== LOOP_STATE_VERSION) {
		throw new RsiError("INTERNAL", "Loop state has an unsupported version.");
	}
	if (!nonNegativeInteger(value.revision)) {
		throw new RsiError("INTERNAL", "Loop state revision is invalid.");
	}
	if (value.generation !== null && !nonNegativeInteger(value.generation)) {
		throw new RsiError("INTERNAL", "Loop state generation is invalid.");
	}
	if (value.sessionId !== null && (typeof value.sessionId !== "string" || value.sessionId.length > 256)) {
		throw new RsiError("INTERNAL", "Loop state sessionId is invalid.");
	}
	const sleep = value.sleep === null ? null : parseSleepRecord(value.sleep);
	const continuation = value.continuation === null ? null : parseContinuation(value.continuation);
	if (!nonNegativeInteger(value.pendingOperatorInputs)) {
		throw new RsiError("INTERNAL", "Loop state pendingOperatorInputs is invalid.");
	}
	for (const key of ["stoppedReason", "lastSettledRunId", "lastError"] as const) {
		const entry = value[key];
		if (entry !== null && typeof entry !== "string") {
			throw new RsiError("INTERNAL", `Loop state ${key} is invalid.`);
		}
	}
	if (!finiteInteger(value.updatedAtMs)) {
		throw new RsiError("INTERNAL", "Loop state updatedAtMs is invalid.");
	}
	return { ...(value as unknown as LoopState), sleep, continuation };
}

/**
 * External, atomic, single-writer loop/sleep ledger.
 *
 * All mutations are serialized in-process, written to a same-directory temp
 * file with mode 0600, fsynced, and renamed over the target. Reads reject
 * symlinks, hardlinks, non-files, and oversized/partial JSON.
 */
export class AtomicLoopStateStore implements LoopStateStore {
	private readonly filePath: string;
	private readonly stateDir: string;
	private readonly clock: Clock;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: AtomicLoopStateStoreOptions) {
		this.filePath = options.filePath;
		this.stateDir = options.stateDir;
		this.clock = options.clock;
		assertPathWithin(this.stateDir, this.filePath, "loopStateFile");
		if (this.filePath === this.stateDir) {
			throw new RsiError("CONFIG_INVALID", "loopStateFile must be below stateDir.");
		}
	}

	get path(): string {
		return this.filePath;
	}

	private runExclusive<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async assertSafeTarget(): Promise<void> {
		try {
			const info = await lstat(this.filePath);
			if (info.isSymbolicLink()) {
				throw new RsiError("PATH_SYMLINK_FORBIDDEN", "Loop state file must not be a symlink.");
			}
			if (!info.isFile()) {
				throw new RsiError("PATH_NOT_FILE", "Loop state path must be a regular file.");
			}
			if (info.nlink > 1) {
				throw new RsiError("PATH_HARDLINK_FORBIDDEN", "Loop state file must not be hardlinked.");
			}
			if (info.size > LOOP_STATE_MAX_BYTES) {
				throw new RsiError("INTERNAL", "Loop state file is too large.");
			}
		} catch (error) {
			if (isRsiError(error)) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private async ensureDirectory(): Promise<void> {
		const directory = dirname(this.filePath);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const info = await lstat(directory);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new RsiError("PATH_INVALID", "Loop state directory must be a real directory.");
		}
	}

	async read(): Promise<LoopState> {
		await this.assertSafeTarget();
		let text: string;
		try {
			text = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return initialLoopState(this.clock.now());
			}
			throw error;
		}
		if (Buffer.byteLength(text, "utf8") > LOOP_STATE_MAX_BYTES) {
			throw new RsiError("INTERNAL", "Loop state file is too large.");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new RsiError("INTERNAL", "Loop state file is not valid JSON.", { cause: error });
		}
		return parseLoopState(parsed);
	}

	async update(mutator: (state: LoopState, now: Date) => LoopState): Promise<LoopState> {
		const outcome = await this.transact((state, now) => ({ state: mutator(state, now), result: undefined }));
		return outcome.state;
	}

	async transact<T>(
		mutator: (state: LoopState, now: Date) => { readonly state: LoopState; readonly result: T },
	): Promise<{ readonly state: LoopState; readonly result: T; readonly persisted: boolean }> {
		return this.runExclusive(async () => {
			const current = await this.read();
			const now = this.clock.now();
			const mutated = mutator(current, now);
			if (mutated.state === current) {
				return { state: current, result: mutated.result, persisted: false };
			}
			const next: LoopState = {
				...mutated.state,
				version: LOOP_STATE_VERSION,
				revision: current.revision + 1,
				updatedAtMs: finiteInteger(mutated.state.updatedAtMs) ? mutated.state.updatedAtMs : now.getTime(),
			};
			const validated = parseLoopState(next);
			await this.writeAtomic(validated);
			return { state: validated, result: mutated.result, persisted: true };
		});
	}

	private async writeAtomic(state: LoopState): Promise<void> {
		await this.ensureDirectory();
		const directory = dirname(this.filePath);
		const tempPath = `${directory}/.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`;
		const text = `${JSON.stringify(state)}\n`;
		if (Buffer.byteLength(text, "utf8") > LOOP_STATE_MAX_BYTES) {
			throw new RsiError("INTERNAL", "Loop state is too large to persist.");
		}
		let handle;
		try {
			handle = await open(tempPath, "wx", 0o600);
			await handle.writeFile(text, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			try {
				await chmod(tempPath, 0o600);
			} catch {
				// Windows may not model POSIX permissions; the open mode is still restrictive.
			}
			let renamed = false;
			let renameError: unknown;
			for (let attempt = 0; attempt < 50; attempt++) {
				try {
					await rename(tempPath, this.filePath);
					renamed = true;
					break;
				} catch (error) {
					renameError = error;
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
					await new Promise<void>((resolve) => setTimeout(resolve, 5));
				}
			}
			if (!renamed) throw renameError;
			try {
				const directoryHandle = await open(directory, "r");
				try {
					await directoryHandle.sync();
				} finally {
					await directoryHandle.close();
				}
			} catch {
				// Directory fsync is not available on every host.
			}
		} catch (error) {
			if (handle) {
				await handle.close().catch(() => undefined);
			}
			await unlink(tempPath).catch(() => undefined);
			throw error;
		}
	}
}
