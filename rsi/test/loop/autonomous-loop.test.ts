import assert from "node:assert/strict";
import test from "node:test";
import {
	AutonomousLoop,
	type LoopWorkerEvent,
	type LoopWorkerPort,
	type LoopWorkerRunRequest,
	type LoopWorkerRunResult,
} from "../../src/loop/autonomous-loop.ts";
import { SleepScheduler } from "../../src/loop/sleep.ts";
import type { LoopStateStore } from "../../src/loop/state.ts";
import type { HeartbeatReport } from "../../src/shared/ipc/protocol.ts";
import type { WatchdogPort } from "../../src/shared/ports.ts";
import {
	FakeClock,
	FakeTimer,
	createTempState,
	flushTasks,
	settle,
	waitFor,
	type TempState,
} from "./fakes.ts";

const HOUR = 3_600_000;

class FakeWorker implements LoopWorkerPort {
	generation: number | null = 1;
	sessionId: string | null = "session-1";
	queued = false;
	starts: LoopWorkerRunRequest[] = [];
	aborts: string[] = [];
	private counter = 0;
	resultFactory: (request: LoopWorkerRunRequest) => LoopWorkerRunResult = () => {
		this.counter += 1;
		return { accepted: true, runId: `run-${this.counter}` };
	};

	currentGeneration(): number | null {
		return this.generation;
	}

	currentSessionId(): string | null {
		return this.sessionId;
	}

	hasQueuedTasks(): boolean {
		return this.queued;
	}

	async startRuntimeTurn(request: LoopWorkerRunRequest): Promise<LoopWorkerRunResult> {
		this.starts.push(request);
		return this.resultFactory(request);
	}

	async abortActiveRun(reason: string): Promise<void> {
		this.aborts.push(reason);
	}
}

class FakeWatchdog implements WatchdogPort {
	readonly heartbeats: HeartbeatReport[] = [];
	readonly exits: Array<{ exitCode: number | null; signal: string | null }> = [];
	started = false;

	start(): void {
		this.started = true;
	}

	async stop(): Promise<void> {
		this.started = false;
	}

	async recordHeartbeat(report: HeartbeatReport): Promise<void> {
		this.heartbeats.push(report);
	}

	async recordWorkerExit(exitCode: number | null, signal: string | null): Promise<void> {
		this.exits.push({ exitCode, signal });
	}
}

interface Harness {
	readonly clock: FakeClock;
	readonly timers: FakeTimer;
	readonly state: TempState;
	readonly worker: FakeWorker;
	readonly scheduler: SleepScheduler;
	readonly loop: AutonomousLoop;
	readonly errors: unknown[];
	cleanup(): Promise<void>;
}

async function createHarness(options: { baseBackoffMs?: number; maxBackoffMs?: number } = {}): Promise<Harness> {
	const clock = new FakeClock();
	const timers = new FakeTimer(clock);
	const state = await createTempState(clock, "rsi-autonomous-loop");
	const worker = new FakeWorker();
	const errors: unknown[] = [];
	let loopRef: AutonomousLoop | undefined;
	const scheduler = new SleepScheduler({
		clock,
		timeZone: "UTC",
		store: state.store,
		timers,
		onSleepEntered: (sleep) => loopRef?.pauseForSleep(sleep),
		onWake: (notification) =>
			loopRef?.handleSleepWake({ sleep: notification.sleep, reason: notification.reason }),
		onError: (error) => errors.push(error),
	});
	const loop = new AutonomousLoop({
		clock,
		timeZone: "UTC",
		store: state.store,
		timers,
		worker,
		sleep: scheduler,
		sleepScheduler: scheduler,
		baseBackoffMs: options.baseBackoffMs ?? 100,
		maxBackoffMs: options.maxBackoffMs ?? 1_000,
		onError: (error) => errors.push(error),
	});
	loopRef = loop;
	await loop.start();
	timers.advance(0);
	await waitFor(() => worker.starts.length === 1, "initial runtime turn");
	await waitFor(
		async () => (await state.store.read()).continuation?.status === "accepted",
		"initial continuation accepted",
	);
	return {
		clock,
		timers,
		state,
		worker,
		scheduler,
		loop,
		errors,
		async cleanup() {
			await loop.stop("test cleanup");
			await state.cleanup();
		},
	};
}

function settled(
	runId: string,
	overrides: Partial<Extract<LoopWorkerEvent, { type: "agent_settled" }>> = {},
): Extract<LoopWorkerEvent, { type: "agent_settled" }> {
	return {
		type: "agent_settled",
		runId,
		generation: 1,
		sessionId: "session-1",
		aborted: false,
		...(overrides as object),
	};
}

