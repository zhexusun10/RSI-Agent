import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MAX_TIMER_DELAY_MS } from "../../src/loop/timer.ts";
import {
	computeValidatedSleepDeadline,
	createPiPrepareRequestGate,
	createSleepTool,
	SLEEP_TOOL_PARAMETERS,
	SleepScheduler,
} from "../../src/loop/sleep.ts";
import { parseLoopState } from "../../src/loop/state.ts";
import type { RuntimeEventPublisher } from "../../src/shared/events.ts";
import {
	FakeClock,
	FakeTimer,
	createTempState,
	flushTasks,
	waitFor,
	RecordingEvents,
} from "./fakes.ts";

const HOUR = 3_600_000;

async function makeScheduler(options: {
	clock: FakeClock;
	timers: FakeTimer;
	store: Awaited<ReturnType<typeof createTempState>>["store"];
	events?: RecordingEvents;
	timeZone?: string;
	onWake?: (notification: { sleep: { sleepId: string }; reason: string }) => void | Promise<void>;
	onSleepEntered?: () => void | Promise<void>;
}): Promise<SleepScheduler> {
	return new SleepScheduler({
		clock: options.clock,
		timeZone: options.timeZone ?? "UTC",
		store: options.store,
		timers: options.timers,
		...(options.events === undefined
			? {}
			: { events: options.events as unknown as RuntimeEventPublisher }),
		onWake: options.onWake
			? (notification) => options.onWake?.(notification)
			: undefined,
		onSleepEntered: options.onSleepEntered,
	});
}

test("sleep tool schema has exactly two optional fields and rejects extra keys", () => {
	const schema = SLEEP_TOOL_PARAMETERS as unknown as {
		type: string;
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties?: boolean;
	};
	assert.equal(schema.type, "object");
	assert.deepEqual(Object.keys(schema.properties), ["duration", "until"]);
	assert.equal(schema.required, undefined);
	assert.equal(schema.additionalProperties, false);
	const tool = createSleepTool(
		{
			async request() {
				throw new Error("not called");
			},
			async status() {
				return null;
			},
			async cancel() {
				return false;
			},
		},
		new FakeClock(),
	);
	assert.equal(tool.name, "sleep");
	assert.equal(tool.parameters, SLEEP_TOOL_PARAMETERS);
});

test("sleep tool failures are structured error results with a stack", async () => {
	const tool = createSleepTool(
		{
			async request() {
				throw new Error("not called");
			},
			async status() {
				return null;
			},
			async cancel() {
				return false;
			},
		},
		new FakeClock(),
	);
	const result = await tool.execute("call-1", {}, undefined, undefined, undefined as never);
	assert.equal(result.isError, true);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.match(text, /Sleep request failed/);
	assert.ok(text.includes("\n"));
	const details = result.details as { error?: boolean; stack?: string };
	assert.equal(details.error, true);
	assert.equal(typeof details.stack, "string");
});

test("sleep rejects both/neither forms, invalid amounts, overflow, calendar errors, and past deadlines", async () => {
	const clock = new FakeClock(Date.UTC(2026, 9, 26, 12, 0, 0));
	const timers = new FakeTimer(clock);
	const state = await createTempState(clock);
	try {
		const scheduler = await makeScheduler({ clock, timers, store: state.store });
		await scheduler.start();
		for (const input of [
			{},
			{ duration: "1s", until: "2026/10/27 00:00:00" },
			{ duration: "0s" },
			{ duration: "-1s" },
			{ duration: "1.5s" },
			{ duration: "10d" },
			{ duration: "01s" },
			{ duration: "999999999999999h" },
			{ until: "2026/02/29 12:00:00" },
			{ until: "2026/02/30 24:00:00" },
			{ until: "2026/04/31 24:00:00" },
			{ until: "2026/10/26 24:01:00" },
			{ until: "2026/13/01 00:00:00" },
			{ until: "2026/10/26 11:00:00" },
			{ duration: "1h", extra: true },
		]) {
			await assert.rejects(
				() => scheduler.request(input as never, clock.now()),
				(error: unknown) => error instanceof Error,
			);
		}
		assert.throws(
			() => computeValidatedSleepDeadline({ duration: "1s" }, clock.now(), "Not/AZone"),
			/Invalid IANA time zone/,
		);
		const absolute = await scheduler.request({ until: "2026/10/28 24:00:00" }, clock.now());
		assert.equal(absolute.deadlineLocal, "2026/10/29 00:00:00");
		assert.equal(absolute.deadlineMs, Date.UTC(2026, 9, 29, 0, 0, 0));
		await scheduler.stop();
	} finally {
		await state.cleanup();
	}
});

