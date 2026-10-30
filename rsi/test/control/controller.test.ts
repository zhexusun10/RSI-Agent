import assert from "node:assert/strict";
import test from "node:test";
import { CommandController } from "../../src/control/command-controller.ts";
import { ReloadCoordinator } from "../../src/control/reload.ts";
import type { SleepGatePort } from "../../src/shared/ports.ts";
import { FakeClock } from "../loop/fakes.ts";
import { makeReport, RecordingApply, RecordingPreflight } from "./helpers.ts";

function makeSleep(): { readonly port: SleepGatePort; readonly cancels: Array<{ reason: string; at: number }> } {
	const cancels: Array<{ reason: string; at: number }> = [];
	const port = {
		async request() {
			throw new Error("not used");
		},
		async status() {
			return null;
		},
		async cancel(reason: string, now: Date) {
			cancels.push({ reason, at: now.getTime() });
			return true;
		},
	} as unknown as SleepGatePort;
	return { port, cancels };
}

test("trusted command controller dispatches only finite shared commands", async () => {
	const clock = new FakeClock();
	const preflight = new RecordingPreflight(makeReport({ generation: 2 }));
	const apply = new RecordingApply();
	const reload = new ReloadCoordinator({
		clock,
		preflight,
		apply,
		currentGeneration: () => 1,
	});
	const sleep = makeSleep();
	const stopped: Array<{ reason: string; at: number }> = [];
	const controller = new CommandController({
		clock,
		reload,
		sleep: sleep.port,
		stopRuntime: (reason, at) => {
			stopped.push({ reason, at });
		},
	});
	const reloadResult = await controller.dispatch(
		{ kind: "reload", reason: "operator reload", candidateId: "candidate-1" },
		{ source: "supervisor", atMs: clock.timeMs },
	);
	assert.equal(reloadResult.ok, true);
	assert.equal(apply.calls, 1);
	const shutdownResult = await controller.dispatch(
		{ kind: "shutdown", reason: "operator shutdown" },
		{ source: "supervisor", atMs: clock.timeMs },
	);
	assert.equal(shutdownResult.ok, true);
	assert.deepEqual(stopped, [{ reason: "operator shutdown", at: clock.timeMs }]);
	const cancelResult = await controller.dispatch(
		{ kind: "cancelSleep", reason: "operator cancel" },
		{ source: "supervisor", atMs: clock.timeMs },
	);
	assert.equal(cancelResult.ok, true);
	assert.deepEqual(sleep.cancels, [{ reason: "operator cancel", at: clock.timeMs }]);
});

test("command controller rejects non-Supervisor sources and malformed commands", async () => {
	const clock = new FakeClock();
	const preflight = new RecordingPreflight(makeReport());
	const apply = new RecordingApply();
	const reload = new ReloadCoordinator({
		clock,
		preflight,
		apply,
		currentGeneration: () => 1,
	});
	const sleep = makeSleep();
	const controller = new CommandController({
		clock,
		reload,
		sleep: sleep.port,
		stopRuntime: () => undefined,
	});
	const forged = await controller.dispatch(
		{ kind: "shutdown", reason: "forged" },
		{ source: "worker-shim" as never, atMs: clock.timeMs },
	);
	assert.equal(forged.ok, false);
	const malformed = await controller.dispatch(
		{ kind: "reload", reason: "reload", path: "/etc/passwd" } as never,
		{ source: "supervisor", atMs: clock.timeMs },
	);
	assert.equal(malformed.ok, false);
	assert.match(malformed.ok ? "" : malformed.error, /unknown fields/);
	assert.equal(preflight.calls.length, 0);
	assert.equal(apply.calls, 0);
});

test("reload failure is returned as an error string with stack, not only logged", async () => {
	const clock = new FakeClock();
	const preflight = new RecordingPreflight(makeReport({ ok: false, errors: ["syntax"] }));
	const apply = new RecordingApply();
	const reload = new ReloadCoordinator({
		clock,
		preflight,
		apply,
		currentGeneration: () => 1,
	});
	const sleep = makeSleep();
	const controller = new CommandController({
		clock,
		reload,
		sleep: sleep.port,
		stopRuntime: () => undefined,
	});
	const result = await controller.dispatch(
		{ kind: "reload", reason: "operator reload" },
		{ source: "supervisor", atMs: clock.timeMs },
	);
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.error, /preflight rejected/);
	assert.match(result.ok ? "" : result.error, /PREFLIGHT|syntax|stack/);
	assert.equal(apply.calls, 0);
});