test("agent_end never appends a continuation", async () => {
	const harness = await createHarness();
	try {
		assert.equal(harness.worker.starts.length, 1);
		await harness.loop.handleWorkerEvent({ type: "agent_end", runId: "run-1", willRetry: true });
		harness.timers.advance(10 * HOUR);
		await settle();
		assert.equal(harness.worker.starts.length, 1);
		assert.equal(harness.loop.status().state, "running");
	} finally {
		await harness.cleanup();
	}
});

test("agent_settled appends exactly one continuation and duplicate settle events are ignored", async () => {
	const harness = await createHarness();
	try {
		assert.equal(harness.worker.starts.length, 1);
		await harness.loop.handleWorkerEvent(settled("run-1"));
		harness.timers.advance(0);
		await waitFor(() => harness.worker.starts.length === 2, "settled continuation");
		assert.equal(harness.worker.starts[1]?.kind, "runtime-wake");
		await harness.loop.handleWorkerEvent(settled("run-1"));
		harness.timers.advance(0);
		await settle();
		assert.equal(harness.worker.starts.length, 2);
		await harness.loop.handleWorkerEvent(settled("run-2"));
		harness.timers.advance(0);
		await waitFor(() => harness.worker.starts.length === 3, "second settled continuation");
	} finally {
		await harness.cleanup();
	}
});

test("queued work and operator aborts do not receive a Supervisor continuation", async () => {
	const queuedHarness = await createHarness();
	try {
		queuedHarness.worker.queued = true;
		await queuedHarness.loop.handleWorkerEvent(settled("run-1"));
		queuedHarness.timers.advance(1_000);
		await settle();
		assert.equal(queuedHarness.worker.starts.length, 1);
	} finally {
		await queuedHarness.cleanup();
	}

	const abortHarness = await createHarness();
	try {
		await abortHarness.loop.handleWorkerEvent(settled("run-1", { aborted: true }));
		abortHarness.timers.advance(1_000);
		await settle();
		assert.equal(abortHarness.worker.starts.length, 1);
	} finally {
		await abortHarness.cleanup();
	}
});

test("network/provider errors use bounded technical backoff rather than a tight loop", async () => {
	const harness = await createHarness({ baseBackoffMs: 100, maxBackoffMs: 400 });
	try {
		await harness.loop.handleWorkerEvent(settled("run-1", { stopReason: "error" }));
		await waitFor(() => harness.timers.pendingDelays()[0] === 100, "backoff timer");
		assert.equal(harness.worker.starts.length, 1);
		assert.deepEqual(harness.timers.pendingDelays(), [100]);
		harness.timers.advance(99);
		await settle();
		assert.equal(harness.worker.starts.length, 1);
		harness.timers.advance(1);
		await waitFor(() => harness.worker.starts.length === 2, "backoff retry");
		assert.equal(harness.worker.starts[1]?.kind, "technical-retry");
	} finally {
		await harness.cleanup();
	}
});

test("explicit sleep suppresses settled continuation; wake starts one sleep turn", async () => {
	const harness = await createHarness();
	try {
		await harness.scheduler.request({ duration: "2h" }, harness.clock.now());
		assert.equal(harness.loop.status().state, "sleeping");
		await harness.loop.handleWorkerEvent(settled("run-1"));
		harness.timers.advance(HOUR);
		await settle();
		assert.equal(harness.worker.starts.length, 1);
		harness.timers.advance(HOUR);
		await waitFor(() => {
			harness.timers.runDue();
			return harness.worker.starts.length === 2;
		}, "sleep wake turn");
		assert.equal(harness.worker.starts[1]?.kind, "sleep-wake");
		assert.equal(harness.loop.status().state, "running");
	} finally {
		await harness.cleanup();
	}
});

test("a native continuation inside an active run resumes without a second runtime turn", async () => {
	const harness = await createHarness();
	try {
		await harness.scheduler.request({ duration: "1h" }, harness.clock.now());
		let released = false;
		const gate = harness.scheduler
			.beforeModelRequest({ generation: 1, sessionId: "session-1" })
			.then(() => {
				released = true;
			});
		await flushTasks();
		assert.equal(released, false);
		harness.timers.advance(HOUR);
		await gate;
		await settle();
		assert.equal(released, true);
		assert.equal(harness.worker.starts.length, 1);
	} finally {
		await harness.cleanup();
	}
});

