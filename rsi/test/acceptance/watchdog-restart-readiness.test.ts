import assert from "node:assert/strict";
import { test } from "node:test";
import { startRuntimeHarness, waitFor } from "../integration/helpers.ts";

test("Watchdog restart becomes ready and reaches a provider request without a queue deadlock", { timeout: 60_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		await harness.setScript([{ text: "post-restart turn" }]);
		const initialPid = await waitFor(() => harness.runtime.workerPid, "initial worker pid", 20_000);
		assert.ok(initialPid !== null);
		await harness.clearCapture();
		process.kill(initialPid, "SIGKILL");
		const restarted = await waitFor(async () => {
			const pid = harness.runtime.workerPid;
			return pid !== null && pid !== initialPid ? pid : undefined;
		}, "Watchdog restart pid", 40_000);
		assert.notEqual(restarted, initialPid);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.some((capture) => capture.messages.some((message) => message.text?.includes("post-restart turn"))) ? current : undefined;
		}, "provider request after Watchdog restart", 20_000);
		assert.ok(captures.length > 0);
	} finally {
		await harness.cleanup();
	}
});
