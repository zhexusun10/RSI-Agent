import assert from "node:assert/strict";
import { test } from "node:test";
import { startRuntimeHarness, waitFor } from "./helpers.ts";

test("pinned-only reload is promoted after three healthy turns and a later Worker crash restores it", { timeout: 120_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		await harness.setScript([{ text: "healthy turn" }]);
		const initialPid = await waitFor(() => harness.runtime.workerPid, "baseline Worker pid");
		assert.ok(initialPid !== null);
		const result = await harness.runtime.reloadService.requestSupervisorReload({ reason: "promote pinned-only generation", source: "control" });
		assert.equal(result.ok, true, result.ok ? "" : result.error);
		const promoted = await waitFor(async () => {
			const state = await harness.runtime.coordinator.currentState();
			return state.lkg?.generation === 2 ? state : undefined;
		}, "three healthy turns promote generation 2", 45_000);
		assert.equal(promoted.lkg?.healthyTurns, 3);
		await harness.runtime.loop.stop("pause before the next reload and crash");
		const next = await harness.runtime.reloadService.requestSupervisorReload({ reason: "crash after another reload", source: "control" });
		assert.equal(next.ok, true, next.ok ? "" : next.error);
		process.kill(initialPid, "SIGKILL");
		await waitFor(() => {
			const pid = harness.runtime.workerPid;
			return pid !== null && pid !== initialPid ? pid : undefined;
		}, "Watchdog replacement", 40_000);
		const restored = await waitFor(async () => {
			const state = await harness.runtime.coordinator.currentState();
			return state.active?.generation === 2 && state.lkg?.generation === 2 ? state : undefined;
		}, "promoted LKG restored", 40_000);
		assert.equal(restored.active?.digest, promoted.lkg?.digest);
		assert.equal(restored.lkg?.digest, promoted.lkg?.digest);
	} finally {
		await harness.cleanup();
	}
});
