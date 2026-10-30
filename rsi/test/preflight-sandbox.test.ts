import assert from "node:assert/strict";
import test from "node:test";
import {
	advanceHealthTurns,
	assertCandidateDigest,
	classifyHealthyTurn,
	createSandboxPolicy,
	deriveRuntimePaths,
	initialPluginGenerationState,
	isHeartbeatExpired,
	REQUIRED_PLUGIN_PINS,
	REQUIRED_PLUGIN_SPECS,
	resolveInstalledPluginExtension,
} from "../src/shared/index.ts";
import { join } from "node:path";

test("health requires three consecutive healthy settled runs", () => {
	assert.deepEqual(advanceHealthTurns(0, true), { consecutiveHealthyTurns: 1, required: 3, readyToPromote: false });
	assert.deepEqual(advanceHealthTurns(1, true), { consecutiveHealthyTurns: 2, required: 3, readyToPromote: false });
	assert.deepEqual(advanceHealthTurns(2, true), { consecutiveHealthyTurns: 3, required: 3, readyToPromote: true });
	assert.deepEqual(advanceHealthTurns(3, true), { consecutiveHealthyTurns: 3, required: 3, readyToPromote: true });
	assert.deepEqual(advanceHealthTurns(2, false), { consecutiveHealthyTurns: 0, required: 3, readyToPromote: false });
});

test("healthy turn classification rejects errors, aborts, and empty runs", () => {
	const base = { attemptId: "a", generation: 1, turnIndex: 0, atMs: 1 };
	assert.equal(classifyHealthyTurn({ ...base, aborted: false, assistantMessages: 1, stopReason: "stop" }), true);
	assert.equal(classifyHealthyTurn({ ...base, aborted: false, assistantMessages: 1, stopReason: "toolUse" }), true);
	assert.equal(classifyHealthyTurn({ ...base, aborted: false, assistantMessages: 1, stopReason: "error" }), false);
	assert.equal(classifyHealthyTurn({ ...base, aborted: true, assistantMessages: 1, stopReason: "stop" }), false);
	assert.equal(classifyHealthyTurn({ ...base, aborted: false, assistantMessages: 0, stopReason: "stop" }), false);
});

test("candidate digest mismatch is rejected before promotion", () => {
	assert.throws(
		() => assertCandidateDigest({ candidateId: "c1", digest: "sha256:a" }, "sha256:b"),
		(error: unknown) => (error as { code?: string }).code === "CANDIDATE_CHANGED",
	);
	assert.doesNotThrow(() => assertCandidateDigest({ candidateId: "c1", digest: "sha256:a" }, "sha256:a"));
	const state = initialPluginGenerationState(new Date(1));
	assert.equal(state.lkg, null);
	assert.equal(state.health, null);
});

test("heartbeat lease expiry is deterministic", () => {
	const state = {
		version: 1 as const,
		workerPid: 1,
		generation: 1,
		lastHeartbeatAtMs: 1,
		leaseExpiresAtMs: 10,
		missedHeartbeats: 0,
		phase: "healthy" as const,
		updatedAtMs: 1,
	};
	assert.equal(isHeartbeatExpired(state, new Date(10)), false);
	assert.equal(isHeartbeatExpired(state, new Date(11)), true);
});

test("pinned plugin descriptors resolve to installed extension files", () => {
	assert.deepEqual(
		REQUIRED_PLUGIN_PINS.map((pin) => `${pin.packageName}@${pin.version}`),
		["pi-continuity@0.3.1", "pi-better-web-search@0.1.7"],
	);
	assert.deepEqual(REQUIRED_PLUGIN_SPECS, ["npm:pi-continuity@0.3.1", "npm:pi-better-web-search@0.1.7"]);
	for (const pin of REQUIRED_PLUGIN_PINS) {
		assert.match(resolveInstalledPluginExtension(pin), /extensions[\\/]index\.ts$/);
	}
});

test("sandbox policy marks protected paths read-only and keeps stdout out of IPC", () => {
	const root = join(process.cwd(), "test-fixture");
	const paths = deriveRuntimePaths({
		workspaceDir: join(root, "workspace"),
		dataDir: join(root, "data"),
		stateDir: join(root, "state"),
		piSourceDir: join(root, "pi"),
		rsiSourceDir: join(root, "rsi"),
		systemPromptFile: join(root, "prompt.txt"),
	});
	const verified = {
		protectedPaths: [
			{ kind: "pi-source" as const, configured: paths.piSourceDir, canonical: paths.piSourceDir },
			{ kind: "rsi-source" as const, configured: paths.rsiSourceDir, canonical: paths.rsiSourceDir },
			{ kind: "manual-prompt" as const, configured: paths.systemPromptFile, canonical: paths.systemPromptFile },
			{ kind: "managed-markdowns" as const, configured: paths.markdownsDir, canonical: paths.markdownsDir },
		],
		canonicalStateDir: paths.stateDir,
	};
	const policy = createSandboxPolicy(paths, "bwrap", verified);
	assert.equal(policy.network, "unrestricted");
	assert.deepEqual(policy.capabilities, []);
	assert.equal(policy.protected.length, 4);
	assert.equal(policy.protected.every((entry) => entry.mode === "ro"), true);
	assert.equal(policy.hidden.includes(paths.stateDir), true);
	assert.equal(policy.ipc.stdoutIsProtocol, false);
	assert.equal(policy.ipc.workerSocketPath, "/run/rsi/worker.sock");
});
