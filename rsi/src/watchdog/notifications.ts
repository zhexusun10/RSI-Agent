import { RsiError } from "../shared/errors.ts";
import type { LkgSnapshot } from "../shared/plugins.ts";
import { AtomicJsonFile } from "../reload/atomic-file.ts";
import type { WatchdogIncidentRecord } from "./types.ts";
import {
	MAX_NOTICE_LOG_BYTES,
	formatRecoveryNotice,
	initialRecoveryNoticeState,
	type RecoveryNotice,
	type RecoveryNoticeReadResult,
	type RecoveryNoticeState,
} from "./types.ts";

const MAX_PENDING_NOTICES = 20;
const MAX_DELIVERED_IDS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNotice(value: unknown): RecoveryNotice {
	if (!isRecord(value)) throw new RsiError("INTERNAL", "Invalid recovery notice.");
	if (
		value.version !== 1 ||
		typeof value.notificationId !== "string" ||
		typeof value.incidentId !== "string" ||
		(value.kind !== "crash-rollback" &&
			value.kind !== "crash-no-lkg" &&
			value.kind !== "rollback-failed" &&
			value.kind !== "restart-failed") ||
		typeof value.createdAtMs !== "number" ||
		typeof value.reason !== "string" ||
		(value.generation !== null && !Number.isInteger(value.generation)) ||
		(value.candidateId !== null && typeof value.candidateId !== "string") ||
		(value.lkgGeneration !== null && !Number.isInteger(value.lkgGeneration)) ||
		(value.lkgCandidateId !== null && typeof value.lkgCandidateId !== "string") ||
		(value.exitCode !== null && !Number.isInteger(value.exitCode)) ||
		(value.signal !== null && typeof value.signal !== "string") ||
		typeof value.log !== "string" ||
		!Number.isInteger(value.deliveryAttempts) ||
		(value.lastDeliveryAttemptAtMs !== null && typeof value.lastDeliveryAttemptAtMs !== "number")
	) {
		throw new RsiError("INTERNAL", "Invalid recovery notice fields.");
	}
	return {
		version: 1,
		notificationId: value.notificationId,
		incidentId: value.incidentId,
		kind: value.kind,
		createdAtMs: value.createdAtMs,
		reason: value.reason,
		generation: value.generation as number | null,
		candidateId: value.candidateId as string | null,
		lkgGeneration: value.lkgGeneration as number | null,
		lkgCandidateId: value.lkgCandidateId as string | null,
		exitCode: value.exitCode as number | null,
		signal: value.signal as string | null,
		log: value.log.slice(-MAX_NOTICE_LOG_BYTES),
		deliveryAttempts: value.deliveryAttempts as number,
		lastDeliveryAttemptAtMs: value.lastDeliveryAttemptAtMs as number | null,
	};
}

export function validateRecoveryNoticeState(value: unknown): RecoveryNoticeState {
	if (!isRecord(value) || value.version !== 1 || typeof value.updatedAtMs !== "number") {
		throw new RsiError("INTERNAL", "Invalid recovery notice state.");
	}
	if (!Array.isArray(value.pending) || !Array.isArray(value.delivered)) {
		throw new RsiError("INTERNAL", "Invalid recovery notice arrays.");
	}
	const delivered = value.delivered.map((entry) => {
		if (
			!isRecord(entry) ||
			typeof entry.notificationId !== "string" ||
			typeof entry.incidentId !== "string" ||
			typeof entry.deliveredAtMs !== "number"
		) {
			throw new RsiError("INTERNAL", "Invalid delivered recovery notice.");
		}
		return {
			notificationId: entry.notificationId,
			incidentId: entry.incidentId,
			deliveredAtMs: entry.deliveredAtMs,
		};
	});
	return {
		version: 1,
		pending: value.pending.map(validateNotice).slice(-MAX_PENDING_NOTICES),
		delivered: delivered.slice(-MAX_DELIVERED_IDS),
		updatedAtMs: value.updatedAtMs,
	};
}

/**
 * Durable recovery-notification outbox.
 *
 * Reading for the first turn does not remove the notice. Only an explicit
 * acknowledge after successful delivery removes it. Therefore a crash between
 * delivery and acknowledgement can at worst repeat the same notification; it
 * cannot silently lose it.
 */
