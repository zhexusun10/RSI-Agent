import { dirname, join } from "node:path";
import { RsiError } from "../shared/errors.ts";
import { assertManagedDocumentName } from "../shared/managed-path.ts";
import {
	atomicWriteStateFile,
	readStateFileStrict,
	withCrossProcessLock,
	withProcessMutex,
} from "./atomic-fs.ts";

export const READ_STATS_WINDOW_MS = 24 * 60 * 60 * 1_000;
const READ_STATS_VERSION = 1;

interface ReadStatsFile {
	readonly version: 1;
	readonly updatedAtMs: number;
	readonly records: Readonly<Record<string, readonly number[]>>;
}

export interface ReadStatsStoreOptions {
	readonly filePath: string;
	readonly lockDir?: string;
	readonly lockTimeoutMs?: number;
	readonly lockStaleMs?: number;
}

function emptyReadStats(): ReadStatsFile {
	return { version: READ_STATS_VERSION, updatedAtMs: 0, records: {} };
}

function normalizeReadStats(value: unknown): { stats: ReadStatsFile; changed: boolean } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RsiError("INTERNAL", "Knowledge read-stat state is not a JSON object.");
	}
	const record = value as Record<string, unknown>;
	if (record.version !== READ_STATS_VERSION) {
		throw new RsiError("INTERNAL", "Knowledge read-stat state has an unsupported version.");
	}
	if (typeof record.records !== "object" || record.records === null || Array.isArray(record.records)) {
		throw new RsiError("INTERNAL", "Knowledge read-stat records are invalid.");
	}
	let changed = false;
	const records: Record<string, number[]> = {};
	for (const [name, timestamps] of Object.entries(record.records as Record<string, unknown>)) {
		try {
			assertManagedDocumentName(name);
		} catch {
			changed = true;
			continue;
		}
		if (!Array.isArray(timestamps)) {
			changed = true;
			continue;
		}
		const valid: number[] = [];
		for (const timestamp of timestamps) {
			if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) {
				changed = true;
				continue;
			}
			valid.push(Math.trunc(timestamp));
		}
		valid.sort((left, right) => left - right);
		records[name] = valid;
	}
	const updatedAtMs = typeof record.updatedAtMs === "number" && Number.isFinite(record.updatedAtMs)
		? Math.trunc(record.updatedAtMs)
		: 0;
	if (updatedAtMs !== record.updatedAtMs) changed = true;
	return { stats: { version: READ_STATS_VERSION, updatedAtMs, records }, changed };
}

function pruneStats(stats: ReadStatsFile, nowMs: number): { stats: ReadStatsFile; changed: boolean } {
	const cutoff = nowMs - READ_STATS_WINDOW_MS;
	let changed = false;
	const records: Record<string, number[]> = {};
	for (const [name, timestamps] of Object.entries(stats.records)) {
		const kept = timestamps.filter((timestamp) => timestamp > cutoff);
		if (kept.length !== timestamps.length) changed = true;
		if (kept.length > 0) records[name] = kept;
		else if (timestamps.length > 0) changed = true;
	}
	return {
		stats: { version: READ_STATS_VERSION, updatedAtMs: stats.updatedAtMs, records },
		changed,
	};
}

function countInWindow(timestamps: readonly number[] | undefined, nowMs: number): number {
	if (!timestamps) return 0;
	const cutoff = nowMs - READ_STATS_WINDOW_MS;
	let count = 0;
	for (const timestamp of timestamps) {
		if (timestamp > cutoff && timestamp <= nowMs) count++;
	}
	return count;
}

/**
 * Persistent successful-read counters. State lives outside markdowns and is
 * pruned on access so the 24-hour window is rolling, not a calendar day.
 */
export class ReadStatsStore {
	readonly filePath: string;
	readonly lockDir: string;
	readonly lockTimeoutMs: number;
	readonly lockStaleMs: number;
	private readonly processLockKey: string;

	constructor(options: ReadStatsStoreOptions) {
		this.filePath = options.filePath;
		this.lockDir = options.lockDir ?? join(dirname(options.filePath), ".reads.lock");
		this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
		this.lockStaleMs = options.lockStaleMs ?? 30_000;
		this.processLockKey = `read-stats:${this.filePath}`;
	}

	private async loadRaw(): Promise<{ stats: ReadStatsFile; changed: boolean }> {
		const text = await readStateFileStrict(this.filePath);
		if (text === undefined) return { stats: emptyReadStats(), changed: false };
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new RsiError("INTERNAL", "Knowledge read-stat state is corrupted JSON.", { cause: error });
		}
		return normalizeReadStats(parsed);
	}

	private async persist(stats: ReadStatsFile, nowMs: number): Promise<void> {
		const next: ReadStatsFile = { ...stats, updatedAtMs: nowMs };
		await atomicWriteStateFile(this.filePath, `${JSON.stringify(next)}\n`);
	}

	private async locked<T>(action: () => Promise<T>): Promise<T> {
		return withProcessMutex(this.processLockKey, () =>
			withCrossProcessLock(
				this.lockDir,
				{ timeoutMs: this.lockTimeoutMs, staleMs: this.lockStaleMs },
				action,
			),
		);
	}

	/** Return counts after pruning stale records and persisting the cleanup when needed. */
	async counts(now: Date): Promise<ReadonlyMap<string, number>> {
		const nowMs = now.getTime();
		if (!Number.isFinite(nowMs)) throw new RsiError("INTERNAL", "Read-stat time is invalid.");
		return this.locked(async () => {
			const raw = await this.loadRaw();
			const pruned = pruneStats(raw.stats, nowMs);
			if (raw.changed || pruned.changed) {
				await this.persist(pruned.stats, nowMs);
			}
			const result = new Map<string, number>();
			for (const [name, timestamps] of Object.entries(pruned.stats.records)) {
				const count = countInWindow(timestamps, nowMs);
				if (count > 0) result.set(name, count);
			}
			return result;
		});
	}

	async count(name: string, now: Date): Promise<number> {
		assertManagedDocumentName(name);
		const counts = await this.counts(now);
		return counts.get(name) ?? 0;
	}

	/** Record one successful managed read and return its rolling 24-hour count. */
	async record(name: string, at: Date): Promise<number> {
		assertManagedDocumentName(name);
		const atMs = at.getTime();
		if (!Number.isFinite(atMs)) throw new RsiError("INTERNAL", "Read-stat timestamp is invalid.");
		return this.locked(async () => {
			const raw = await this.loadRaw();
			const pruned = pruneStats(raw.stats, atMs);
			const existing = pruned.stats.records[name] ?? [];
			const records: Record<string, number[]> = {};
			for (const [recordName, timestamps] of Object.entries(pruned.stats.records)) {
				records[recordName] = [...timestamps];
			}
			records[name] = [...existing, atMs];
			const stats: ReadStatsFile = { version: READ_STATS_VERSION, updatedAtMs: atMs, records };
			await this.persist(stats, atMs);
			return countInWindow(stats.records[name], atMs);
		});
	}
}
