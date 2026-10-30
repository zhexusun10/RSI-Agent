import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	assistantText,
	createTestEnvironment,
	createTestWorkspace,
	queueResponses,
} from "./helpers.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";

test("native retries settle once and do not invite an external duplicate prompt", async () => {
	const workspace = await createTestWorkspace({
		settingsOverrides: {
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, maxAgentDelayMs: 5 },
		},
	});
	try {
		const queued = queueResponses(workspace, [
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			assistantText("recovered"),
		]);
		await workspace.worker.run("one external prompt");

		assert.equal(queued.captured.length, 2);
		assert.equal(workspace.health.observations.length, 1);
		assert.equal(workspace.health.observations[0]?.stopReason, "stop");
		assert.equal(workspace.health.observations[0]?.aborted, false);
		assert.ok((workspace.health.observations[0]?.assistantMessages ?? 0) >= 1);
		const settled = workspace.telemetry.events.filter((event) => event.type === "agent_settled");
		assert.equal(settled.length, 1);
		assert.equal(workspace.telemetry.events.some((event) => event.type === "agent_end"), true);
		assert.ok(workspace.heartbeat.reports.some((report) => report.state === "busy"));
	} finally {
		await workspace.cleanup();
	}
});

test("continuity continuations settle once and report a single health turn", async () => {
	const workspace = await createTestWorkspace({});
	try {
		queueResponses(workspace, [
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			assistantText("continued to completion"),
		]);
		await workspace.worker.run("one external prompt");
		assert.equal(workspace.faux.state.callCount, 2);
		assert.equal(workspace.health.observations.length, 1);
		assert.equal(workspace.health.observations[0]?.stopReason, "stop");
		assert.equal(
			workspace.telemetry.events.filter((event) => event.type === "agent_settled").length,
			1,
		);
		assert.ok(
			workspace.telemetry.events.filter((event) => event.type === "agent_end").length >= 1,
		);
		assert.equal(workspace.worker.status().state, "idle");
	} finally {
		await workspace.cleanup();
	}
});

test("AgentSession persistence and a replacement session are rebound", async () => {
	const environment = await createTestEnvironment({});
	try {
		const sessionManager = SessionManager.create(
			environment.cwd,
			join(environment.root, "sessions"),
		);
		await environment.startWorker({ sessionManager });
		queueResponses(environment, [assistantText("persisted answer")]);
		await environment.worker!.run("persist this turn");
		const file = sessionManager.getSessionFile();
		assert.ok(file);
		const reopened = SessionManager.open(file);
		const messages = reopened.buildSessionContext().messages;
		assert.equal(messages.some((message) => message.role === "user"), true);
		assert.equal(messages.some((message) => message.role === "assistant"), true);

		const oldSession = environment.worker!.session;
		const replacementManager = SessionManager.inMemory(environment.cwd);
		const replacement = await createAgentSession({
			cwd: environment.cwd,
			agentDir: environment.agentDir,
			model: environment.model,
			modelRuntime: environment.modelRuntime,
			settingsManager: environment.settingsManager,
			sessionManager: replacementManager,
			resourceLoader: environment.worker!.resourceLoader as never,
		});
		await environment.worker!.replaceSession(replacement.session);
		assert.equal(environment.worker!.session, replacement.session);
		assert.throws(
			() => replacement.session.setThinkingLevel("high"),
			/forbidden|not available/i,
		);
		const healthBefore = environment.health.observations.length;
		queueResponses(environment, [assistantText("replacement answer")]);
		await environment.worker!.run("replacement prompt");
		assert.equal(environment.health.observations.length, healthBefore + 1);
		// The replacement session's event subscription is live.
		assert.equal(environment.worker!.status().state, "idle");
		oldSession.dispose();
		replacement.session.dispose();
	} finally {
		await environment.cleanup();
	}
});