test("sleep supports relative and zoned absolute deadlines using the injected clock and zone", async () => {
	const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
	const timers = new FakeTimer(clock);
	const state = await createTempState(clock);
	try {
		const scheduler = await makeScheduler({
			clock,
			timers,
			store: state.store,
			timeZone: "Asia/Shanghai",
		});
		await scheduler.start();
		const relative = await scheduler.request({ duration: "5m" }, clock.now());
		assert.equal(relative.deadlineMs, clock.timeMs + 5 * 60_000);
		assert.equal(relative.timeZone, "Asia/Shanghai");
		await scheduler.cancel("test reset", clock.now());
		const absolute = await scheduler.request({ until: "2026/01/01 09:00:00" }, clock.now());
		assert.equal(absolute.deadlineMs, Date.UTC(2026, 0, 1, 1, 0, 0));
		assert.equal(absolute.deadlineLocal, "2026/01/01 09:00:00");
		await scheduler.stop();
	} finally {
		await state.cleanup();
	}
});

test("model request gate blocks every native continuation until the deadline and wakes exactly once", async () => {
	const clock = new FakeClock();
	const timers = new FakeTimer(clock);
	const state = await createTempState(clock);
	const events = new RecordingEvents();
	try {
		const scheduler = await makeScheduler({ clock, timers, store: state.store, events });
		await scheduler.start();
		const grant = await scheduler.request({ duration: "2h" }, clock.now());
		let resolved = 0;
		const gates = Array.from({ length: 4 }, () =>
			scheduler
				.beforeModelRequest({ generation: 1, sessionId: "s1" })
				.then(() => {
					resolved += 1;
				}),
		);
		const prepareRequest = createPiPrepareRequestGate(scheduler, () => ({
			generation: 1,
			sessionId: "s1",
		}));
		gates.push(
			prepareRequest({}).then(() => {
				resolved += 1;
			}),
		);
		await flushTasks();
		assert.equal(resolved, 0);
		timers.advance(2 * HOUR - 1);
		await flushTasks();
		assert.equal(resolved, 0);
		assert.equal(events.count("sleep.woke"), 0);
		timers.advance(1);
		await Promise.all(gates);
		await flushTasks();
		assert.equal(resolved, 5);
		assert.equal(events.count("sleep.woke"), 1);
		assert.equal(events.count("loop.resumed"), 1);
		const status = await scheduler.status();
		assert.equal(status?.sleepId, grant.sleepId);
		assert.equal(status?.status, "completed");
		await scheduler.beforeModelRequest({ generation: 1, sessionId: "s1" });
		timers.advance(10 * HOUR);
		await flushTasks();
		assert.equal(events.count("sleep.woke"), 1);
		await scheduler.stop();
	} finally {
		await state.cleanup();
	}
});

test("long sleeps are chunked and never use an overflowed host timer", async () => {
	const clock = new FakeClock();
	const timers = new FakeTimer(clock);
	const state = await createTempState(clock);
	const events = new RecordingEvents();
	try {
		const scheduler = await makeScheduler({ clock, timers, store: state.store, events });
		await scheduler.start();
		const grant = await scheduler.request({ duration: "10000h" }, clock.now());
		const delays = timers.pendingDelays();
		assert.equal(delays.length, 1);
		assert.ok((delays[0] ?? 0) > 0);
		assert.ok((delays[0] ?? 0) <= MAX_TIMER_DELAY_MS);
		assert.notEqual(delays[0], 1);
		timers.advance(MAX_TIMER_DELAY_MS);
		await flushTasks();
		assert.equal(events.count("sleep.woke"), 0);
		const remaining = grant.deadlineMs - clock.timeMs;
		assert.ok(remaining > 0);
		const nextDelays = timers.pendingDelays();
		assert.equal(nextDelays.length, 1);
		assert.ok((nextDelays[0] ?? 0) > 0);
		timers.advance(remaining);
		await waitFor(() => events.count("sleep.woke") === 1, "long sleep wake");
		assert.equal(events.count("sleep.woke"), 1);
		await scheduler.stop();
	} finally {
		await state.cleanup();
	}
});

