import { test } from "node:test";
import assert from "node:assert/strict";
import {
	assistantText,
	assistantToolCalls,
	createTestWorkspace,
	queueResponses,
	toolResultMessages,
} from "./helpers.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.map((block) => block.text ?? "")
		.filter((part) => part.length > 0)
		.join("\n");
}

test("an explicit sleep tool delays the next model request and heartbeat continues", async () => {
	const workspace = await createTestWorkspace({ memory: "SLEEP-MEMORY" });
	try {
		const queued = queueResponses(workspace, [
			assistantToolCalls([{ name: "sleep", arguments: { duration: "2s" }, id: "sleep-1" }]),
			assistantText("after sleep"),
		]);
		const startedAt = Date.now();
		await workspace.worker.run("sleep first");

		assert.equal(queued.captured.length, 2);
		assert.ok(queued.callTimes[1]! - queued.callTimes[0]! >= 1_900);
		assert.ok(queued.callTimes[1]! - startedAt >= 1_900);
		const result = toolResultMessages(queued.captured[1]!).find((entry) => entry.toolName === "sleep");
		assert.ok(result);
		assert.equal(result.isError, false);
		assert.match(textOf(result), /Slept until|deadline/);
		assert.match(textOf(result), /\(Current Time:/);
		assert.equal(workspace.sleepGate.requests.length, 1);
		assert.equal(workspace.worker.nestedToolResults.length, 0);
		assert.ok(workspace.heartbeat.reports.some((report) => report.state === "sleeping"));
		assert.ok(workspace.events.events.some((entry) => entry.event === "sleep.entered"));
		assert.ok(workspace.events.events.some((entry) => entry.event === "sleep.woke"));
	} finally {
		await workspace.cleanup();
	}
});

test("the request-boundary gate blocks a request for an externally active sleep", async () => {
	const workspace = await createTestWorkspace({ memory: "SLEEP-GATE" });
	try {
		const deadline = Date.now() + 350;
		workspace.sleepGate.setActive(deadline);
		const queued = queueResponses(workspace, [assistantText("allowed after sleep")]);
		await workspace.worker.run("wait for external sleep");
		assert.equal(queued.captured.length, 1);
		assert.ok(queued.callTimes[0]! >= deadline - 20);
	} finally {
		await workspace.cleanup();
	}
});

test("sleep rejects both forms and missing forms with decorated tool errors", async () => {
	const workspace = await createTestWorkspace({});
	try {
		const queued = queueResponses(workspace, [
			assistantToolCalls([
				{ name: "sleep", arguments: { duration: "1s", until: "2027/01/01 00:00:00" }, id: "sleep-both" },
				{ name: "sleep", arguments: {}, id: "sleep-none" },
				{ name: "sleep", arguments: { duration: "0s" }, id: "sleep-zero" },
			]),
			assistantText("done"),
		]);
		await workspace.worker.run("invalid sleeps");
		const results = toolResultMessages(queued.captured[1]!).filter((entry) => entry.toolName === "sleep");
		assert.equal(results.length, 3);
		for (const result of results) {
			assert.equal(result.isError, true);
			assert.match(textOf(result), /\(Current Time:/);
		}
		assert.equal(workspace.sleepGate.requests.length, 0);
	} finally {
		await workspace.cleanup();
	}
});

test("the removed control tool is unavailable and protected commands remain blocked", async () => {
	const workspace = await createTestWorkspace({});
	try {
		const queued = queueResponses(workspace, [
			assistantToolCalls([
				{ name: "pi_control", arguments: { command: "/quit" }, id: "control-quit" },
				{ name: "pi_control", arguments: { command: "model" }, id: "control-model" },
				{ name: "pi_control", arguments: { command: "shutdown" }, id: "control-shutdown" },
				{ name: "pi_control", arguments: { command: "status" }, id: "control-status" },
			]),
			assistantText("done"),
		]);
		await workspace.worker.run("control attempts");
		const results = toolResultMessages(queued.captured[1]!).filter((entry) => entry.toolName === "pi_control");
		const byId = new Map(
			results.map((result) => [(result as unknown as { toolCallId: string }).toolCallId, result]),
		);
		for (const id of ["control-quit", "control-model", "control-shutdown", "control-status"]) {
			const result = byId.get(id);
			assert.ok(result);
			assert.equal(result.isError, true);
			assert.match(textOf(result), /not found/i);
			assert.match(textOf(result), /\(Current Time:/);
		}

		await assert.rejects(workspace.worker.run("/quit"), /AGENT_COMMAND_FORBIDDEN|must not begin|forbidden/i);
		await assert.rejects(workspace.session.setModel(workspace.model), /forbidden|not available/i);
		assert.equal(workspace.worker.status().state, "idle");
	} finally {
		await workspace.cleanup();
	}
});
