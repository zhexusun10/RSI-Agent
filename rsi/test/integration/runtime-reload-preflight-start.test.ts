import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startRuntimeHarness } from "./helpers.ts";

const RELOAD_PLUGIN = `export default function reloadStartPlugin(pi) {
	pi.registerFlag("reload-start-preflight", { type: "boolean", default: true });
}
`;

test("first baseline and a normal reload start through external preflight", { timeout: 120_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const baseline = await harness.runtime.coordinator.currentState();
		assert.ok(baseline.active, "the first baseline must be active after startup");
		assert.equal(baseline.active?.generation, 1);
		assert.equal(baseline.active?.phase, "baseline");

		const pluginPath = join(harness.paths.pluginSourceDir, "reload-start.ts");
		await writeFile(pluginPath, RELOAD_PLUGIN, "utf8");
		const result = await harness.runtime.reloadService.requestSupervisorReload({
			reason: "preflight startup regression",
			source: "control",
		});
		assert.equal(result.ok, true, result.ok ? "" : result.error);

		const status = await harness.runtime.status();
		assert.equal(status.generation, 2);
		assert.equal((status.extensionPaths ?? []).some((path) => path.includes("reload-start")), false);
		const state = await harness.runtime.coordinator.currentState();
		assert.equal(state.active?.generation, 2);
		assert.equal(state.pending, null);
	} catch (error) {
		console.error(`LOGS:\n${harness.logs.join("\n")}`);
		throw error;
	} finally {
		await harness.cleanup();
	}
});
