import assert from "node:assert/strict";
import test from "node:test";
import { ReloadCoordinator } from "../../src/control/reload.ts";
import { SleepScheduler } from "../../src/loop/sleep.ts";
import {
	FakeClock,
	FakeTimer,
	createTempState,
	flushTasks,
	settle,
} from "../loop/fakes.ts";
import { makeReport, RecordingApply, RecordingPreflight } from "./helpers.ts";

const HOUR = 3_600_000;

test("reload during an active sleep leaves the deadline and model gate intact", async () => {
	const clock = new FakeClock();
	const timers = new FakeTimer(clock);
	const state = await createTempState(clock, "rsi-control-sleep");
	const preflight = new RecordingPreflight(makeReport({ generation: 2 }));
	const apply = new RecordingApply();
	const reload = new ReloadCoordinator({
		clock,
		preflight,
		apply,
		currentGeneration: () => 1,
	});
	const scheduler = new SleepScheduler({
		clock,
		timeZone: "UTC",
		store: state.store,
		timers,
	});
	try {
		await scheduler.start();
		const grant = await scheduler.request({ duration: "2h" }, clock.now());
		let released = false;
		const gate = scheduler
			.beforeModelRequest({ generation: 1, sessionId: "session-1" })
			.then(() => {
				released = true;
			});
		await flushTasks();
		assert.equal(released, false);

		const outcome = await reload.request({
			requestId: "reload-during-sleep",
			reason: "operator reload during sleep",
			source: "worker-shim",
			generation: 1,
			sessionId: "session-1",
		});
		assert.equal(outcome.generation, 2);
		assert.equal(apply.calls, 1);
		const during = await scheduler.status();
		assert.equal(during?.sleepId, grant.sleepId);
		assert.equal(during?.status, "active");
		assert.equal(during?.deadlineMs, grant.deadlineMs);
		assert.equal((await state.store.read()).sleep?.wakeNotifiedAtMs, null);
		assert.equal(released, false);

		timers.advance(2 * HOUR - 1);
		await settle();
		assert.equal(released, false);
		timers.advance(1);
		await gate;
		assert.equal((await scheduler.status())?.status, "completed");
		assert.equal(released, true);
		assert.equal(apply.calls, 1);
	} finally {
		await scheduler.stop();
		await state.cleanup();
	}
});