export class RecoveryNoticeStore {
	readonly file: AtomicJsonFile<RecoveryNoticeState>;
	private readonly now: () => Date;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(input: { readonly path: string; readonly clock: { now(): Date } }) {
		this.file = new AtomicJsonFile(input.path, validateRecoveryNoticeState);
		this.now = () => input.clock.now();
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(operation, operation);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async readState(): Promise<{ readonly state: RecoveryNoticeState; readonly diagnostics: readonly string[] }> {
		const read = await this.file.read();
		return {
			state: read.value ?? initialRecoveryNoticeState(this.now()),
			diagnostics: read.diagnostics,
		};
	}

	async enqueueCrash(input: {
		readonly incident: WatchdogIncidentRecord;
		readonly lkg: LkgSnapshot | null;
		readonly kind: "crash-rollback" | "crash-no-lkg" | "rollback-failed" | "restart-failed";
	}): Promise<{ readonly notice: RecoveryNotice; readonly duplicate: boolean }> {
		return this.enqueue(async () => {
			const { state } = await this.readState();
			const existing =
				state.pending.find((notice) => notice.incidentId === input.incident.incidentId) ??
				state.delivered.find((notice) => notice.incidentId === input.incident.incidentId);
			if (existing !== undefined) {
				const pending = state.pending.find((notice) => notice.incidentId === input.incident.incidentId);
				if (pending !== undefined) return { notice: pending, duplicate: true };
				// Delivered notices must not be resurrected by a duplicate crash event.
				return {
					notice: {
						version: 1,
						notificationId: existing.notificationId,
						incidentId: existing.incidentId,
						kind: input.kind,
						createdAtMs: input.incident.atMs,
						reason: input.incident.reason,
						generation: input.incident.generation,
						candidateId: input.incident.candidateId,
						lkgGeneration: input.lkg?.generation ?? null,
						lkgCandidateId: input.lkg?.candidateId ?? null,
						exitCode: input.incident.exitCode,
						signal: input.incident.signal,
						log: input.incident.stderrTail.slice(-MAX_NOTICE_LOG_BYTES),
						deliveryAttempts: 0,
						lastDeliveryAttemptAtMs: null,
					},
					duplicate: true,
				};
			}
			const notice: RecoveryNotice = {
				version: 1,
				notificationId: `notice-${input.incident.incidentId}`,
				incidentId: input.incident.incidentId,
				kind: input.kind,
				createdAtMs: input.incident.atMs,
				reason: input.incident.reason,
				generation: input.incident.generation,
				candidateId: input.incident.candidateId,
				lkgGeneration: input.lkg?.generation ?? null,
				lkgCandidateId: input.lkg?.candidateId ?? null,
				exitCode: input.incident.exitCode,
				signal: input.incident.signal,
				log: input.incident.stderrTail.slice(-MAX_NOTICE_LOG_BYTES),
				deliveryAttempts: 0,
				lastDeliveryAttemptAtMs: null,
			};
			const next: RecoveryNoticeState = {
				...state,
				pending: [...state.pending, notice].slice(-MAX_PENDING_NOTICES),
				updatedAtMs: this.now().getTime(),
			};
			await this.file.write(next);
			return { notice, duplicate: false };
		});
	}

	async pending(): Promise<readonly RecoveryNotice[]> {
		return (await this.readState()).state.pending;
	}

	/** Return the oldest pending notice without clearing it. */
	async nextForFirstTurn(): Promise<RecoveryNoticeReadResult> {
		return this.enqueue(async () => {
			const { state, diagnostics } = await this.readState();
			const first = state.pending[0];
			if (first === undefined) {
				return { notice: null, recoveredFromBackup: diagnostics.length > 0, diagnostics };
			}
			const updated: RecoveryNotice = {
				...first,
				deliveryAttempts: first.deliveryAttempts + 1,
				lastDeliveryAttemptAtMs: this.now().getTime(),
			};
			await this.file.write({
				...state,
				pending: [updated, ...state.pending.slice(1)],
				updatedAtMs: this.now().getTime(),
			});
			return { notice: updated, recoveredFromBackup: diagnostics.length > 0, diagnostics };
		});
	}

	/** Clear only after the notice has been injected into the first wake-up turn. */
	async acknowledge(notificationId: string): Promise<boolean> {
		return this.enqueue(async () => {
			const { state } = await this.readState();
			const notice = state.pending.find((item) => item.notificationId === notificationId);
			if (notice === undefined) return false;
			const next: RecoveryNoticeState = {
				...state,
				pending: state.pending.filter((item) => item.notificationId !== notificationId),
				delivered: [
					...state.delivered,
					{
						notificationId: notice.notificationId,
						incidentId: notice.incidentId,
						deliveredAtMs: this.now().getTime(),
					},
				].slice(-MAX_DELIVERED_IDS),
				updatedAtMs: this.now().getTime(),
			};
			await this.file.write(next);
			return true;
		});
	}

	async textForFirstTurn(): Promise<string | null> {
		const result = await this.nextForFirstTurn();
		return result.notice === null ? null : formatRecoveryNotice(result.notice);
	}
}
