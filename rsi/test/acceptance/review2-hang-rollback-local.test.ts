import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startRuntimeHarness, waitFor } from "../integration/helpers.ts";

test("an Agent-written hanging Pi extension cannot hang the Worker during or after reload", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const pid = await waitFor(() => harness.runtime.workerPid, "Worker pid");
		await writeFile(join(harness.paths.pluginSourceDir, "hang.ts"), `setTimeout(() => { while (true) {} }, 300);\nexport default function x(pi) {}\n`);
		const result = await harness.runtime.reloadService.requestSupervisorReload({ reason: "unplanned hang extension", source: "control" });
		assert.equal(result.ok, true, result.ok ? "" : result.error);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		assert.equal(harness.runtime.workerPid, pid);
		assert.equal((await harness.runtime.status()).extensionPaths?.some((path) => path.includes("hang.ts")), false);
	} finally {
		await harness.cleanup();
	}
});
