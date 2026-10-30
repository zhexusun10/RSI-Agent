import { RsiError } from "./errors.ts";

export const DEFAULT_TIME_ZONE = "UTC";
export const CLOCK_FORMAT_PATTERN = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/;

export interface Clock {
	now(): Date;
}

/** Wall-clock source for the Supervisor and for tests injected into the Worker. */
export class SystemClock implements Clock {
	now(): Date {
		return new Date();
	}
}

/** Validate an IANA time zone or "UTC"; throws CONFIG_INVALID otherwise. */
export function assertValidTimeZone(timeZone: string): string {
	if (timeZone.trim().length === 0) {
		throw new RsiError("CONFIG_INVALID", "timeZone must not be empty.");
	}
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
	} catch (error) {
		throw new RsiError("CONFIG_INVALID", `Invalid IANA time zone: ${timeZone}`, { cause: error });
	}
	return timeZone;
}

export interface ZonedParts {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
}

export interface WallClock extends ZonedParts {}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat("en-US", {
		timeZone,
		calendar: "gregory",
		numberingSystem: "latn",
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/** Read civil time fields in a specific zone. */
export function getZonedParts(instant: Date | number, timeZone: string): ZonedParts {
	assertValidTimeZone(timeZone);
	const date = typeof instant === "number" ? new Date(instant) : instant;
	if (Number.isNaN(date.getTime())) {
		throw new RsiError("TIME_INVALID", "Invalid Date value.");
	}
	const parts = formatterFor(timeZone).formatToParts(date);
	const values = new Map(parts.map((part) => [part.type, part.value]));
	const read = (name: Intl.DateTimeFormatPartTypes): number => {
		const value = values.get(name);
		if (value === undefined) throw new RsiError("TIME_INVALID", `Missing ${name} in time zone formatting.`);
		return Number(value);
	};
	return {
		year: read("year"),
		month: read("month"),
		day: read("day"),
		hour: read("hour") % 24,
		minute: read("minute"),
		second: read("second"),
	};
}

export function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
	switch (month) {
		case 2:
			return isLeapYear(year) ? 29 : 28;
		case 4:
		case 6:
		case 9:
		case 11:
			return 30;
		default:
			return 31;
	}
}

function assertCivilDate(parts: WallClock): void {
	if (
		!Number.isInteger(parts.year) ||
		parts.year < 1 ||
		parts.year > 9999 ||
		!Number.isInteger(parts.month) ||
		parts.month < 1 ||
		parts.month > 12 ||
		!Number.isInteger(parts.day) ||
		parts.day < 1 ||
		parts.day > daysInMonth(parts.year, parts.month) ||
		!Number.isInteger(parts.hour) ||
		parts.hour < 0 ||
		parts.hour > 23 ||
		!Number.isInteger(parts.minute) ||
		parts.minute < 0 ||
		parts.minute > 59 ||
		!Number.isInteger(parts.second) ||
		parts.second < 0 ||
		parts.second > 59
	) {
		throw new RsiError("TIME_INVALID", "Invalid civil date/time.");
	}
}

function utcMsFromCivil(parts: WallClock): number {
	const date = new Date(0);
	date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
	date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
	return date.getTime();
}

function nextDay(parts: WallClock): WallClock {
	const date = new Date(utcMsFromCivil({ ...parts, hour: 0, minute: 0, second: 0 }));
	date.setUTCDate(date.getUTCDate() + 1);
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
		hour: 0,
		minute: 0,
		second: 0,
	};
}

/**
 * Parse the exact wall-clock syntax YYYY/MM/DD HH:mm:ss.
 *
 * 24:00:00 is accepted only when minute and second are both zero, and is
 * normalized to 00:00:00 on the next civil day. 24:00:01 is invalid.
 */
export function parseWallClock(input: string): WallClock {
	const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(input);
	if (!match) {
		throw new RsiError("TIME_INVALID", "Expected YYYY/MM/DD HH:mm:ss.");
	}
	const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
	const parts: WallClock = {
		year: Number(yearText),
		month: Number(monthText),
		day: Number(dayText),
		hour: Number(hourText),
		minute: Number(minuteText),
		second: Number(secondText),
	};
	if (parts.hour === 24) {
		if (parts.minute !== 0 || parts.second !== 0) {
			throw new RsiError("TIME_INVALID", "24:00:00 is the only valid hour-24 spelling.");
		}
		const rolled = nextDay({ ...parts, hour: 0 });
		assertCivilDate(rolled);
		return rolled;
	}
	assertCivilDate(parts);
	return parts;
}

