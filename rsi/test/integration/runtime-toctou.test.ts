import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startRuntimeHarness } from "./helpers.ts";

test("Agent-writable Pi extension sources are excluded from reload snapshots", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		await writeFile(join(harness.paths.pluginSourceDir, "unplanned.ts"), "export default function x(pi) {}\n");
		const candidate = await harness.runtime.reloadService.prepareCandidate();
		assert.deepEqual(candidate.manifest.sources, []);
		assert.deepEqual(candidate.manifest.entries, []);
		await writeFile(join(harness.paths.pluginSourceDir, "late.ts"), "while (true) {}\n");
		const report = await harness.runtime.reloadService.validate(candidate);
		assert.equal(report.ok, true);
		const loaded = await harness.runtime.reloadService.requestSupervisorReload({ reason: "verify source exclusion", candidateId: candidate.candidateId, source: "control" });
		assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error);
		const status = await harness.runtime.status();
		assert.equal((status.extensionPaths ?? []).some((path) => /unplanned|late/u.test(path)), false);
	} finally {
		await harness.cleanup();
	}
});
