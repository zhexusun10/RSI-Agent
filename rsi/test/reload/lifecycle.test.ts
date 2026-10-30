import assert from "node:assert/strict";
import test from "node:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ImmutableCandidateStore } from "../../src/reload/candidate-store.ts";
import { ReloadPreflight } from "../../src/reload/preflight-runner.ts";
import { ReloadCoordinator } from "../../src/reload/reload-coordinator.ts";
import { ReloadStateStore } from "../../src/reload/state-store.ts";
import type { HealthTurnObservation } from "../../src/shared/preflight.ts";
import type { ReloadCandidate } from "../../src/reload/types.ts";
import { initialReloadPersistentState } from "../../src/reload/types.ts";
import {
	FakeClock,
	FakeObserver,
	FakePreflightLauncher,
	FakeSdkReload,
	RecordingEvents,
	cleanupRoot,
	makeTempRoot,
	uniqueIdFactory,
	writeFiles,
} from "./helpers.ts";

interface Lifecycle {
	readonly root: string;
	readonly source: string;
	readonly store: ImmutableCandidateStore;
	readonly stateFile: string;
	readonly clock: FakeClock;
	readonly launcher: FakePreflightLauncher;
	readonly sdk: FakeSdkReload;
	readonly observer: FakeObserver;
	readonly events: RecordingEvents;
	readonly stateStore: ReloadStateStore;
	readonly coordinator: ReloadCoordinator;
}

async function makeLifecycle(label: string): Promise<Lifecycle> {
	const root = await makeTempRoot(`lifecycle-${label}`);
	const source = join(root, "workspace", ".pi", "extensions", "demo");
	await writeFiles(source, {
		"package.json": JSON.stringify({ name: "lifecycle-plugin", version: "1.0.0", type: "module" }),
		"index.ts": [
			'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
			"export default function extension(pi: ExtensionAPI): void {",
			"\tpi.registerFlag('lifecycle-plugin', { type: 'boolean', default: true });",
			"}",
			"",
		].join("\n"),
	});
	const stateDir = join(root, "state");
	const clock = new FakeClock();
	const store = new ImmutableCandidateStore({
		snapshotDir: join(stateDir, "snapshots"),
		forbiddenRoots: [stateDir],
	});
	const launcher = new FakePreflightLauncher();
	const preflight = new ReloadPreflight({ candidateStore: store, launcher, clock });
	const stateFile = join(stateDir, "plugins", "state.json");
	const stateStore = new ReloadStateStore({
		stateFile,
		clock,
		logPath: join(stateDir, "logs", "reload.log"),
	});
	const sdk = new FakeSdkReload();
	const observer = new FakeObserver();
	const events = new RecordingEvents();
	const coordinator = new ReloadCoordinator({
		candidateStore: store,
		preflight,
		stateStore,
		sdkReload: sdk,
		clock,
		observer,
		events,
		idFactory: uniqueIdFactory("attempt"),
	});
	return { root, source, store, stateFile, clock, launcher, sdk, observer, events, stateStore, coordinator };
}

function healthyTurn(
	attemptId: string,
	generation: number,
	turnIndex: number,
	stopReason = "stop",
): HealthTurnObservation {
	return {
		attemptId,
		generation,
		turnIndex,
		stopReason,
		aborted: false,
		assistantMessages: 1,
		atMs: 1,
	};
}

async function prepareCandidate(context: Lifecycle, generation?: number): Promise<ReloadCandidate> {
	return context.coordinator.prepareCandidate({
		sourceRoots: [{ id: "demo", path: context.source, discovery: "extension" }],
		now: context.clock.now(),
		...(generation === undefined ? {} : { generation }),
	});
}

