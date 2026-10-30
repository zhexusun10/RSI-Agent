import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RSI_ROOT, startRuntimeHarness, waitFor } from "./helpers.ts";

async function control(args: string[], socket: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolvePromise) => {
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
		child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

test("the trusted operator CLI reloads a prepared candidate, cancels no sleep correctly, and shuts down over the private socket", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		await writeFile(join(harness.paths.pluginSourceDir, "operator-plugin.ts"), "export default function operatorPlugin(pi) {}\n");
		const reload = await control(["reload", "--reason", "operator integration reload"], harness.runtime.operatorEndpoint);
		assert.equal(reload.code, 0, reload.stderr);
		assert.match(reload.stdout, /passed preflight/);
		await waitFor(async () => {
			const status = await harness.runtime.status();
			return status.generation === 2 ? status : undefined;
		}, "operator reload generation", 40_000);

		const cancel = await control(["cancelSleep", "--reason", "nothing active"], harness.runtime.operatorEndpoint);
		assert.equal(cancel.code, 0, cancel.stderr);
		assert.match(cancel.stdout, /No active explicit sleep/);

		const workerPid = harness.runtime.workerPid;
		assert.ok(workerPid);
		const shutdown = await control(["shutdown", "--reason", "operator integration shutdown"], harness.runtime.operatorEndpoint);
		assert.equal(shutdown.code, 0, shutdown.stderr);
		assert.match(shutdown.stdout, /Shutdown accepted/);
		await waitFor(async () => {
			try {
				await harness.runtime.status();
				return undefined;
			} catch {
				return true;
			}
		}, "runtime stopped after operator shutdown", 20_000);
		await waitFor(() => {
			try {
				process.kill(workerPid!, 0);
				return undefined;
			} catch {
				return true;
			}
		}, "Worker process tree cleanup", 10_000);
	} finally {
		await harness.cleanup();
	}
});
