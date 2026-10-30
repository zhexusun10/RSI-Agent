import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

/**
 * An operator cancellation must be reflected in the sleep tool result. The
 * Worker must not claim it slept until the original deadline when the external
 * Supervisor cancelled the active sleep.
 */
test("operator cancelSleep stops an active sleep and reports cancellation instead of a false success", { timeout: 60_000 }, async () => {
	const harness = await startRuntimeHarness();
	const startedAt = Date.now();
	try {
		await harness.setScript([
			{ toolCalls: [{ name: "sleep", id: "sleep-cancel", arguments: { duration: "1h" } }] },
			{ text: "post-cancel continuation", stopReason: "error", errorMessage: "stop audit loop" },
		]);
		await waitFor(
			async () => (harness.runtime.loop.status().state === "sleeping" ? true : undefined),
			"Supervisor sleep state",
			30_000,
		);
		const cancel = await operatorControl(
			["cancelSleep", "--reason", "acceptance audit cancellation"],
			harness.runtime.operatorEndpoint,
		);
		assert.equal(cancel.code, 0, cancel.stderr);
		assert.match(cancel.stdout, /Active explicit sleep cancelled/);

		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.length >= 2 ? current : undefined;
		}, "provider request after cancellation", 30_000);
		const sleepResult = captures
			.flatMap((capture) => capture.messages)
			.find((message) => message.role === "toolResult" && message.toolName === "sleep");
		assert.ok(sleepResult, "sleep tool result must reach the model");
		assert.equal(
			sleepResult.isError,
			true,
			"a cancelled sleep must be an error result, not a successful sleep",
		);
		assert.match(sleepResult.text ?? "", /cancel(?:led|lation)|已取消/iu);
		assert.ok(
			Date.now() - startedAt < 45_000,
			"the cancelled one-hour sleep must not wait for the original deadline",
		);
	} finally {
		await harness.cleanup();
	}
});
