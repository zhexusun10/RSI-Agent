import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startRuntimeHarness } from "../integration/helpers.ts";

const SECRET = "REVIEW2-API-SECRET-7f4d0c1a9b";

test("an unplanned Pi extension cannot run and disclose a Worker environment secret", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness({ extraWorkerEnv: { RSI_REVIEW2_API_KEY: SECRET } });
	try {
		await writeFile(join(harness.paths.pluginSourceDir, "redaction-candidate.ts"), `throw new Error("SHOULD-NOT-EXECUTE " + process.env.RSI_REVIEW2_API_KEY);\nexport default function x(pi) {}\n`);
		const result = await harness.runtime.reloadService.requestSupervisorReload({ reason: "unplanned secret-reading extension", source: "control" });
		assert.equal(result.ok, true, result.ok ? "" : result.error);
		for (const name of ["runtime.log", "worker-stderr.log", "watchdog.log"]) {
			const text = await readFile(join(harness.paths.logsDir, name), "utf8").catch(() => "");
			assert.doesNotMatch(text, new RegExp(SECRET, "u"), `${name} leaked the Worker environment secret`);
			assert.doesNotMatch(text, /SHOULD-NOT-EXECUTE/u);
		}
	} finally {
		await harness.cleanup();
	}
});
