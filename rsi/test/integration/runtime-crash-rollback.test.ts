import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startRuntimeHarness, waitFor } from "./helpers.ts";

test("a Worker crash after reload restores the LKG and preserves Memory and task files", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const taskPath = join(harness.paths.workspaceDir, "task-state.txt");
		await harness.setScript([
			{ toolCalls: [
				{ name: "write", id: "write-memory", arguments: { path: harness.paths.memoryFile, content: "ROLLBACK-SURVIVES-MEMORY" } },
				{ name: "write", id: "write-task", arguments: { path: taskPath, content: "ROLLBACK-SURVIVES-TASK" } },
			] },
			{ text: "Saved task data." },
		]);
		await waitFor(async () => {
			const captures = await harness.captures();
			return captures.some((capture) => capture.messages.some((message) => message.toolCallId === "write-task")) ? captures : undefined;
		}, "task writes");
		await harness.runtime.loop.stop("pause before reload and crash");
		const initialPid = await waitFor(() => harness.runtime.workerPid, "initial Worker pid");
		assert.ok(initialPid !== null);
		const result = await harness.runtime.reloadService.requestSupervisorReload({ reason: "crash recovery regression", source: "control" });
		assert.equal(result.ok, true, result.ok ? "" : result.error);
		process.kill(initialPid, "SIGKILL");
		const restarted = await waitFor(() => {
			const pid = harness.runtime.workerPid;
			return pid !== null && pid !== initialPid ? pid : undefined;
		}, "Watchdog replacement", 40_000);
		assert.notEqual(restarted, initialPid);
		const state = await waitFor(async () => {
			const current = await harness.runtime.coordinator.currentState();
			return current.active?.generation === 1 && current.lkg?.generation === 1 ? current : undefined;
		}, "baseline LKG restoration", 40_000);
		assert.equal(state.lkg?.generation, 1);
		assert.match((await harness.runtime.knowledgeService.readCurrentMemory()).content, /ROLLBACK-SURVIVES-MEMORY/);
		assert.equal(await readFile(taskPath, "utf8"), "ROLLBACK-SURVIVES-TASK");
	} finally {
		await harness.cleanup();
	}
});
