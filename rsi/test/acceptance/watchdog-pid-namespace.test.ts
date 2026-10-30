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
 * bubblewrap runs a trivial PID-1 init and the Node Worker is PID 2 inside its
 * new PID namespace. The Worker reports that namespace PID in worker.ready and
 * heartbeat, while the Supervisor's launch handle owns the host bwrap PID. A
 * production Watchdog must correlate the host process exit with the launched
 * bwrap handle, not compare it to the namespace PID and discard the exit as
 * stale. This local regression models the two distinct IDs directly.
 */
test("Watchdog recovers on the host bwrap exit even when the Worker reports a namespace PID", { timeout: 30_000 }, async () => {
	const root = await makeTempRoot("watchdog-pid-namespace");
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
		const hostBwrapPid = 40_001;
		const namespaceWorkerPid = 2;
		// The Worker's ready event carries its PID-namespace id; the Supervisor
		// owns the host bwrap process id. Both are legitimate production IDs.
		await watchdog.recordWorkerStarted({
			pid: namespaceWorkerPid,
			startedAtMs: clock.now().getTime(),
			generation: 1,
		});
		await watchdog.recordHeartbeat(heartbeat(1, "idle", namespaceWorkerPid), clock.now());
		// Simulate the actual host bwrap process exiting unexpectedly.
		await watchdog.recordWorkerExit(1, null, clock.now(), {
			pid: hostBwrapPid,
			stderrTail: "worker crashed",
		});
		const state = await watchdog.status();
		assert.equal(
			recovery.restoreCalls.length,
			1,
			"the Watchdog must restore the LKG on the launched host process exit",
		);
		assert.notEqual(state.phase, "healthy", "a host Worker exit must not be discarded as stale");
	} finally {
		await watchdog.stop().catch(() => undefined);
		await cleanupRoot(root);
	}
});