/** Format parsed civil fields as the canonical second-resolution timestamp. */
export function formatWallClock(parts: WallClock): string {
	assertCivilDate(parts);
	const pad = (value: number, width: number): string => String(value).padStart(width, "0");
	return `${pad(parts.year, 4)}/${pad(parts.month, 2)}/${pad(parts.day, 2)} ${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}`;
}

/** Normalize a wall-clock string, including the only legal 24:00:00 spelling. */
export function normalizeWallClock(input: string): string {
	return formatWallClock(parseWallClock(input));
}

/** Offset of a zone at an instant, in milliseconds east of UTC. */
export function getTimeZoneOffsetMs(instant: Date | number, timeZone: string): number {
	const epochMs = typeof instant === "number" ? instant : instant.getTime();
	if (!Number.isFinite(epochMs)) throw new RsiError("TIME_INVALID", "Invalid instant.");
	const wholeSecond = Math.trunc(epochMs / 1_000) * 1_000;
	const parts = getZonedParts(wholeSecond, timeZone);
	return utcMsFromCivil(parts) - wholeSecond;
}

export interface ParsedZonedDateTime {
	readonly timeZone: string;
	readonly epochMs: number;
	readonly normalized: string;
	readonly ambiguous: boolean;
}

/**
 * Resolve a wall-clock string in a zone.
 *
 * A skipped local time (spring-forward gap) is an error. An ambiguous local
 * time (fall-back overlap) resolves to the earlier instant and reports
 * `ambiguous: true`; this policy is deterministic across hosts.
 */
export function parseZonedDateTime(input: string, timeZone: string): ParsedZonedDateTime {
	assertValidTimeZone(timeZone);
	const wallClock = parseWallClock(input);
	const targetMs = utcMsFromCivil(wallClock);
	const offsetCandidates = new Set<number>();
	const oneHour = 3_600_000;
	for (let deltaHours = -36; deltaHours <= 36; deltaHours++) {
		offsetCandidates.add(getTimeZoneOffsetMs(targetMs + deltaHours * oneHour, timeZone));
	}
	const matches: number[] = [];
	for (const offset of offsetCandidates) {
		const candidate = targetMs - offset;
		const candidateParts = getZonedParts(candidate, timeZone);
		if (
			candidateParts.year === wallClock.year &&
			candidateParts.month === wallClock.month &&
			candidateParts.day === wallClock.day &&
			candidateParts.hour === wallClock.hour &&
			candidateParts.minute === wallClock.minute &&
			candidateParts.second === wallClock.second
		) {
			matches.push(candidate);
		}
	}
	if (matches.length === 0) {
		throw new RsiError("TIME_NONEXISTENT", `${input} does not exist in ${timeZone}.`, {
			details: { timeZone, input },
		});
	}
	matches.sort((left, right) => left - right);
	return {
		timeZone,
		epochMs: matches[0] ?? targetMs,
		normalized: formatWallClock(wallClock),
		ambiguous: matches.length > 1,
	};
}

/** Canonical tool/log timestamp: YYYY/MM/DD HH:mm:ss in the configured zone. */
export function formatTimestamp(instant: Date | number, timeZone: string): string {
	return formatWallClock(getZonedParts(instant, timeZone));
}

/** Logs include the zone because the tool suffix intentionally does not. */
export function formatLogTimestamp(instant: Date | number, timeZone: string): string {
	return `${formatTimestamp(instant, timeZone)} ${timeZone}`;
}

export function formatCurrentTimeSuffix(instant: Date | number, timeZone: string): string {
	return `(Current Time: ${formatTimestamp(instant, timeZone)})`;
}

/** Backward-compatible alias used by the decoration helper. */
export const currentTimeSuffix = formatCurrentTimeSuffix;


export const CURRENT_TIME_SUFFIX_PATTERN = /\(Current Time: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\)/;