test("operator input is queued without a duplicate runtime wake", async () => {
	const harness = await createHarness();
	try {
		await harness.loop.noteOperatorInput("input-1");
		await harness.loop.handleWorkerEvent(settled("run-1"));
		harness.timers.advance(1_000);
		await settle();
		assert.equal(harness.worker.starts.length, 1);
		await harness.loop.handleWorkerEvent({
			type: "run_started",
			runId: "run-operator",
			generation: 1,
			sessionId: "session-1",
			source: "operator",
		});
		await harness.loop.handleWorkerEvent(settled("run-operator"));
		harness.timers.advance(0);
		await waitFor(() => harness.worker.starts.length === 2, "operator-followed runtime turn");
	} finally {
		await harness.cleanup();
	}
});

test("operator input during sleep does not cancel the deadline or duplicate the wake", async () => {
	const harness = await createHarness();
	try {
		await harness.scheduler.request({ duration: "1h" }, harness.clock.now());
		await harness.loop.noteOperatorInput("manual-input");
		await harness.loop.handleWorkerEvent(settled("run-1"));
		harness.timers.advance(HOUR);
		await waitFor(async () => {
			harness.timers.runDue();
			return (await harness.scheduler.status())?.status === "completed";
		}, "sleep deadline processing");
		await settle();
		assert.equal((await harness.scheduler.status())?.status, "completed");
		assert.equal(harness.worker.starts.length, 1);
		const state = await harness.state.store.read();
		assert.equal(state.pendingOperatorInputs, 1);
	} finally {
		await harness.cleanup();
	}
});

test("session switch and reload ignore stale settled events and schedule one new turn", async () => {
	const harness = await createHarness();
	try {
		await harness.loop.updateRuntime(2, "session-2");
		harness.worker.generation = 2;
		harness.worker.sessionId = "session-2";
		harness.timers.advance(0);
		await waitFor(() => harness.worker.starts.length === 2, "session switch turn");
		assert.equal(harness.worker.starts[1]?.generation, 2);
		await harness.loop.handleWorkerEvent(settled("stale-run", { generation: 1, sessionId: "session-1" }));
		harness.timers.advance(0);
		await settle();
		assert.equal(harness.worker.starts.length, 2);
		await harness.loop.handleWorkerEvent(settled("run-2", { generation: 2, sessionId: "session-2" }));
		harness.timers.advance(0);
		await waitFor(() => harness.worker.starts.length === 3, "post-settle turn");

		await harness.loop.notifyReloadStarted("test reload");
		harness.timers.advance(10 * HOUR);
		await settle();
		assert.equal(harness.worker.starts.length, 3);
		harness.worker.generation = 3;
		await harness.loop.notifyReloadFinished(3, "session-2");
		harness.timers.advance(0);
		await waitFor(() => harness.worker.starts.length === 4, "post-reload turn");
	} finally {
		await harness.cleanup();
	}
});

test("sleep heartbeat state stays live and never records a worker exit", async () => {
	const harness = await createHarness();
	const watchdog = new FakeWatchdog();
	try {
		await harness.scheduler.request({ duration: "2h" }, harness.clock.now());
		const report: HeartbeatReport = {
			sequence: 1,
			workerPid: 123,
			generation: 1,
			state: harness.loop.heartbeatState(),
			healthTurns: 0,
			memoryRevision: null,
			sentAtMs: harness.clock.timeMs,
		};
		assert.equal(report.state, "sleeping");
		await watchdog.recordHeartbeat(report);
		harness.timers.advance(HOUR);
		await settle();
		assert.equal(harness.loop.heartbeatState(), "sleeping");
		await watchdog.recordHeartbeat({ ...report, sequence: 2, state: harness.loop.heartbeatState() });
		assert.equal(watchdog.heartbeats.length, 2);
		assert.equal(watchdog.exits.length, 0);
		assert.equal(harness.loop.status().state, "sleeping");
	} finally {
		await harness.cleanup();
	}
});

test("operator stop clears timers, aborts the run, and never self-restarts", async () => {
	const harness = await createHarness();
	try {
		await harness.loop.stop("operator shutdown");
		assert.equal(harness.loop.status().state, "stopped");
		assert.deepEqual(harness.worker.aborts, ["operator shutdown"]);
		const starts = harness.worker.starts.length;
		harness.timers.advance(48 * HOUR);
		await settle();
		assert.equal(harness.worker.starts.length, starts);
		assert.equal(harness.timers.pendingCount, 0);
	} finally {
		await harness.state.cleanup();
	}
});

