import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { RecoveryNoticeStore } from "../../src/watchdog/notifications.ts";
import { Watchdog } from "../../src/watchdog/watchdog.ts";
import { initialWatchdogState } from "../../src/watchdog/types.ts";
import {
	FakeClock,
	FakeProcessTree,
	FakeRecovery,
	FakeTimers,
	RecordingEvents,
	cleanupRoot,
	fakeLkg,
	heartbeat,
	makeTempRoot,
} from "../reload/helpers.ts";

interface WatchdogHarness {
	readonly root: string;
	readonly clock: FakeClock;
	readonly timers: FakeTimers;
	readonly processTree: FakeProcessTree;
	readonly recovery: FakeRecovery;
	readonly notices: RecoveryNoticeStore;
	readonly events: RecordingEvents;
	readonly stateFile: string;
	readonly noticeFile: string;
	readonly watchdog: Watchdog;
}

async function makeHarness(label: string, options: { readonly maxRestarts?: number } = {}): Promise<WatchdogHarness> {
	const root = await makeTempRoot(`watchdog-${label}`);
	const clock = new FakeClock();
	const timers = new FakeTimers(clock);
	const processTree = new FakeProcessTree();
	const recovery = new FakeRecovery(clock);
	recovery.lkg = fakeLkg(3);
	const stateFile = join(root, "state", "watchdog.json");
	const noticeFile = join(root, "state", "control", "recovery-notices.json");
	const notices = new RecoveryNoticeStore({ path: noticeFile, clock });
	const events = new RecordingEvents();
	const watchdog = new Watchdog({
		stateFile,
		clock,
		recovery,
		notifications: notices,
		events,
		processTree,
		timers,
		heartbeatTimeoutMs: 30_000,
		busyLeaseMultiplier: 2,
		tickIntervalMs: 1_000_000,
		restartBaseMs: 1_000,
		restartMaxMs: 8_000,
		maxRestarts: options.maxRestarts ?? 3,
		stableResetMs: 120_000,
		missedHeartbeatLimit: 1,
		workerStderrPath: join(root, "state", "logs", "worker.stderr.log"),
		logPath: join(root, "state", "logs", "watchdog.log"),
	});
	return { root, clock, timers, processTree, recovery, notices, events, stateFile, noticeFile, watchdog };
}