test("preflight failure blocks the real reload and persists prepared/failed state", async () => {
	const context = await makeLifecycle("preflight-fail");
	try {
		context.launcher.behavior = { staticOk: false, staticErrors: ["syntax exploded"] };
		const candidate = await prepareCandidate(context);
		const result = await context.coordinator.requestReload({ reason: "test", source: "control" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "PREFLIGHT_FAILED");
		assert.equal(context.sdk.requests.length, 0);
		assert.equal(context.observer.begins.length, 0);
		const state = await context.coordinator.currentState();
		assert.equal(state.pending?.phase, "prepared");
		assert.equal(state.active, null);
		assert.equal(state.lkg, null);
		assert.match(state.lastFailure?.reason ?? "", /preflight/);
		assert.match((state.lastFailure?.diagnostics ?? []).join("\n"), /syntax exploded/);
		assert.equal(candidate.readOnly, true);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("Mock preflight success followed by real reload failure never activates or promotes", async () => {
	const context = await makeLifecycle("real-fail");
	try {
		context.sdk.failure = new Error("real sdk reload failed");
		await prepareCandidate(context);
		const result = await context.coordinator.requestReload({ reason: "test", source: "command-shim", sessionId: "s1" });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "RELOAD_FAILED");
			assert.match(result.error, /real sdk reload failed/);
		}
		assert.equal(context.sdk.requests.length, 1);
		assert.equal(context.observer.begins.length, 1);
		assert.equal(context.observer.failures.length, 1);
		const state = await context.coordinator.currentState();
		assert.equal(state.active, null);
		assert.equal(state.lkg, null);
		assert.equal(state.health, null);
		assert.equal(state.reloading, null);
		assert.match(state.lastFailure?.reason ?? "", /real sdk reload failed/);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("promotion waits for exactly three consecutive healthy settled turns and is duplicate-safe", async () => {
	const context = await makeLifecycle("promotion");
	try {
		const candidate = await prepareCandidate(context);
		const result = await context.coordinator.requestReload({ reason: "test", source: "control" });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(context.sdk.requests.length, 1);
		assert.equal(context.observer.completes.length, 1);

		let state = await context.coordinator.currentState();
		assert.equal(state.active?.phase, "probation");
		assert.equal(state.active?.digest, candidate.digest);
		assert.equal(state.health?.healthyTurns, 0);
		assert.equal(state.lkg, null);

		const first = await context.coordinator.recordHealthTurn(healthyTurn(result.attemptId, candidate.generation, 0));
		assert.equal(first.count, 1);
		assert.equal(first.promoted, false);
		const duplicateFirst = await context.coordinator.recordHealthTurn(
			healthyTurn(result.attemptId, candidate.generation, 0),
		);
		assert.equal(duplicateFirst.duplicate, true);
		assert.equal(duplicateFirst.count, 1);

		const second = await context.coordinator.recordHealthTurn(healthyTurn(result.attemptId, candidate.generation, 1));
		assert.equal(second.count, 2);
		state = await context.coordinator.currentState();
		assert.equal(state.lkg, null);

		const third = await context.coordinator.recordHealthTurn(healthyTurn(result.attemptId, candidate.generation, 2));
		assert.equal(third.count, 3);
		assert.equal(third.promoted, true);
		state = await context.coordinator.currentState();
		assert.notEqual(state.lkg, null);
		assert.equal(state.lkg?.digest, candidate.digest);
		assert.equal(state.lkg?.candidateId, candidate.candidateId);
		assert.equal(state.active?.phase, "promoted");
		const verifiedLkg = await context.store.verifyLkg(state.lkg!);
		assert.equal(verifiedLkg.digest, candidate.digest);
		assert.equal(
			await readFile(join(state.lkg!.path, ...(candidate.manifest.entries[0] ?? "").split("/")), "utf8"),
			await readFile(join(candidate.path, ...(candidate.manifest.entries[0] ?? "").split("/")), "utf8"),
		);
		assert.ok(context.events.names().includes("reload.promoted"));
	} finally {
		await cleanupRoot(context.root);
	}
});

test("unhealthy/provider-error turns reset probation without blaming the plugin or rolling back", async () => {
	const context = await makeLifecycle("unhealthy");
	try {
		const candidate = await prepareCandidate(context);
		const reload = await context.coordinator.requestReload({ reason: "test", source: "control" });
		assert.equal(reload.ok, true);
		if (!reload.ok) return;
		await context.coordinator.recordHealthTurn(healthyTurn(reload.attemptId, candidate.generation, 0));
		const errored = await context.coordinator.recordHealthTurn(
			healthyTurn(reload.attemptId, candidate.generation, 1, "error"),
		);
		assert.equal(errored.count, 0);
		assert.equal(errored.promoted, false);
		const abortedTurn = await context.coordinator.recordHealthTurn({
			...healthyTurn(reload.attemptId, candidate.generation, 2),
			aborted: true,
		});
		assert.equal(abortedTurn.count, 0);
		const after = await context.coordinator.recordHealthTurn(healthyTurn(reload.attemptId, candidate.generation, 3));
		assert.equal(after.count, 1);
		const state = await context.coordinator.currentState();
		assert.equal(state.lkg, null);
		assert.equal(state.active?.candidateId, candidate.candidateId);
		assert.equal(context.observer.resets.length, 0);
		assert.equal(context.events.names().includes("reload.rollback"), false);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("a validated state written before reload does not skip preflight after restart", async () => {
	const context = await makeLifecycle("restart-preflight");
	try {
		const candidate = await prepareCandidate(context);
		const outcome = await context.coordinator.validateCandidate(candidate);
		assert.equal(outcome.report.ok, true);
		const firstLaunchCount = context.launcher.launched.length;
		let state = await context.coordinator.currentState();
		assert.equal(state.pending?.phase, "validated");
		assert.equal(state.reloading, null);

		const restartedStateStore = new ReloadStateStore({
			stateFile: context.stateFile,
			clock: context.clock,
			logPath: join(context.root, "state", "logs", "reload.log"),
		});
		const restartedSdk = new FakeSdkReload();
		const restarted = new ReloadCoordinator({
			candidateStore: context.store,
			preflight: new ReloadPreflight({
				candidateStore: context.store,
				launcher: context.launcher,
				clock: context.clock,
			}),
			stateStore: restartedStateStore,
			sdkReload: restartedSdk,
			clock: context.clock,
			idFactory: uniqueIdFactory("restart-attempt"),
		});
		const result = await restarted.requestReload({ reason: "after restart", source: "control" });
		assert.equal(result.ok, true);
		assert.equal(restartedSdk.requests.length, 1);
		assert.ok(context.launcher.launched.length > firstLaunchCount);
		state = await restarted.currentState();
		assert.equal(state.active?.candidateId, candidate.candidateId);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("valid initial baseline creates a real LKG; failed baseline does not fake one", async () => {
	const valid = await makeLifecycle("baseline-valid");
	try {
		const candidate = await prepareCandidate(valid);
		const initialized = await valid.coordinator.initializeBaseline(candidate);
		assert.equal(initialized.ok, true, initialized.error);
		assert.notEqual(initialized.lkg, null);
		const state = await valid.coordinator.currentState();
		assert.equal(state.active?.phase, "baseline");
		assert.equal(state.lkg?.digest, candidate.digest);
		assert.equal(state.lkg?.healthyTurns, 0);
		await valid.store.verifyLkg(state.lkg!);
	} finally {
		await cleanupRoot(valid.root);
	}

	const invalid = await makeLifecycle("baseline-invalid");
	try {
		invalid.launcher.behavior = { staticOk: false, staticErrors: ["bad baseline"] };
		const candidate = await prepareCandidate(invalid);
		const initialized = await invalid.coordinator.initializeBaseline(candidate);
		assert.equal(initialized.ok, false);
		assert.equal(initialized.lkg, undefined);
		assert.equal(invalid.sdk.requests.length, 0);
		const state = await invalid.coordinator.currentState();
		assert.equal(state.active, null);
		assert.equal(state.lkg, null);
	} finally {
		await cleanupRoot(invalid.root);
	}
});

test("candidate snapshot is reverified at promotion time", async () => {
	const context = await makeLifecycle("tamper-promotion");
	try {
		const candidate = await prepareCandidate(context);
		const reload = await context.coordinator.requestReload({ reason: "test", source: "control" });
		assert.equal(reload.ok, true);
		await context.coordinator.recordHealthTurn(healthyTurn(reload.attemptId, candidate.generation, 0));
		await context.coordinator.recordHealthTurn(healthyTurn(reload.attemptId, candidate.generation, 1));
		const entry = join(candidate.path, ...(candidate.manifest.entries[0] ?? "").split("/"));
		await chmod(entry, 0o644);
		await writeFile(entry, "tampered active candidate\n");
		await assert.rejects(
			context.coordinator.recordHealthTurn(healthyTurn(reload.attemptId, candidate.generation, 2)),
			/CANDIDATE_CHANGED|digest|writable/i,
		);
		const state = await context.coordinator.currentState();
		assert.equal(state.lkg, null);
		assert.equal(state.active?.phase, "probation");
	} finally {
		await cleanupRoot(context.root);
	}
});

test("interrupted/write-corrupt journal falls back without executing or promoting", async () => {
	const context = await makeLifecycle("journal");
	try {
		const initial = initialReloadPersistentState(context.clock.now());
		await context.stateStore.save({ ...initial, updatedAtMs: context.clock.now().getTime() });
		context.clock.advance(10);
		const reloading = {
			...initial,
			reloading: {
				attemptId: "attempt-x",
				candidateId: "gen-000001-abcdefabcdef",
				generation: 1,
				digest: ("sha256:" + "b".repeat(64)) as `sha256:${string}`,
				path: join(context.root, "state", "snapshots", "candidates", "gen-000001-abcdefabcdef"),
				startedAtMs: context.clock.now().getTime(),
				deadlineMs: context.clock.now().getTime() + 30_000,
			},
			updatedAtMs: context.clock.now().getTime(),
		};
		await context.stateStore.save(reloading);
		const loaded = await context.stateStore.load();
		assert.equal(loaded.state.reloading, null);
		assert.equal(loaded.interruptedReload?.attemptId, "attempt-x");
		assert.equal(loaded.state.lkg, null);
		assert.equal(loaded.state.active, null);
		assert.match(loaded.state.lastFailure?.reason ?? "", /interrupted/i);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("crash/probation reset discards partial health and cannot promote old counts", async () => {
	const context = await makeLifecycle("probation-reset");
	try {
		const candidate = await prepareCandidate(context);
		const reload = await context.coordinator.requestReload({ reason: "test", source: "control" });
		assert.equal(reload.ok, true);
		if (!reload.ok) return;
		await context.coordinator.recordHealthTurn(healthyTurn(reload.attemptId, candidate.generation, 0));
		await context.coordinator.recordHealthTurn(healthyTurn(reload.attemptId, candidate.generation, 1));
		await context.coordinator.resetProbation("worker crash");
		let state = await context.coordinator.currentState();
		assert.equal(state.health, null);
		assert.equal(state.lkg, null);
		const afterReset = await context.coordinator.recordHealthTurn(
			healthyTurn(reload.attemptId, candidate.generation, 2),
		);
		assert.equal(afterReset.duplicate, true);
		assert.equal(afterReset.count, 0);
		assert.equal(afterReset.promoted, false);
		state = await context.coordinator.currentState();
		assert.equal(state.lkg, null);
	} finally {
		await cleanupRoot(context.root);
	}
});
