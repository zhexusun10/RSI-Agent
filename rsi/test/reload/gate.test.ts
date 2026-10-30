import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { ImmutableCandidateStore } from "../../src/reload/candidate-store.ts";
import { ReloadPreflight } from "../../src/reload/preflight-runner.ts";
import { ReloadCoordinator } from "../../src/reload/reload-coordinator.ts";
import { ReloadGate, guardExtensionCommandContext, guardReloadCommand } from "../../src/reload/reload-gate.ts";
import { ReloadStateStore } from "../../src/reload/state-store.ts";
import {
	FakeClock,
	FakePreflightLauncher,
	FakeSdkReload,
	cleanupRoot,
	makeTempRoot,
	uniqueIdFactory,
	writeFiles,
} from "./helpers.ts";

async function setup(): Promise<{
	root: string;
	gate: ReloadGate;
	coordinator: ReloadCoordinator;
	sdk: FakeSdkReload;
	source: string;
	clock: FakeClock;
	prepare: () => Promise<void>;
}> {
	const root = await makeTempRoot("gate");
	const source = join(root, "plugins", "demo");
	await writeFiles(source, {
		"package.json": JSON.stringify({ name: "gate-plugin", version: "1.0.0", type: "module" }),
		"index.ts": "export default function extension(): void {}\n",
	});
	const clock = new FakeClock();
	const stateDir = join(root, "state");
	const store = new ImmutableCandidateStore({ snapshotDir: join(stateDir, "snapshots"), forbiddenRoots: [stateDir] });
	const launcher = new FakePreflightLauncher();
	const preflight = new ReloadPreflight({ candidateStore: store, launcher, clock });
	const stateStore = new ReloadStateStore({ stateFile: join(stateDir, "plugins", "state.json"), clock });
	const sdk = new FakeSdkReload();
	const coordinator = new ReloadCoordinator({
		candidateStore: store,
		preflight,
		stateStore,
		sdkReload: sdk,
		clock,
		idFactory: uniqueIdFactory("gate-attempt"),
	});
	return {
		root,
		gate: new ReloadGate(coordinator, clock),
		coordinator,
		sdk,
		source,
		clock,
		prepare: async () => {
			await coordinator.prepareCandidate({
				sourceRoots: [{ id: "demo", path: source, discovery: "extension" }],
				now: clock.now(),
			});
		},
	};
}

test("control, command shim, and extension ctx reload all use the same external gate", async () => {
	const context = await setup();
	try {
		context.gate.registerSession("session-a", { generation: 1 });
		const controlFailure = await context.gate.requestFromControl("control");
		assert.equal(controlFailure.ok, false);
		assert.equal(context.sdk.requests.length, 0);

		const inactive = await context.gate.requestFromCommandShim("shim", "not-registered");
		assert.equal(inactive.ok, false);
		if (!inactive.ok) assert.equal(inactive.code, "SESSION_INACTIVE");

		let directReloadCalls = 0;
		const commandContext = {
			reload: async () => {
				directReloadCalls += 1;
			},
		};
		const guardedContext = guardExtensionCommandContext(commandContext, context.gate, {
			reason: "extension",
			sessionId: "session-a",
		});
		await assert.rejects(guardedContext.reload(), /No prepared candidate/i);
		assert.equal(directReloadCalls, 0);
		assert.equal(context.sdk.requests.length, 0);

		// Success through all three entry points, each with its own generation.
		await context.prepare();
		const control = await context.gate.requestFromControl("control success");
		assert.equal(control.ok, true);
		assert.equal(context.sdk.requests.length, 1);

		await context.prepare();
		const shim = await guardReloadCommand(context.gate, {
			reason: "shim success",
			sessionId: "session-a",
		})();
		assert.equal(shim.ok, true);
		assert.equal(context.sdk.requests.length, 2);

		await context.prepare();
		await guardedContext.reload();
		assert.equal(context.sdk.requests.length, 3);
		assert.equal(directReloadCalls, 0);
		assert.equal(context.gate.listSessions()[0]?.generation, 3);
	} finally {
		await cleanupRoot(context.root);
	}
});

test("duplicate in-flight reload requests are coalesced and never call the SDK twice", async () => {
	const context = await setup();
	try {
		context.gate.registerSession("session-a");
		await context.prepare();
		const first = context.gate.requestReload({
			reason: "duplicate",
			source: "control",
			dedupeKey: "same",
		});
		const second = context.gate.requestReload({
			reason: "duplicate",
			source: "control",
			dedupeKey: "same",
		});
		const [left, right] = await Promise.all([first, second]);
		assert.equal(left.ok, true);
		assert.equal(right.ok, true);
		assert.equal(context.sdk.requests.length, 1);
		assert.equal(left.ok && right.ok ? left.attemptId : "", left.ok && right.ok ? right.attemptId : "");
	} finally {
		await cleanupRoot(context.root);
	}
});
