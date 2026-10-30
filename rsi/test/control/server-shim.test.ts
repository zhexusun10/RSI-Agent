import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { sendControlRequest } from "../../src/control/client.ts";
import { createControlRequest } from "../../src/control/protocol.ts";
import { ReloadCoordinator } from "../../src/control/reload.ts";
import { ControlServer } from "../../src/control/server.ts";
import { FakeClock, createTempState } from "../loop/fakes.ts";
import { makeReport, RecordingApply, RecordingPreflight } from "./helpers.ts";

function controlEndpoint(directory: string): string {
	return process.platform === "win32"
		? `\\\\.\\pipe\\rsi-control-${process.pid}-${randomUUID()}`
		: join(directory, "control.sock");
}

test("control server validates token, generation, source, finite operation, and request-id idempotency", async () => {
	const clock = new FakeClock();
	const state = await createTempState(clock, "rsi-control-server");
	const preflight = new RecordingPreflight(makeReport({ generation: 2 }));
	const apply = new RecordingApply();
	const coordinator = new ReloadCoordinator({
		clock,
		preflight,
		apply,
		currentGeneration: () => 2,
	});
	const endpoint = controlEndpoint(state.dir);
	const server = new ControlServer({
		endpoint,
		...(process.platform === "win32" ? {} : { endpointRoot: state.dir }),
		token: "test-token",
		reload: coordinator,
		currentGeneration: () => 2,
		currentSessionId: () => "session-2",
	});
	await server.listen();
	try {
		const validRequest = createControlRequest({
			requestId: "control-request-1",
			source: "worker-shim",
			generation: 2,
			sessionId: "session-2",
			token: "test-token",
			command: { kind: "reload", reason: "server reload", candidateId: "candidate-1" },
		});
		const valid = await sendControlRequest(endpoint, validRequest);
		assert.equal(valid.ok, true);
		assert.equal(apply.calls, 1);

		const duplicate = await sendControlRequest(endpoint, validRequest);
		assert.equal(duplicate.ok, true);
		assert.equal(apply.calls, 1);

		const reusedId = await sendControlRequest(
			endpoint,
			createControlRequest({
				requestId: "control-request-1",
				source: "worker-shim",
				generation: 2,
				sessionId: "session-2",
				token: "test-token",
				command: { kind: "reload", reason: "different payload" },
			}),
		);
		assert.equal(reusedId.ok, false);
		assert.equal(reusedId.ok ? "" : reusedId.error.code, "IPC_REQUEST_ID_INVALID");

		const wrongToken = await sendControlRequest(
			endpoint,
			createControlRequest({
				requestId: "control-request-token",
				source: "worker-shim",
				generation: 2,
				sessionId: "session-2",
				token: "wrong",
				command: { kind: "reload", reason: "bad token" },
			}),
		);
		assert.equal(wrongToken.ok, false);
		assert.equal(wrongToken.ok ? "" : wrongToken.error.code, "AGENT_COMMAND_FORBIDDEN");

		const stale = await sendControlRequest(
			endpoint,
			createControlRequest({
				requestId: "control-request-stale",
				source: "worker-shim",
				generation: 1,
				sessionId: "session-2",
				token: "test-token",
				command: { kind: "reload", reason: "stale" },
			}),
		);
		assert.equal(stale.ok, false);
		assert.equal(stale.ok ? "" : stale.error.code, "RELOAD_FAILED");

		const shutdown = await sendControlRequest(
			endpoint,
			createControlRequest({
				requestId: "control-request-shutdown",
				source: "worker-shim",
				generation: 2,
				sessionId: "session-2",
				token: "test-token",
				command: { kind: "shutdown", reason: "forged shutdown" },
			}),
		);
		assert.equal(shutdown.ok, false);
		assert.equal(shutdown.ok ? "" : shutdown.error.code, "AGENT_COMMAND_FORBIDDEN");

		const supervisorSource = await sendControlRequest(
			endpoint,
			createControlRequest({
				requestId: "control-request-source",
				source: "supervisor",
				generation: 2,
				sessionId: "session-2",
				token: "test-token",
				command: { kind: "reload", reason: "wrong source" },
			}),
		);
		assert.equal(supervisorSource.ok, false);
		assert.equal(supervisorSource.ok ? "" : supervisorSource.error.code, "AGENT_COMMAND_FORBIDDEN");
		assert.equal(apply.calls, 1);
	} finally {
		await server.close();
		await state.cleanup();
	}
});

