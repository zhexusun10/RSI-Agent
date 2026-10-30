import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startRuntimeHarness, waitFor } from "./helpers.ts";

async function readJson(path: string): Promise<Record<string, any>> {
	return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

test("explicit sleep gates provider requests, keeps heartbeats live, survives a Worker crash, and wakes once at the original deadline", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		await harness.setScript([
			{ toolCalls: [{ name: "sleep", id: "sleep-1", arguments: { duration: "4s" } }] },
			{ text: "awake after sleep" },
			{ text: "next autonomous turn", stopReason: "error", errorMessage: "stop test loop" },
		]);
		const sleepPath = harness.paths.sleepStateFile;
		const initialWorkerPid = await waitFor(() => harness.runtime.workerPid, "worker pid");
		const active = await waitFor(async () => {
			const state = await readJson(sleepPath).catch(() => null);
			return state?.sleep?.status === "active" ? state : undefined;
		}, "active sleep", 30_000);
		const deadlineMs = active.sleep.deadlineMs as number;
		assert.ok(deadlineMs > Date.now());
		await waitFor(async () => {
			const text = await readFile(`${harness.paths.logsDir}/watchdog.log`, "utf8").catch(() => "");
			return /"state":"sleeping"/.test(text);
		}, "sleeping heartbeat while the lease is suspended", 15_000);

		// Crash the Worker in the middle of the explicit sleep. The Supervisor must
		// restore LKG, restart the Worker, and keep the original sleep deadline.
		// The restarted Worker is a new Pi process/session, so its model script is
		// replaced before the persisted wake creates the next runtime turn.
		await harness.setScript([
			{ text: "awake after sleep" },
			{ text: "next autonomous turn", stopReason: "error", errorMessage: "stop test loop" },
		]);
		process.kill(initialWorkerPid!, "SIGKILL");
		const restartedPid = await waitFor(async () => {
			const pid = harness.runtime.workerPid;
			return pid !== null && pid !== initialWorkerPid ? pid : undefined;
		}, "Worker restart after crash", 40_000);
		assert.notEqual(restartedPid, initialWorkerPid);

		const completed = await waitFor(async () => {
			const state = await readJson(sleepPath).catch(() => null);
			return state?.sleep?.status === "completed" ? state : undefined;
		}, "sleep completion after restart", 30_000);
		assert.equal(completed.sleep.deadlineMs, deadlineMs);
		assert.ok(completed.sleep.wakeNotifiedAtMs >= deadlineMs);
		assert.ok(Date.now() - deadlineMs < 20_000, "wake should be prompt after the persisted deadline");

		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.some((capture) => JSON.stringify(capture).includes("awake after sleep"))
				? current
				: undefined;
		}, "post-sleep provider request", 30_000);
		const after = captures.find((capture) => JSON.stringify(capture).includes("awake after sleep"));
		assert.ok(after);
		assert.ok(after.atMs >= deadlineMs, "the next provider request must not occur before the sleep deadline");
		assert.match(after.system, /INTEGRATION-HUMAN-PROMPT-9C71/);
		assert.match(JSON.stringify(after), /检测到 Pi Worker 崩溃，已回滚到上一个已知安全快照。/);
		const logs = await readFile(`${harness.paths.logsDir}/runtime.log`, "utf8");
		assert.equal((logs.match(/"kind":"sleep\.woke"|"scope":"sleep\.woke"/g) ?? []).length <= 1, true);
	} catch (error) {
		console.error(`LOGS:\n${harness.logs.join("\n")}`);
		console.error(`CAPS:\n${JSON.stringify(await harness.captures().catch(() => []), null, 2)}`);
		console.error(`SLEEP:\n${await readFile(harness.paths.sleepStateFile, "utf8").catch(() => "")}`);
		console.error(`WATCHDOG:\n${await readFile(harness.paths.watchdogStateFile, "utf8").catch(() => "")}`);
		throw error;
	} finally {
		await harness.cleanup();
	}
});
