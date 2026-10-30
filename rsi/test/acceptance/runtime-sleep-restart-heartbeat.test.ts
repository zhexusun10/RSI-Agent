import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startRuntimeHarness, waitFor } from "../integration/helpers.ts";

async function watchdogLog(harness: Awaited<ReturnType<typeof startRuntimeHarness>>): Promise<
	Array<{ readonly kind?: string; readonly atMs?: number; readonly detail?: { readonly pid?: number; readonly state?: string } }>
> {
	const text = await readFile(join(harness.paths.logsDir, "watchdog.log"), "utf8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as { readonly kind?: string; readonly atMs?: number; readonly detail?: { readonly pid?: number; readonly state?: string } }];
			} catch {
				return [];
			}
		});
}

/**
 * A crash while an explicit sleep is active restarts the Worker with the same
 * persisted deadline. The restarted Worker must resume the sleeping heartbeat
 * state, not advertise idle: the Watchdog suspends only the lease for a
 * sleeping Worker. Otherwise a busy/hung restarted sleep would be treated as a
 * heartbeat failure and trigger an unnecessary rollback.
 */
test("a Worker restarted during an explicit sleep reports sleeping heartbeats", { timeout: 60_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		await harness.setScript([
			{ toolCalls: [{ name: "sleep", id: "sleep-restart-heartbeat", arguments: { duration: "30s" } }] },
			{ text: "awake after restart" },
		]);
		const initialPid = await waitFor(() => harness.runtime.workerPid, "initial Worker pid", 20_000);
		await waitFor(async () => {
			const state = JSON.parse(await readFile(harness.paths.sleepStateFile, "utf8").catch(() => "{}")) as {
				sleep?: { status?: string };
			};
			return state.sleep?.status === "active" ? state : undefined;
		}, "active sleep", 20_000);

		process.kill(initialPid!, "SIGKILL");
		const restartedPid = await waitFor(async () => {
			const pid = harness.runtime.workerPid;
			return pid !== null && pid !== initialPid ? pid : undefined;
		}, "Worker restart during sleep", 40_000);

		const heartbeat = await waitFor(async () => {
			const lines = await watchdogLog(harness);
			const lastStart = lines
				.map((entry, index) => ({ entry, index }))
				.filter(({ entry }) => entry.kind === "worker.started" && entry.detail?.pid === restartedPid)
				.pop();
			if (lastStart === undefined) return undefined;
			const afterStart = lines.slice(lastStart.index);
			return afterStart.find((entry) => entry.kind === "heartbeat")?.detail?.state;
		}, "heartbeat after sleeping restart", 10_000);

		assert.equal(
			heartbeat,
			"sleeping",
			"the restarted Worker must report sleeping while the persisted explicit sleep is active",
		);
	} finally {
		await harness.cleanup();
	}
});