test("restart waits for the original deadline; an already-due deadline wakes once", async () => {
	const clock = new FakeClock();
	const state = await createTempState(clock);
	const firstTimers = new FakeTimer(clock);
	const firstEvents = new RecordingEvents();
	try {
		const first = await makeScheduler({
			clock,
			timers: firstTimers,
			store: state.store,
			events: firstEvents,
		});
		await first.start();
		const grant = await first.request({ duration: "2h" }, clock.now());
		await first.stop();

		const secondTimers = new FakeTimer(clock);
		const secondEvents = new RecordingEvents();
		const second = await makeScheduler({
			clock,
			timers: secondTimers,
			store: state.store,
			events: secondEvents,
		});
		await second.start();
		assert.deepEqual(secondTimers.pendingDelays(), [2 * HOUR]);
		secondTimers.advance(2 * HOUR);
		await waitFor(() => secondEvents.count("sleep.woke") === 1, "restart wake");
		assert.equal(secondEvents.count("sleep.woke"), 1);
		assert.equal((await second.status())?.sleepId, grant.sleepId);
		await second.stop();

		const thirdTimers = new FakeTimer(clock);
		const thirdEvents = new RecordingEvents();
		const third = await makeScheduler({
			clock,
			timers: thirdTimers,
			store: state.store,
			events: thirdEvents,
		});
		await third.start();
		assert.equal(thirdTimers.pendingCount, 0);
		assert.equal(thirdEvents.count("sleep.woke"), 0);
		await third.stop();
	} finally {
		await state.cleanup();
	}

	const dueClock = new FakeClock();
	const dueState = await createTempState(dueClock);
	try {
		const originalTimers = new FakeTimer(dueClock);
		const original = await makeScheduler({ clock: dueClock, timers: originalTimers, store: dueState.store });
		await original.start();
		await original.request({ duration: "1h" }, dueClock.now());
		dueClock.advance(2 * HOUR);
		await original.stop();
		const recoveryEvents = new RecordingEvents();
		const recoveryTimers = new FakeTimer(dueClock);
		const recovery = await makeScheduler({
			clock: dueClock,
			timers: recoveryTimers,
			store: dueState.store,
			events: recoveryEvents,
		});
		await recovery.start();
		await waitFor(() => recoveryEvents.count("sleep.woke") === 1, "due recovery wake");
		assert.equal(recoveryEvents.count("sleep.woke"), 1);
		await recovery.stop();
		const repeatedEvents = new RecordingEvents();
		const repeated = await makeScheduler({
			clock: dueClock,
			timers: new FakeTimer(dueClock),
			store: dueState.store,
			events: repeatedEvents,
		});
		await repeated.start();
		await flushTasks();
		assert.equal(repeatedEvents.count("sleep.woke"), 0);
		await repeated.stop();
	} finally {
		await dueState.cleanup();
	}
});

test("cancel resolves the gate, persists cancelled state, and does not wake twice", async () => {
	const clock = new FakeClock();
	const timers = new FakeTimer(clock);
	const state = await createTempState(clock);
	const events = new RecordingEvents();
	try {
		const wakeReasons: string[] = [];
		const scheduler = await makeScheduler({
			clock,
			timers,
			store: state.store,
			events,
			onWake: (notification) => {
				wakeReasons.push(notification.reason);
			},
		});
		await scheduler.start();
		await scheduler.request({ duration: "4h" }, clock.now());
		const gate = scheduler.beforeModelRequest({ generation: 1, sessionId: "s1" });
		await flushTasks();
		assert.equal(await scheduler.cancel("operator cancel", clock.now()), true);
		await gate;
		await flushTasks();
		const persisted = await state.store.read();
		assert.equal(persisted.sleep?.status, "cancelled");
		assert.equal(typeof persisted.sleep?.wakeNotifiedAtMs, "number");
		assert.deepEqual(wakeReasons, ["cancelled"]);
		assert.equal(events.count("sleep.woke"), 1);
		assert.equal(await scheduler.cancel("again", clock.now()), false);
		await scheduler.stop();
	} finally {
		await state.cleanup();
	}
});

test("the external state file is strict, atomic JSON in the state directory", async () => {
	const clock = new FakeClock();
	const timers = new FakeTimer(clock);
	const state = await createTempState(clock);
	try {
		const scheduler = await makeScheduler({ clock, timers, store: state.store });
		await scheduler.start();
		const grant = await scheduler.request({ duration: "1h" }, clock.now());
		const raw = JSON.parse(await readFile(join(state.stateDir, "sleep.json"), "utf8")) as unknown;
		const parsed = parseLoopState(raw);
		assert.equal(parsed.revision >= 1, true);
		assert.equal(parsed.sleep?.sleepId, grant.sleepId);
		assert.equal(parsed.sleep?.deadlineMs, grant.deadlineMs);
		assert.equal(parsed.sleep?.wakeNotifiedAtMs, null);
		assert.equal(parsed.sleep?.generationAtRequest, null);
		await scheduler.stop();
	} finally {
		await state.cleanup();
	}
});
