import assert from "node:assert/strict";
import test from "node:test";
import {
	createGuardedReloadAction,
	createWorkerReloadCoordinator,
	ReloadCoordinator,
} from "../../src/control/reload.ts";
import { createPiCommandTool, PI_COMMAND_TOOL_NAME } from "../../src/control/pi-command.ts";
import { RsiError } from "../../src/shared/errors.ts";
import type { WorkerIpcClient } from "../../src/shared/ipc/port.ts";
import { FakeClock } from "../loop/fakes.ts";
import { deferred, makeReport, RecordingApply, RecordingPreflight } from "./helpers.ts";

const REQUEST = {
	requestId: "reload-request-1",
	reason: "test reload",
	source: "worker-shim" as const,
	generation: 1,
	sessionId: "session-1",
};

test("reload runs preflight before apply and passes the approved generation", async () => {
	const clock = new FakeClock();
	const preflight = new RecordingPreflight(makeReport({ generation: 2 }));
	const apply = new RecordingApply();
	const coordinator = new ReloadCoordinator({
		clock,
		preflight,
		apply,
		currentGeneration: () => 1,
	});
	const outcome = await coordinator.request({ ...REQUEST, candidateId: "candidate-1" });
	assert.equal(outcome.generation, 2);
	assert.equal(preflight.calls.length, 1);
	assert.equal(preflight.calls[0]?.candidateId, "candidate-1");
	assert.equal(apply.calls, 1);
	assert.equal(apply.plans[0]?.approvedGeneration, 2);
	assert.equal(apply.plans[0]?.report.digest, "sha256:abc");
});

test("preflight failure never calls apply and preserves the error stack", async () => {
	const preflight = new RecordingPreflight(
		makeReport({ ok: false, errors: ["static syntax error", "mock load failed"] }),
	);
	const apply = new RecordingApply();
	const coordinator = new ReloadCoordinator({
		clock: new FakeClock(),
		preflight,
		apply,
		currentGeneration: () => 1,
	});
	await assert.rejects(
		() => coordinator.request(REQUEST),
		(error: unknown) => {
			assert.ok(error instanceof RsiError);
			assert.equal(error.code, "PREFLIGHT_FAILED");
			const details = error.details as { stack?: string; errors?: string[] };
			assert.equal(typeof details.stack, "string");
			assert.deepEqual(details.errors, ["static syntax error", "mock load failed"]);
			return true;
		},
	);
	assert.equal(apply.calls, 0);
});

test("a generation change during preflight fails closed", async () => {
	let generation = 1;
	const preflight = new RecordingPreflight(makeReport({ generation: 2 }));
	preflight.beforeResolve = () => {
		generation = 2;
	};
	const apply = new RecordingApply();
	const coordinator = new ReloadCoordinator({
		clock: new FakeClock(),
		preflight,
		apply,
		currentGeneration: () => generation,
	});
	await assert.rejects(
		() => coordinator.request(REQUEST),
		(error: unknown) => (error as { code?: string }).code === "CANDIDATE_CHANGED",
	);
	assert.equal(apply.calls, 0);
});

test("concurrent reloads are deterministic: same request id joins, different id is rejected", async () => {
	const clock = new FakeClock();
	const preflight = new RecordingPreflight(makeReport({ generation: 2 }));
	const apply = new RecordingApply();
	const hold = deferred<void>();
	apply.beforeResolve = () => hold.promise;
	const coordinator = new ReloadCoordinator({
		clock,
		preflight,
		apply,
		currentGeneration: () => 1,
	});
	const first = coordinator.request(REQUEST);
	await assert.rejects(
		() =>
			coordinator.request({
				...REQUEST,
				requestId: "reload-request-2",
				reason: "second reload",
			}),
		(error: unknown) => (error as RsiError).retryable === true,
	);
	const duplicate = coordinator.request(REQUEST);
	hold.resolve();
	const [firstOutcome, duplicateOutcome] = await Promise.all([first, duplicate]);
	assert.equal(firstOutcome.generation, 2);
	assert.equal(duplicateOutcome.generation, 2);
	assert.equal(apply.calls, 1);
});

