import { RsiError } from "./errors.ts";
import { formatTimestamp, formatWallClock, parseWallClock, parseZonedDateTime } from "./time.ts";

export const SLEEP_TOOL_NAME = "sleep";
export const MIN_SLEEP_DURATION = "1s";
export const SLEEP_DURATION_PATTERN = /^([1-9]\d{0,14})([smh])$/;

export type SleepDurationUnit = "s" | "m" | "h";

export interface SleepDuration {
	readonly raw: string;
	readonly amount: number;
	readonly unit: SleepDurationUnit;
}

export type SleepRequest =
	| { readonly kind: "relative"; readonly duration: SleepDuration }
	| { readonly kind: "absolute"; readonly until: string; readonly normalizedUntil: string };

export interface SleepRequestInput {
	readonly duration?: unknown;
	readonly until?: unknown;
}

const UNIT_MS: Readonly<Record<SleepDurationUnit, number>> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
};

/** Parse one relative duration in s, m, or h. Fractions, zero, and signs are rejected. */
export function parseSleepDuration(input: string): SleepDuration {
	const match = SLEEP_DURATION_PATTERN.exec(input);
	if (!match) {
		throw new RsiError("SLEEP_INVALID", "duration must be a positive integer followed by s, m, or h (for example 30m).");
	}
	const amount = Number(match[1]);
	const unit = match[2] as SleepDurationUnit;
	if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(amount * UNIT_MS[unit])) {
		throw new RsiError("SLEEP_INVALID", "duration is too large to represent safely.");
	}
	return { raw: input, amount, unit };
}

/**
 * Validate the sleep tool's mutually exclusive forms.
 *
 * Exactly one of `duration` and `until` must be present. Supplying both,
 * neither, null, or an empty string is an error.
 */
export function parseSleepRequest(input: unknown): SleepRequest {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new RsiError("SLEEP_INVALID", "sleep requires an object with exactly one of duration or until.");
	}
	const record = input as Record<string, unknown>;
	const hasDuration = record.duration !== undefined;
	const hasUntil = record.until !== undefined;
	if (hasDuration && hasUntil) {
		throw new RsiError("SLEEP_BOTH_FORMS", "sleep accepts exactly one of duration or until, not both.");
	}
	if (!hasDuration && !hasUntil) {
		throw new RsiError("SLEEP_INVALID", "sleep requires exactly one of duration or until.");
	}
	if (hasDuration) {
		if (typeof record.duration !== "string" || record.duration.length === 0) {
			throw new RsiError("SLEEP_INVALID", "duration must be a non-empty string.");
		}
		return { kind: "relative", duration: parseSleepDuration(record.duration) };
	}
	if (typeof record.until !== "string" || record.until.length === 0) {
		throw new RsiError("SLEEP_INVALID", "until must be a non-empty string.");
	}
	return { kind: "absolute", until: record.until, normalizedUntil: formatWallClock(parseWallClock(record.until)) };
}

export interface SleepDeadline {
	readonly request: SleepRequest;
	readonly timeZone: string;
	readonly requestedAtMs: number;
	readonly deadlineMs: number;
	readonly deadlineLocal: string;
	readonly ambiguity?: "earlier";
}

/** Compute the absolute deadline in UTC milliseconds. Past absolute deadlines are rejected. */
export function computeSleepDeadline(input: unknown, now: Date, timeZone: string): SleepDeadline {
	const request = parseSleepRequest(input);
	const requestedAtMs = now.getTime();
	if (!Number.isFinite(requestedAtMs)) {
		throw new RsiError("SLEEP_INVALID", "now must be a valid instant.");
	}
	if (request.kind === "relative") {
		const durationMs = request.duration.amount * UNIT_MS[request.duration.unit];
		const deadlineMs = requestedAtMs + durationMs;
		if (!Number.isSafeInteger(deadlineMs)) {
			throw new RsiError("SLEEP_INVALID", "relative deadline is outside the safely representable range.");
		}
		return {
			request,
			timeZone,
			requestedAtMs,
			deadlineMs,
			deadlineLocal: formatTimestamp(deadlineMs, timeZone),
		};
	}
	const parsed = parseZonedDateTime(request.until, timeZone);
	if (parsed.epochMs <= requestedAtMs) {
		throw new RsiError("SLEEP_DEADLINE_PAST", "until must be later than the current time.", {
			details: { until: parsed.normalized, timeZone },
		});
	}
	return {
		request,
		timeZone,
		requestedAtMs,
		deadlineMs: parsed.epochMs,
		deadlineLocal: parsed.normalized,
		...(parsed.ambiguous ? { ambiguity: "earlier" as const } : {}),
	};
}

/** Persisted sleep state lives only in Agent-unwritable external state. */
export interface SleepState {
	readonly version: 1;
	readonly sleepId: string;
	readonly source: "explicit-sleep-tool";
	readonly request: SleepRequest;
	readonly requestedAtMs: number;
	readonly deadlineMs: number;
	readonly timeZone: string;
	readonly status: "active" | "completed" | "cancelled";
	readonly updatedAtMs: number;
}

/** Only an explicit sleep tool call may create this state. */
export function createSleepState(input: {
	sleepId: string;
	deadline: SleepDeadline;
	now: Date;
}): SleepState {
	return {
		version: 1,
		sleepId: input.sleepId,
		source: "explicit-sleep-tool",
		request: input.deadline.request,
		requestedAtMs: input.deadline.requestedAtMs,
		deadlineMs: input.deadline.deadlineMs,
		timeZone: input.deadline.timeZone,
		status: "active",
		updatedAtMs: input.now.getTime(),
	};
}

export function isSleepDue(state: SleepState, now: Date): boolean {
	return state.status === "active" && now.getTime() >= state.deadlineMs;
}
