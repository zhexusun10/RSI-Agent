import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { RecoveryNoticeStore } from "../../src/watchdog/notifications.ts";
import { Watchdog } from "../../src/watchdog/watchdog.ts";
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

/**
 * Independent review2 regression: the Watchdog contract must keep the host
 * launch PID (the bwrap process in production) and the Worker-reported
 * PID-namespace value separate. A namespace pid heartbeat must not extend the
 * lease, a namespace pid exit must not be mistaken for the host Worker exit,
 * and only the host PID exit may trigger LKG recovery.
 */
test("review2: Watchdog uses explicit hostPid for lease/exit and treats namespace PID exits as stale", { timeout: 30_000 }, async () => {
	const root = await makeTempRoot("review2-watchdog-hostpid");
	const clock = new FakeClock();
	const processTree = new FakeProcessTree();
	const recovery = new FakeRecovery(clock);
	recovery.lkg = fakeLkg(1);
	const notices = new RecoveryNoticeStore({ path: join(root, "state", "notices.json"), clock });
	const watchdog = new Watchdog({
		stateFile: join(root, "state", "watchdog.json"),
		clock,
		recovery,
		notifications: notices,
		events: new RecordingEvents(),
		processTree,
		timers: new FakeTimers(clock),
		heartbeatTimeoutMs: 30_000,
		tickIntervalMs: 1_000_000,
		restartBaseMs: 1_000,
		restartMaxMs: 8_000,
		maxRestarts: 3,
		stableResetMs: 120_000,
	});
	try {
		await watchdog.startAsync();
		const hostBwrapPid = 41_001;
		const namespaceWorkerPid = 2;
		await watchdog.recordWorkerStarted({
			pid: namespaceWorkerPid,
			hostPid: hostBwrapPid,
			startedAtMs: clock.now().getTime(),
			generation: 1,
		});
		let state = await watchdog.status();
		assert.equal(state.workerPid, hostBwrapPid, "Watchdog must monitor the host launch PID");
		assert.equal(state.reportedWorkerPid, namespaceWorkerPid, "namespace PID is diagnostic only");
		assert.equal(state.workerPidExplicit, true);

		// A heartbeat carrying the namespace PID (for example an old/direct
		// caller) must not replace or extend the host identity.
		const leaseBefore = state.leaseExpiresAtMs;
		await watchdog.recordHeartbeat(heartbeat(1, "idle", namespaceWorkerPid), clock.now());
		state = await watchdog.status();
		assert.equal(state.workerPid, hostBwrapPid);
		assert.equal(state.lastSequence, 0, "namespace PID heartbeat must not be accepted");
		assert.equal(state.leaseExpiresAtMs, leaseBefore);

		// The legitimate Supervisor-normalized heartbeat uses the host PID.
		await watchdog.recordHeartbeat(heartbeat(2, "idle", hostBwrapPid), clock.now());
		state = await watchdog.status();
		assert.equal(state.workerPid, hostBwrapPid);
		assert.equal(state.lastSequence, 2);

		// A namespace PID exit cannot be allowed to masquerade as the host exit.
		await watchdog.recordWorkerExit(1, null, clock.now(), { pid: namespaceWorkerPid });
		state = await watchdog.status();
		assert.equal(recovery.restoreCalls.length, 0, "namespace PID exit must not trigger rollback");
		assert.equal(state.workerPid, hostBwrapPid);
		assert.notEqual(state.phase, "unrecoverable");

		// The actual host launch process exit is authoritative and must recover.
		await watchdog.recordWorkerExit(1, null, clock.now(), { pid: hostBwrapPid });
		state = await watchdog.status();
		assert.equal(recovery.restoreCalls.length, 1, "host PID exit must trigger exactly one LKG restore");
		assert.notEqual(state.phase, "healthy");
	} finally {
		await watchdog.stop().catch(() => undefined);
		await cleanupRoot(root);
	}
});