test("a due persisted sleep wake is delivered once and a pending continuation is reused", async () => {
	const clock = new FakeClock();
	const timers = new FakeTimer(clock);
	const state = await createTempState(clock, "rsi-loop-restart");
	const worker = new FakeWorker();
	worker.generation = 4;
	try {
		await state.store.update((current) => ({
			...current,
			generation: 4,
			continuation: {
				id: "continuation-persisted",
				kind: "sleep-wake",
				createdAtMs: clock.timeMs,
				status: "pending",
				sourceRunId: null,
				dispatchedAtMs: null,
				acceptedRunId: null,
				error: null,
			},
		}));
		let loopRef: AutonomousLoop | undefined;
		const scheduler = new SleepScheduler({
			clock,
			timeZone: "UTC",
			store: state.store,
			timers,
			onSleepEntered: (sleep) => loopRef?.pauseForSleep(sleep),
			onWake: (notification) =>
				loopRef?.handleSleepWake({ sleep: notification.sleep, reason: notification.reason }),
		});
		const loop = new AutonomousLoop({
			clock,
			timeZone: "UTC",
			store: state.store,
			timers,
			worker,
			sleep: scheduler,
			sleepScheduler: scheduler,
			baseBackoffMs: 100,
			maxBackoffMs: 1_000,
			onError: () => undefined,
		});
		loopRef = loop;
		await loop.start();
		await waitFor(() => worker.starts.length === 1, "persisted continuation");
		assert.equal(worker.starts[0]?.continuationId, "continuation-persisted");
		const persisted = await state.store.read();
		assert.equal(persisted.continuation?.status, "accepted");
		await loop.stop("test stop");
	} finally {
		await state.cleanup();
	}
});

test("loop state type is accepted by the store and preserves generation/sleep metadata", async () => {
	const clock = new FakeClock();
	const state = await createTempState(clock, "rsi-loop-state");
	try {
		const store: LoopStateStore = state.store;
		const updated = await store.update((current) => ({ ...current, generation: 7, sessionId: "session-7" }));
		assert.equal(updated.generation, 7);
		assert.equal(updated.sessionId, "session-7");
		assert.equal(updated.revision, 1);
	} finally {
		await state.cleanup();
	}
});

test("a due persisted sleep on loop start produces exactly one wake continuation", async () => {
	const clock = new FakeClock();
	const timers = new FakeTimer(clock);
	const state = await createTempState(clock, "rsi-loop-due-sleep");
	const worker = new FakeWorker();
	try {
		const now = clock.now();
		await state.store.update((current) => ({
			...current,
			generation: 1,
			sessionId: "session-1",
			sleep: {
				version: 1,
				sleepId: "sleep-persisted-due",
				source: "explicit-sleep-tool",
				request: { kind: "relative", duration: { raw: "1s", amount: 1, unit: "s" } },
				requestedAtMs: now.getTime() - 10_000,
				deadlineMs: now.getTime() - 1_000,
				timeZone: "UTC",
				status: "active",
				updatedAtMs: now.getTime() - 10_000,
				generationAtRequest: 1,
				wakeId: "runtime-wake:sleep-persisted-due",
				wakeNotifiedAtMs: null,
			},
		}));
		let loopRef: AutonomousLoop | undefined;
		const scheduler = new SleepScheduler({
			clock,
			timeZone: "UTC",
			store: state.store,
			timers,
			onSleepEntered: (sleep) => loopRef?.pauseForSleep(sleep),
			onWake: (notification) =>
				loopRef?.handleSleepWake({ sleep: notification.sleep, reason: notification.reason }),
		});
		const loop = new AutonomousLoop({
			clock,
			timeZone: "UTC",
			store: state.store,
			timers,
			worker,
			sleep: scheduler,
			sleepScheduler: scheduler,
			baseBackoffMs: 100,
			maxBackoffMs: 1_000,
			onError: () => undefined,
		});
		loopRef = loop;
		await loop.start();
		timers.advance(0);
		await waitFor(() => worker.starts.length === 1, "single sleep-wake continuation");
		assert.equal(worker.starts[0]?.kind, "sleep-wake");
		assert.equal(worker.starts.length, 1);
		const persisted = await state.store.read();
		assert.equal(persisted.sleep?.status, "completed");
		assert.equal(persisted.sleep?.wakeNotifiedAtMs !== null, true);
		await loop.stop("test stop");
	} finally {
		await state.cleanup();
	}
});