test("control server returns preflight failures with a stack", async () => {
	const clock = new FakeClock();
	const state = await createTempState(clock, "rsi-control-failure");
	const preflight = new RecordingPreflight(makeReport({ ok: false, errors: ["bad syntax"] }));
	const apply = new RecordingApply();
	const coordinator = new ReloadCoordinator({
		clock,
		preflight,
		apply,
		currentGeneration: () => 1,
	});
	const endpoint = controlEndpoint(state.dir);
	const server = new ControlServer({
		endpoint,
		...(process.platform === "win32" ? {} : { endpointRoot: state.dir }),
		reload: coordinator,
		currentGeneration: () => 1,
		currentSessionId: () => "session-1",
	});
	await server.listen();
	try {
		const response = await sendControlRequest(
			endpoint,
			createControlRequest({
				requestId: "control-request-failure",
				source: "worker-shim",
				generation: 1,
				sessionId: "session-1",
				command: { kind: "reload", reason: "failure" },
			}),
		);
		assert.equal(response.ok, false);
		assert.equal(response.ok ? "" : response.error.code, "PREFLIGHT_FAILED");
		assert.match(response.ok ? "" : (response.error.stack ?? ""), /Reload preflight rejected/);
		assert.equal(apply.calls, 0);
	} finally {
		await server.close();
		await state.cleanup();
	}
});

interface ShimResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

async function runShim(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<ShimResult> {
	const shimPath = join(process.cwd(), "bin", "pi.mjs");
	return new Promise<ShimResult>((resolvePromise, reject) => {
		const child = spawn(process.execPath, [shimPath, ...args], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

test("pi shim forwards MCP commands unchanged and blocks all other Pi commands", async () => {
	const clock = new FakeClock();
	const state = await createTempState(clock, "rsi-pi-shim");
	const fakeLog = join(state.dir, "fake-pi.json");
	const fakeCli = join(state.dir, "fake-pi.mjs");
	await writeFile(
		fakeCli,
		[
			'import { writeFileSync } from "node:fs";',
			"writeFileSync(process.env.FAKE_PI_LOG, JSON.stringify({",
			"  argv: process.argv.slice(2),",
			"  cwd: process.cwd(),",
			"  marker: process.env.RSI_PI_SHIM_ACTIVE,",
			"}));",
			'process.stdout.write("fake-pi-ok\\n");',
			"",
		].join("\n"),
	);
	await access(fakeCli);
	try {
		const forwarded = await runShim(["mcp", "list"], {
			cwd: state.dir,
			env: { RSI_PI_REAL_CLI: fakeCli, FAKE_PI_LOG: fakeLog },
		});
		assert.equal(forwarded.code, 0);
		assert.match(forwarded.stdout, /fake-pi-ok/);
		const log = JSON.parse(await readFile(fakeLog, "utf8")) as {
			argv: string[];
			cwd: string;
			marker: string;
		};
		assert.deepEqual(log.argv, ["mcp", "list"]);
		assert.equal(log.cwd, state.dir);
		assert.equal(log.marker, "1");

		await rm(fakeLog, { force: true });
		const text = await runShim(["-p", "please inspect /reload and /quit words"], {
			cwd: state.dir,
			env: { RSI_PI_REAL_CLI: fakeCli, FAKE_PI_LOG: fakeLog },
		});
		assert.equal(text.code, 2);
		assert.match(text.stderr, /forbidden/);
		await assert.rejects(() => readFile(fakeLog));

		await rm(fakeLog, { force: true });
		const blocked = await runShim(["/quit"], {
			cwd: state.dir,
			env: { RSI_PI_REAL_CLI: fakeCli, FAKE_PI_LOG: fakeLog },
		});
		assert.equal(blocked.code, 2);
		assert.match(blocked.stderr, /forbidden/);
		await assert.rejects(() => readFile(fakeLog));

		const unsupported = await runShim(["/export"], {
			cwd: state.dir,
			env: { RSI_PI_REAL_CLI: fakeCli, FAKE_PI_LOG: fakeLog },
		});
		assert.equal(unsupported.code, 2);
		assert.match(unsupported.stderr, /forbidden/);
	} finally {
		await state.cleanup();
	}
});

test("pi /reload is rejected even if a control endpoint is reachable", async () => {
	const clock = new FakeClock();
	const state = await createTempState(clock, "rsi-pi-shim-control");
	const preflight = new RecordingPreflight(makeReport({ generation: 2 }));
	const apply = new RecordingApply();
	const coordinator = new ReloadCoordinator({
		clock,
		preflight,
		apply,
		currentGeneration: () => 1,
	});
	const endpoint = controlEndpoint(state.dir);
	const server = new ControlServer({
		endpoint,
		...(process.platform === "win32" ? {} : { endpointRoot: state.dir }),
		token: "shim-token",
		reload: coordinator,
		currentGeneration: () => 1,
		currentSessionId: () => "session-1",
	});
	await server.listen();
	const env = {
		RSI_CONTROL_SOCKET: endpoint,
		RSI_CONTROL_TOKEN: "shim-token",
		RSI_SESSION_GENERATION: "1",
		RSI_SESSION_ID: "session-1",
	};
	try {
		const result = await runShim(["/reload"], { cwd: state.dir, env });
		assert.equal(result.code, 2);
		assert.match(result.stderr, /forbidden/);
		assert.equal(preflight.calls.length, 0);
		assert.equal(apply.calls, 0);
	} finally {
		await server.close();
		await state.cleanup();
	}
});
