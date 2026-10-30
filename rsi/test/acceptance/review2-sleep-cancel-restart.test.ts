import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { RSI_ROOT, startRuntimeHarness, waitFor } from "../integration/helpers.ts";

function operatorControl(
	args: string[],
	socket: string,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [join(RSI_ROOT, "scripts", "container-control.mjs"), ...args], {
			cwd: RSI_ROOT,
			env: {
				...process.env,
				RSI_CONTROL_SOCKET: socket,
				RSI_CONTROL_TOKEN: "integration-token",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
		child.on("exit", (code) => resolve({ code, stdout, stderr }));
	});
}

async function lastHeartbeatState(harness: Awaited<ReturnType<typeof startRuntimeHarness>>): Promise<string | undefined> {
	const text = await readFile(join(harness.paths.logsDir, "watchdog.log"), "utf8").catch(() => "");
	const lines = text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as { kind?: string; detail?: { state?: string } }];
			} catch {
				return [];
			}
		});
	return lines.filter((entry) => entry.kind === "heartbeat").at(-1)?.detail?.state;
}

/**
 * Independent review regression for a restarted Worker that is currently in an
 * explicit sleep: an operator cancellation must clear the sleeping heartbeat and
 * release the Watchdog sleep suspension, not leave the restarted process stuck
 * advertising "sleeping" because its in-memory sleep tool call was lost.
 */
test("review2: operator cancel after a sleep-restart clears sleeping heartbeat and Watchdog suspension", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		await harness.setScript([
			{ toolCalls: [{ name: "sleep", id: "review2-sleep", arguments: { duration: "1h" } }] },
			{ text: "review2 post-cancel turn", stopReason: "error", errorMessage: "stop review2 loop" },
		]);
		const initialPid = await waitFor(() => harness.runtime.workerPid, "initial Worker pid", 20_000);
		await waitFor(
			async () => (harness.runtime.loop.status().state === "sleeping" ? true : undefined),
			"Supervisor sleeping state",
			20_000,
		);
		process.kill(initialPid!, "SIGKILL");
		const restartedPid = await waitFor(async () => {
			const pid = harness.runtime.workerPid;
			return pid !== null && pid !== initialPid ? pid : undefined;
		}, "Worker restart during sleep", 40_000);
		assert.notEqual(restartedPid, initialPid);
		await waitFor(
			async () => ((await lastHeartbeatState(harness)) === "sleeping" ? true : undefined),
			"sleeping heartbeat after restart",
			20_000,
		);

		const cancel = await operatorControl(
			["cancelSleep", "--reason", "review2 restart cancellation"],
			harness.runtime.operatorEndpoint,
		);
		assert.equal(cancel.code, 0, cancel.stderr);
		assert.match(cancel.stdout, /Active explicit sleep cancelled/);
		const cleared = await waitFor(async () => {
			const status = await harness.runtime.status().catch(() => null);
			const watchdog = await harness.runtime.watchdog.status();
			const heartbeat = await lastHeartbeatState(harness);
			return status?.state === "idle" && watchdog.sleepSuspended === false && heartbeat === "idle"
				? { status, watchdog, heartbeat }
				: undefined;
		}, "sleeping heartbeat and Watchdog suspension cleared after cancellation", 20_000);
		assert.equal(cleared.status.state, "idle");
		assert.equal(cleared.watchdog.sleepSuspended, false);
		assert.equal(cleared.heartbeat, "idle");
	} finally {
		await harness.cleanup();
	}
});
