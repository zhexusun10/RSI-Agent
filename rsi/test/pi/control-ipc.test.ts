import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { IpcRequestContext, WorkerIpcServer } from "../../src/shared/ipc/port.ts";
import { sha256Text } from "../../src/shared/hash.ts";
import { bindWorkerControlIpc } from "../../src/pi/control-ipc.ts";
import {
	assistantText,
	assistantToolCalls,
	createTestEnvironment,
	queueResponses,
	toolResultMessages,
} from "./helpers.ts";

function context(): IpcRequestContext {
	return { requestId: "test-request", receivedAtMs: Date.now(), signal: new AbortController().signal };
}

const FORBIDDEN_EXTENSION = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function forbiddenApiFixture(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "try_forbidden_apis",
		label: "try_forbidden_apis",
		description: "Try API equivalents of forbidden commands.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const results: string[] = [];
			try { pi.setThinkingLevel("high"); results.push("thinking:unexpected-success"); }
			catch (error) { results.push("thinking:" + (error instanceof Error ? error.message : String(error))); }
			try {
				const model = ctx.model;
				if (!model) results.push("model:missing");
				else { await pi.setModel(model); results.push("model:unexpected-success"); }
			} catch (error) { results.push("model:" + (error instanceof Error ? error.message : String(error))); }
			try { ctx.shutdown(); results.push("shutdown:unexpected-success"); }
			catch (error) { results.push("shutdown:" + (error instanceof Error ? error.message : String(error))); }
			return { content: [{ type: "text", text: results.join("\\n") }], details: {} };
		},
	});
}
`;

test("trusted IPC control methods are bound and reload still goes through preflight", async () => {
	const environment = await createTestEnvironment({});
	try {
		await environment.startWorker();
		const worker = environment.worker!;
		const handlers = new Map<string, (payload: never, ctx: IpcRequestContext) => unknown>();
		const server: WorkerIpcServer = {
			handle(method, handler) {
				handlers.set(method, handler as never);
				return () => handlers.delete(method);
			},
			onEvent() {
				return () => {};
			},
			async close() {},
		};
		const unbind = bindWorkerControlIpc(worker, server);

		const pong = await handlers.get("worker.ping")!({ nonce: "abc" } as never, context());
		assert.equal((pong as { nonce: string }).nonce, "abc");

		const status = await handlers.get("worker.status")!({} as never, context());
		assert.equal((status as { state: string }).state, "idle");

		environment.sleepGate.setActive(Date.now() + 60_000);
		const cancel = await handlers.get("control.cancelSleep")!({ reason: "test" } as never, context());
		assert.deepEqual(cancel, { cancelled: true });

		const started = await handlers.get("control.reload")!(
			{
				preflightId: "p1",
				candidate: {
					candidateId: "candidate-ipc",
					generation: 2,
					path: join(environment.root, "candidate"),
					digest: sha256Text("candidate-ipc"),
					packages: [],
					createdAtMs: Date.now(),
					readOnly: true,
				},
			} as never,
			context(),
		);
		assert.equal((started as { attemptId: string }).attemptId, "attempt-1");
		assert.equal(environment.reload.preflights.length, 1);

		const shutdown = await handlers.get("control.shutdown")!({ reason: "test" } as never, context());
		assert.deepEqual(shutdown, { accepted: true });
		unbind();
		assert.equal(handlers.has("worker.ping"), false);
	} finally {
		await environment.cleanup();
	}
});

test("extension API equivalents of forbidden commands are blocked", async () => {
	const environment = await createTestEnvironment({});
	try {
		const extensionPath = await environment.writeExtension("forbidden-api.ts", FORBIDDEN_EXTENSION);
		await environment.startWorker({ approvedExtensionPaths: [extensionPath] });
		const modelBefore = environment.worker!.session.model;
		const thinkingBefore = environment.worker!.session.thinkingLevel;
		const queued = queueResponses(environment, [
			assistantToolCalls([{ name: "try_forbidden_apis", arguments: {}, id: "forbidden-api-1" }]),
			assistantText("blocked"),
		]);
		await environment.worker!.run("try forbidden extension APIs");
		const result = toolResultMessages(queued.captured[1]!).find(
			(entry) => entry.toolName === "try_forbidden_apis",
		);
		assert.ok(result);
		const text = result.content.map((block) => block.text ?? "").join("\n");
		assert.match(text, /thinking:.*not available/);
		assert.match(text, /model:.*not available/);
		assert.match(text, /shutdown:.*not available/);
		assert.equal(environment.worker!.session.model, modelBefore);
		assert.equal(environment.worker!.session.thinkingLevel, thinkingBefore);
	} finally {
		await environment.cleanup();
	}
});

test("the unplanned pi_control tool is not registered or callable", async () => {
	const environment = await createTestEnvironment({});
	try {
		await environment.startWorker();
		assert.equal(environment.worker!.session.getAllTools().some((tool) => tool.name === "pi_control"), false);
		assert.deepEqual(
			[...environment.worker!.session.getActiveToolNames()].filter((name) => name !== "web_search").sort(),
			["bash", "edit", "read", "sleep", "write"],
		);
		const queued = queueResponses(environment, [
			assistantToolCalls([{ name: "pi_control", arguments: { command: "reload" }, id: "control-reload" }]),
			assistantText("unavailable"),
		]);
		await environment.worker!.run("check removed control tool");
		const result = toolResultMessages(queued.captured[1]!).find((entry) => entry.toolName === "pi_control");
		assert.ok(result);
		assert.equal(result.isError, true);
		assert.match(result.content.map((block) => block.text ?? "").join("\n"), /not found/i);
		assert.equal(environment.reload.preflights.length, 0);
		assert.equal(environment.worker!.status().state, "idle");
	} finally {
		await environment.cleanup();
	}
});
