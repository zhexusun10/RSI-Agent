import assert from "node:assert/strict";
import test from "node:test";
import {
	computeSleepDeadline,
	createSleepState,
	formatLogTimestamp,
	formatTimestamp,
	normalizeWallClock,
	parseSleepRequest,
	parseWallClock,
	parseZonedDateTime,
} from "../src/shared/index.ts";

const hasIcuZone = (zone: string): boolean => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
		return true;
	} catch {
		return false;
	}
};

test("timestamps use the canonical second-resolution format in the configured zone", () => {
	const instant = Date.UTC(2026, 0, 2, 3, 4, 5);
	assert.equal(formatTimestamp(instant, "UTC"), "2026/01/02 03:04:05");
	assert.equal(formatLogTimestamp(instant, "UTC"), "2026/01/02 03:04:05 UTC");
	assert.equal(formatTimestamp(instant, "Asia/Shanghai"), "2026/01/02 11:04:05");
});

test("24:00:00 normalizes to next day only when minute and second are zero", () => {
	assert.equal(normalizeWallClock("2026/12/31 24:00:00"), "2027/01/01 00:00:00");
	assert.equal(normalizeWallClock("2024/02/29 23:59:59"), "2024/02/29 23:59:59");
	assert.throws(() => parseWallClock("2026/01/01 24:00:01"), /24:00:00/);
	assert.throws(() => parseWallClock("2026/02/29 12:00:00"), /Invalid civil/);
	assert.doesNotThrow(() => parseWallClock("2024/02/29 12:00:00"));
});

test(
	"zoned parsing rejects skipped local times and chooses the earlier overlap",
	{ skip: !hasIcuZone("America/New_York") },
	() => {
		assert.throws(
			() => parseZonedDateTime("2026/03/08 02:30:00", "America/New_York"),
			(error: unknown) => (error as { code?: string }).code === "TIME_NONEXISTENT",
		);
		const overlap = parseZonedDateTime("2026/11/01 01:30:00", "America/New_York");
		assert.equal(overlap.ambiguous, true);
		assert.equal(overlap.epochMs, Date.UTC(2026, 10, 1, 5, 30, 0));
	},
);

test("sleep requires exactly one form and a positive integer duration", () => {
	const relative = parseSleepRequest({ duration: "30m" });
	assert.equal(relative.kind, "relative");
	assert.throws(() => parseSleepRequest({}), /exactly one/);
	assert.throws(() => parseSleepRequest({ duration: "1s", until: "2026/01/01 00:00:00" }), /not both/);
	for (const duration of ["0s", "1.5s", "10d", "-1s", "01s"]) {
		assert.throws(() => parseSleepRequest({ duration }), /duration/);
	}
	assert.equal(parseSleepRequest({ until: "2026/12/31 24:00:00" }).kind, "absolute");
});

test("sleep deadlines are computed from relative and zoned absolute forms", () => {
	const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
	const relative = computeSleepDeadline({ duration: "5m" }, now, "UTC");
	assert.equal(relative.deadlineMs, now.getTime() + 5 * 60_000);
	const absolute = computeSleepDeadline({ until: "2026/01/01 09:00:00" }, now, "Asia/Shanghai");
	assert.equal(absolute.deadlineMs, Date.UTC(2026, 0, 1, 1, 0, 0));
	const state = createSleepState({ sleepId: "sleep-1", deadline: relative, now });
	assert.equal(state.source, "explicit-sleep-tool");
	assert.equal(state.status, "active");
	assert.throws(
		() => computeSleepDeadline({ until: "2026/01/01 08:00:00" }, now, "Asia/Shanghai"),
		(error: unknown) => (error as { code?: string }).code === "SLEEP_DEADLINE_PAST",
	);
});