test("Worker reload adapter calls preflight, reload.started, raw reload, and reports failure", async () => {
	const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
	const report = makeReport({ generation: 2 });
	const ipc = {
		async request(method: string, payload: unknown) {
			calls.push({ method, payload });
			switch (method) {
				case "reload.preflight":
					return report;
				case "reload.started":
					return { attemptId: "attempt-1", requiredHealthTurns: 3 };
				case "reload.failed":
					return { recorded: true };
				default:
					throw new Error(`unexpected ${method}`);
			}
		},
		sendEvent() {},
		close() {},
		closed: Promise.resolve(),
	} as unknown as WorkerIpcClient;
	let rawReloads = 0;
	const coordinator = createWorkerReloadCoordinator({
		clock: new FakeClock(),
		ipc,
		reload: async () => {
			rawReloads += 1;
		},
		currentGeneration: () => 1,
	});
	const outcome = await coordinator.request(REQUEST);
	assert.equal(outcome.generation, 2);
	assert.equal(rawReloads, 1);
	assert.deepEqual(
		calls.map((entry) => entry.method),
		["reload.preflight", "reload.started"],
	);

	calls.length = 0;
	const failing = createWorkerReloadCoordinator({
		clock: new FakeClock(),
		ipc,
		reload: async () => {
			throw new Error("session reload exploded");
		},
		currentGeneration: () => 1,
	});
	await assert.rejects(
		() => failing.request({ ...REQUEST, requestId: "reload-request-fail" }),
		(error: unknown) => {
			assert.equal((error as RsiError).code, "RELOAD_FAILED");
			const details = (error as RsiError).details as { stack?: string };
			assert.match(details.stack ?? "", /session reload exploded/);
			return true;
		},
	);
	assert.deepEqual(
		calls.map((entry) => entry.method),
		["reload.preflight", "reload.started", "reload.failed"],
	);
});

test("the guarded reload action cannot run the raw reload without preflight approval", async () => {
	let rawReloads = 0;
	const preflight = new RecordingPreflight(makeReport({ generation: 2 }));
	const apply = new RecordingApply();
	const coordinator = new ReloadCoordinator({
		clock: new FakeClock(),
		preflight,
		apply,
		currentGeneration: () => 1,
	});
	const guarded = createGuardedReloadAction(coordinator, {
		reason: "extension ctx.reload",
		currentGeneration: () => 1,
		currentSessionId: () => "session-1",
	});
	await guarded();
	rawReloads += apply.calls;
	assert.equal(rawReloads, 1);

	const failingPreflight = new RecordingPreflight(makeReport({ ok: false, errors: ["bad"] }));
	const failingCoordinator = new ReloadCoordinator({
		clock: new FakeClock(),
		preflight: failingPreflight,
		apply,
		currentGeneration: () => 1,
	});
	const failingGuarded = createGuardedReloadAction(failingCoordinator, {
		currentGeneration: () => 1,
		currentSessionId: () => "session-1",
	});
	await assert.rejects(() => failingGuarded(), /preflight rejected/);
	assert.equal(apply.calls, 1);
});

test("the unused Pi command bridge rejects reload and forwards only MCP", async () => {
	const preflight = new RecordingPreflight(makeReport({ generation: 2 }));
	const apply = new RecordingApply();
	const coordinator = new ReloadCoordinator({
		clock: new FakeClock(),
		preflight,
		apply,
		currentGeneration: () => 1,
	});
	const forwarded: string[][] = [];
	const tool = createPiCommandTool({
		reload: coordinator,
		currentGeneration: () => 1,
		currentSessionId: () => "session-1",
		forward: async (argv) => {
			forwarded.push([...argv]);
			return { detail: `forwarded ${argv.join(" ")}`, exitCode: 0 };
		},
	});
	assert.equal(tool.name, PI_COMMAND_TOOL_NAME);
	const result = await tool.execute(
		"call-1",
		{ command: "/reload" },
		undefined,
		undefined,
		undefined as never,
	);
	assert.equal(preflight.calls.length, 0);
	assert.equal(apply.calls, 0);
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /forbidden/);

	const forwardedResult = await tool.execute(
		"call-2",
		{ command: "mcp", args: ["list"] },
		undefined,
		undefined,
		undefined as never,
	);
	assert.deepEqual(forwarded, [["mcp", "list"]]);
	assert.match(
		forwardedResult.content[0]?.type === "text" ? forwardedResult.content[0].text : "",
		/forwarded mcp list/,
	);

	const forbidden = await tool.execute(
		"call-3",
		{ command: "/quit" },
		undefined,
		undefined,
		undefined as never,
	);
	assert.equal(forbidden.isError, true);
	const text = forbidden.content[0]?.type === "text" ? forbidden.content[0].text : "";
	assert.match(text, /forbidden/);
	assert.ok(text.includes("\n"));
});