test("heartbeat loss kills the process tree, restores LKG, and restarts with backoff", async () => {
	const context = await makeHarness("heartbeat");
	try {
		context.watchdog.start();
		await context.watchdog.ready();
		await context.watchdog.recordWorkerStarted({ pid: 1234, startedAtMs: context.clock.now().getTime(), generation: 3 });
		await context.watchdog.recordHeartbeat(heartbeat(1, "idle"), context.clock.now());
		let state = await context.watchdog.status();
		assert.equal(state.phase, "healthy");
		assert.equal(state.leaseExpiresAtMs, context.clock.now().getTime() + 30_000);

		context.clock.advance(30_001);
		await context.watchdog.tick(context.clock.now());
		state = await context.watchdog.status();
		assert.equal(context.processTree.killed.some((entry) => entry.pid === 1234), true);
		assert.equal(context.recovery.restoreCalls.length, 1);
		assert.equal(context.recovery.rollbackCalls.length, 1);
		assert.equal(state.phase, "rollback");
		assert.equal(state.recovery?.attempts, 1);
		assert.equal(context.events.names().includes("reload.rollback"), true);
		assert.equal(context.events.names().includes("watchdog.suspect"), true);
		assert.ok((await context.notices.pending()).length === 1);

		context.clock.advance(1_000);
		await context.watchdog.tick(context.clock.now());
		state = await context.watchdog.status();
		assert.equal(context.recovery.startCalls.length, 1);
		assert.equal(state.phase, "starting");
		assert.equal(state.workerPid, context.recovery.startCalls[0] === undefined ? null : 50_000);
		assert.equal(state.recovery, null);

		const pid = state.workerPid;
		assert.notEqual(pid, null);
		await context.watchdog.recordHeartbeat(heartbeat(1, "idle", pid ?? 0, 3), context.clock.now());
		state = await context.watchdog.status();
		assert.equal(state.phase, "healthy");
		assert.equal((await context.notices.pending()).length, 1);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("explicit sleep and long busy network/tool waits do not cause false event-loop hang rollback", async () => {
	const context = await makeHarness("sleep-busy");
	try {
		context.watchdog.start();
		await context.watchdog.ready();
		await context.watchdog.recordWorkerStarted({ pid: 2222, startedAtMs: context.clock.now().getTime(), generation: 3 });
		await context.watchdog.recordHeartbeat(heartbeat(1, "sleeping", 2222), context.clock.now());
		let state = await context.watchdog.status();
		assert.equal(state.sleepSuspended, true);
		assert.equal(state.leaseExpiresAtMs, null);
		context.clock.advance(10 * 60_000);
		await context.watchdog.tick(context.clock.now());
		assert.equal(context.processTree.killed.length, 0);
		assert.equal(context.recovery.restoreCalls.length, 0);

		await context.watchdog.recordHeartbeat(heartbeat(2, "busy", 2222), context.clock.now());
		state = await context.watchdog.status();
		assert.equal(state.sleepSuspended, false);
		assert.equal(state.leaseExpiresAtMs, context.clock.now().getTime() + 60_000);
		context.clock.advance(45_000);
		await context.watchdog.tick(context.clock.now());
		assert.equal(context.processTree.killed.length, 0);
		// A continued async wait keeps heartbeats flowing and the lease alive.
		await context.watchdog.recordHeartbeat(heartbeat(3, "busy", 2222), context.clock.now());
		context.clock.advance(45_000);
		await context.watchdog.tick(context.clock.now());
		assert.equal(context.processTree.killed.length, 0);
		assert.equal(context.recovery.restoreCalls.length, 0);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("reload deadline kills a stuck reload and starts rollback, not a silent hang", async () => {
	const context = await makeHarness("reload-deadline");
	try {
		context.watchdog.start();
		await context.watchdog.ready();
		await context.watchdog.recordWorkerStarted({ pid: 3333, startedAtMs: context.clock.now().getTime(), generation: 4 });
		context.clock.advance(1_000);
		await context.watchdog.beginReload({
			attemptId: "reload-stuck",
			candidateId: "gen-000004-abcdefabcdef",
			generation: 4,
			digest: "sha256:" + "d".repeat(64),
			deadlineMs: context.clock.now().getTime() + 5_000,
		});
		context.clock.advance(5_001);
		await context.watchdog.tick(context.clock.now());
		const state = await context.watchdog.status();
		assert.equal(context.recovery.timeoutCalls.length, 1);
		assert.equal(context.processTree.killed.some((entry) => entry.pid === 3333), true);
		assert.equal(context.recovery.restoreCalls.length, 1);
		assert.equal(state.phase, "rollback");
		assert.match(state.lastIncident?.reason ?? "", /reload deadline/i);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("operator SIGTERM is a stop, not a crash with infinite restart", async () => {
	const context = await makeHarness("operator");
	try {
		context.watchdog.start();
		await context.watchdog.ready();
		await context.watchdog.recordWorkerStarted({ pid: 4444, startedAtMs: context.clock.now().getTime(), generation: 3 });
		await context.watchdog.recordWorkerExit(143, "SIGTERM", context.clock.now(), { pid: 4444, stderrTail: "operator" });
		const state = await context.watchdog.status();
		assert.equal(state.phase, "stopped");
		assert.match(state.operatorStopReason ?? "", /SIGTERM/);
		assert.equal(context.recovery.restoreCalls.length, 0);
		assert.equal(context.recovery.startCalls.length, 0);
		assert.equal((await context.notices.pending()).length, 0);
		context.clock.advance(60_000);
		await context.watchdog.tick(context.clock.now());
		assert.equal(context.recovery.startCalls.length, 0);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("no LKG yields a diagnosable unrecoverable state with no fake rollback", async () => {
	const context = await makeHarness("no-lkg");
	try {
		context.recovery.lkg = null;
		context.watchdog.start();
		await context.watchdog.ready();
		await context.watchdog.recordWorkerStarted({ pid: 5555, startedAtMs: context.clock.now().getTime(), generation: 3 });
		await context.watchdog.recordWorkerExit(1, null, context.clock.now(), { pid: 5555, stderrTail: "crash without lkg" });
		const state = await context.watchdog.status();
		assert.equal(state.phase, "unrecoverable");
		assert.equal(state.recovery?.mode, "unrecoverable");
		assert.equal(context.recovery.restoreCalls.length, 0);
		assert.equal(context.recovery.startCalls.length, 0);
		assert.equal(context.recovery.unrecoverableCalls.length, 1);
		const pending = await context.notices.pending();
		assert.equal(pending.length, 1);
		assert.equal(pending[0]?.kind, "crash-no-lkg");
		context.clock.advance(60_000);
		await context.watchdog.tick(context.clock.now());
		assert.equal(context.recovery.startCalls.length, 0);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("restart failures use exponential backoff and stop at a bounded diagnostic state", async () => {
	const context = await makeHarness("backoff", { maxRestarts: 3 });
	try {
		context.recovery.startError = new Error("cannot start");
		context.watchdog.start();
		await context.watchdog.ready();
		await context.watchdog.recordWorkerStarted({ pid: 6666, startedAtMs: context.clock.now().getTime(), generation: 3 });
		await context.watchdog.recordWorkerExit(2, null, context.clock.now(), { pid: 6666, stderrTail: "boom" });
		let state = await context.watchdog.status();
		assert.equal(state.recovery?.attempts, 1);
		assert.equal(state.recovery?.nextAttemptAtMs, context.clock.now().getTime() + 1_000);

		context.clock.advance(1_000);
		await context.watchdog.tick(context.clock.now());
		state = await context.watchdog.status();
		assert.equal(context.recovery.startCalls.length, 1);
		assert.equal(state.recovery?.attempts, 2);
		assert.equal(state.recovery?.nextAttemptAtMs, context.clock.now().getTime() + 2_000);

		context.clock.advance(1_000);
		await context.watchdog.tick(context.clock.now());
		assert.equal(context.recovery.startCalls.length, 1);
		context.clock.advance(1_000);
		await context.watchdog.tick(context.clock.now());
		state = await context.watchdog.status();
		assert.equal(context.recovery.startCalls.length, 2);
		assert.equal(state.recovery?.attempts, 3);
		assert.equal(state.recovery?.nextAttemptAtMs, context.clock.now().getTime() + 4_000);

		context.clock.advance(4_000);
		await context.watchdog.tick(context.clock.now());
		state = await context.watchdog.status();
		assert.equal(context.recovery.startCalls.length, 3);
		assert.equal(state.phase, "unrecoverable");
		assert.equal(state.recovery?.mode, "unrecoverable");
		context.clock.advance(120_000);
		await context.watchdog.tick(context.clock.now());
		assert.equal(context.recovery.startCalls.length, 3);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("recovery notice is first-turn, durable across restart, and cleared only after acknowledge", async () => {
	const context = await makeHarness("notice-once");
	try {
		context.watchdog.start();
		await context.watchdog.ready();
		await context.watchdog.recordWorkerStarted({ pid: 7777, startedAtMs: context.clock.now().getTime(), generation: 3 });
		await context.watchdog.recordWorkerExit(1, null, context.clock.now(), { pid: 7777, stderrTail: "plugin stack line" });
		let pending = await context.notices.pending();
		assert.equal(pending.length, 1);
		const incident = (await context.watchdog.status()).lastIncident;
		assert.notEqual(incident, null);

		const text = await context.notices.textForFirstTurn();
		assert.match(text ?? "", /检测到 Pi Worker 崩溃，已回滚/);
		assert.match(text ?? "", /plugin stack line/);
		assert.equal((await context.notices.pending()).length, 1, "read must not clear before delivery ack");

		const restartedNotices = new RecoveryNoticeStore({ path: context.noticeFile, clock: context.clock });
		assert.equal((await restartedNotices.pending()).length, 1, "restart must not lose pending notice");
		const pendingNotice = (await restartedNotices.pending())[0];
		assert.notEqual(pendingNotice, undefined);
		assert.equal(await restartedNotices.acknowledge(pendingNotice!.notificationId), true);
		assert.equal(await restartedNotices.nextForFirstTurn().then((result) => result.notice), null);
		assert.equal(await restartedNotices.acknowledge(pendingNotice!.notificationId), false);
		const duplicate = await restartedNotices.enqueueCrash({
			incident: incident!,
			lkg: context.recovery.lkg,
			kind: "crash-rollback",
		});
		assert.equal(duplicate.duplicate, true);
		assert.equal((await restartedNotices.pending()).length, 0);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("crash during a delayed runtime turn creates a second incident and bounded stderr log", async () => {
	const context = await makeHarness("delayed-crash");
	try {
		context.watchdog.start();
		await context.watchdog.ready();
		await context.watchdog.recordWorkerStarted({ pid: 8888, startedAtMs: context.clock.now().getTime(), generation: 3 });
		await context.watchdog.recordHeartbeat(heartbeat(1, "idle", 8888), context.clock.now());
		context.clock.advance(1_000);
		await context.watchdog.tick(context.clock.now());
		await context.watchdog.recordWorkerExit(1, null, context.clock.now(), { pid: 8888, stderrTail: "late boom" });
		let state = await context.watchdog.status();
		assert.equal(state.phase, "rollback");
		assert.equal(context.recovery.restoreCalls.length, 1);
		context.clock.advance(1_000);
		await context.watchdog.tick(context.clock.now());
		state = await context.watchdog.status();
		const restartedPid = state.workerPid;
		assert.notEqual(restartedPid, null);
		await context.watchdog.recordHeartbeat(heartbeat(1, "idle", restartedPid ?? 0), context.clock.now());
		context.clock.advance(5_000);
		await context.watchdog.recordWorkerExit(1, null, context.clock.now(), {
			pid: restartedPid ?? 0,
			stderrTail: "x".repeat(100_000),
		});
		state = await context.watchdog.status();
		assert.equal(context.recovery.restoreCalls.length, 3);
		assert.equal(state.incidents.length, 2);
		assert.ok((state.lastIncident?.stderrTail.length ?? 0) <= 8_192);
		const pending = await context.notices.pending();
		assert.ok(pending.length >= 1);
		for (const notice of pending) assert.ok(notice.log.length <= 8_192);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("watchdog restart resumes a pending recovery without duplicating notices or attempts", async () => {
	const context = await makeHarness("restart-interrupt");
	try {
		context.watchdog.start();
		await context.watchdog.ready();
		await context.watchdog.recordWorkerStarted({ pid: 9999, startedAtMs: context.clock.now().getTime(), generation: 3 });
		await context.watchdog.recordWorkerExit(1, null, context.clock.now(), { pid: 9999, stderrTail: "interrupted recovery" });
		let state = await context.watchdog.status();
		assert.equal(state.phase, "rollback");
		assert.equal((await context.notices.pending()).length, 1);

		const interruptedRestoreCount = context.recovery.recoverInterruptedRestoreCalled;
		const restartedTimers = new FakeTimers(context.clock);
		const restartedProcess = new FakeProcessTree();
		const restartedWatchdog = new Watchdog({
			stateFile: context.stateFile,
			clock: context.clock,
			recovery: context.recovery,
			notifications: new RecoveryNoticeStore({ path: context.noticeFile, clock: context.clock }),
			events: context.events,
			processTree: restartedProcess,
			timers: restartedTimers,
			heartbeatTimeoutMs: 30_000,
			restartBaseMs: 1_000,
			restartMaxMs: 8_000,
			maxRestarts: 3,
			tickIntervalMs: 1_000_000,
			workerStderrPath: join(context.root, "state", "logs", "worker.stderr.log"),
			logPath: join(context.root, "state", "logs", "watchdog.log"),
		});
		restartedWatchdog.start();
		await restartedWatchdog.ready();
		state = await restartedWatchdog.status();
		assert.equal(context.recovery.recoverInterruptedRestoreCalled, interruptedRestoreCount + 1);
		assert.equal((await context.notices.pending()).length, 1);
		context.clock.advance(1_000);
		await restartedWatchdog.tick(context.clock.now());
		state = await restartedWatchdog.status();
		assert.equal(context.recovery.startCalls.length, 1);
		assert.equal(state.phase, "starting");
	} finally {
		await cleanupRoot(context.root);
	}
});

test("stale worker exit and expected reload stop do not create crash incidents", async () => {
	const context = await makeHarness("stale-exit");
	try {
		context.watchdog.start();
		await context.watchdog.ready();
		await context.watchdog.recordWorkerStarted({ pid: 10_001, startedAtMs: context.clock.now().getTime(), generation: 3 });
		await context.watchdog.markExpectedStop("reload swap", "reload");
		await context.watchdog.recordWorkerExit(0, null, context.clock.now(), { pid: 10_001 });
		let state = await context.watchdog.status();
		assert.equal(state.phase, "starting");
		assert.equal(context.recovery.restoreCalls.length, 0);

		await context.watchdog.recordWorkerStarted({ pid: 10_002, startedAtMs: context.clock.now().getTime(), generation: 4 });
		await context.watchdog.recordWorkerExit(1, null, context.clock.now(), { pid: 10_001, stderrTail: "stale" });
		state = await context.watchdog.status();
		assert.equal(context.recovery.restoreCalls.length, 0);
		assert.equal(state.workerPid, 10_002);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("empty watchdog state is explicit and does not fake a baseline", async () => {
	const context = await makeHarness("empty");
	try {
		await context.watchdog.startAsync();
		const state = await context.watchdog.status();
		assert.equal(state.phase, "idle");
		assert.equal(state.workerPid, null);
		assert.equal(state.recovery, null);
		assert.equal(state.lastIncident, null);
		assert.deepEqual(initialWatchdogState(context.clock.now()).incidents, []);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("duplicate heartbeat sequence does not extend the lease", async () => {
	const context = await makeHarness("duplicate-heartbeat");
	try {
		context.watchdog.start();
		await context.watchdog.ready();
		await context.watchdog.recordWorkerStarted({ pid: 11_111, startedAtMs: context.clock.now().getTime(), generation: 3 });
		await context.watchdog.recordHeartbeat(heartbeat(1, "idle", 11_111), context.clock.now());
		const initial = await context.watchdog.status();
		context.clock.advance(20_000);
		await context.watchdog.recordHeartbeat(heartbeat(1, "idle", 11_111), context.clock.now());
		let state = await context.watchdog.status();
		assert.equal(state.leaseExpiresAtMs, initial.leaseExpiresAtMs);
		context.clock.advance(10_001);
		await context.watchdog.tick(context.clock.now());
		state = await context.watchdog.status();
		assert.equal(context.processTree.killed.some((entry) => entry.pid === 11_111), true);
		assert.equal(state.phase, "rollback");
	} finally {
		await cleanupRoot(context.root);
	}
});

test("failed LKG restore never sends a false rollback-complete notice", async () => {
	const context = await makeHarness("restore-failed", { maxRestarts: 1 });
	try {
		context.recovery.restoreError = new Error("disk restore failed");
		context.watchdog.start();
		await context.watchdog.ready();
		await context.watchdog.recordWorkerStarted({ pid: 12_222, startedAtMs: context.clock.now().getTime(), generation: 3 });
		await context.watchdog.recordWorkerExit(1, null, context.clock.now(), { pid: 12_222, stderrTail: "crash" });
		let state = await context.watchdog.status();
		assert.equal(state.phase, "recovering");
		assert.match(state.recovery?.lastError ?? "", /disk restore failed/);
		assert.equal((await context.notices.pending()).length, 0);
		context.clock.advance(1_000);
		await context.watchdog.tick(context.clock.now());
		state = await context.watchdog.status();
		assert.equal(state.phase, "unrecoverable");
		const pending = await context.notices.pending();
		assert.equal(pending.length, 1);
		assert.equal(pending[0]?.kind, "rollback-failed");
		const text = await context.notices.textForFirstTurn();
		assert.match(text ?? "", /未声称已完成回滚/);
		assert.equal(context.recovery.startCalls.length, 0);
	} finally {
		await cleanupRoot(context.root);
	}
});
