import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerIpcConnection } from "../../src/integration/ipc-transport.ts";
import { startRuntimeHarness, waitFor } from "../integration/helpers.ts";

/**
 * The Supervisor's Worker socket is group-accessible to the Worker UID, so any
 * extension/child running with that UID can connect to it. A second connection
 * must not be able to replace the real Worker peer and submit a heartbeat that
 * the external Watchdog treats as the Worker's liveness. Production Linux
 * bwrap is required for the full PID/namespace execution; this regression
 * exercises the actual Supervisor IPC host and Watchdog handler over its
 * explicit loopback test transport.
 */
test("an unauthenticated second IPC peer cannot replace the Worker or inject a heartbeat", { timeout: 60_000 }, async () => {
	const harness = await startRuntimeHarness();
	let attacker: WorkerIpcConnection | undefined;
	try {
		await waitFor(async () => {
			const status = await harness.runtime.status().catch(() => null);
			return status?.state === "idle" ? status : undefined;
		}, "real Worker ready", 20_000);

		attacker = await WorkerIpcConnection.connect({
			endpoint: harness.runtime.hostIpcEndpoint,
			maxFrameBytes: 1_048_576,
			requestTimeoutMs: 5_000,
		});
		const fakePid = 999_999;
		let accepted = false;
		try {
			await attacker.request(
				"heartbeat",
				{
					sequence: 424_242,
					workerPid: fakePid,
					generation: null,
					state: "idle",
					healthTurns: 0,
					memoryRevision: null,
					sentAtMs: Date.now(),
				},
				{ timeoutMs: 5_000 },
			);
			accepted = true;
		} catch {
			// A correct implementation authenticates the peer and rejects it.
		}
		const watchdog = await harness.runtime.watchdog.status();
		assert.equal(accepted, false, "the Supervisor must not accept a heartbeat from an unauthenticated IPC peer");
		assert.notEqual(
			watchdog.workerPid,
			fakePid,
			"a fake IPC peer must not become the pid the Watchdog monitors",
		);
		assert.notEqual(watchdog.lastSequence, 424_242, "a fake IPC peer must not control the heartbeat sequence");
	} finally {
		await attacker?.close().catch(() => undefined);
		await harness.cleanup();
	}
});

test("unauthenticated peers cannot forge health rounds, settled/reload events, or Worker identity", { timeout: 60_000 }, async () => {
	const harness = await startRuntimeHarness();
	const closeAfter = async (connection: WorkerIpcConnection): Promise<void> => {
		await connection.close().catch(() => undefined);
	};
	try {
		await waitFor(async () => {
			const status = await harness.runtime.status().catch(() => null);
			return status?.state === "idle" ? status : undefined;
		}, "real Worker ready", 20_000);
		const beforeWatchdog = await harness.runtime.watchdog.status();
		const beforeGeneration = harness.runtime.currentGeneration;

		for (let turn = 0; turn < 3; turn += 1) {
			const attacker = await WorkerIpcConnection.connect({
				endpoint: harness.runtime.hostIpcEndpoint,
				maxFrameBytes: 1_048_576,
				requestTimeoutMs: 5_000,
			});
			let accepted = false;
			try {
				await attacker.request(
					"health.turn",
					{
						attemptId: "forged-attempt",
						generation: 999,
						turnIndex: turn,
						stopReason: "stop",
						aborted: false,
						assistantMessages: 3,
						sessionId: "forged-session",
						atMs: Date.now(),
					},
					{ timeoutMs: 2_000 },
				);
				accepted = true;
			} catch {
				// Authentication is required before any health round is recorded.
			} finally {
				await closeAfter(attacker);
			}
			assert.equal(accepted, false, `forged health round ${turn} must be rejected`);
		}

		const forgedMethods: ReadonlyArray<[string, Record<string, unknown>]> = [
			[
				"heartbeat",
				{
					sequence: 424_242,
					workerPid: 999_999,
					generation: 999,
					state: "idle",
					healthTurns: 3,
					memoryRevision: null,
					sessionId: "forged-session",
					sentAtMs: Date.now(),
				},
			],
			["reload.failed", { attemptId: "forged-attempt", reason: "forged" }],
			["reload.started", { preflightId: "forged", candidateId: "forged", digest: "sha256:forged" }],
		];
		for (const [method, payload] of forgedMethods) {
			const attacker = await WorkerIpcConnection.connect({
				endpoint: harness.runtime.hostIpcEndpoint,
				maxFrameBytes: 1_048_576,
				requestTimeoutMs: 5_000,
			});
			let accepted = false;
			try {
				await attacker.request(method as never, payload as never, { timeoutMs: 2_000 });
				accepted = true;
			} catch {
				// Expected: only the authenticated Worker connection may call these.
			} finally {
				await closeAfter(attacker);
			}
			assert.equal(accepted, false, `forged ${method} must be rejected`);
		}

		const eventAttacker = await WorkerIpcConnection.connect({
			endpoint: harness.runtime.hostIpcEndpoint,
			maxFrameBytes: 1_048_576,
			requestTimeoutMs: 5_000,
		});
		try {
			eventAttacker.sendEvent("worker.ready", {
				pid: 999_999,
				generation: 999,
				startedAtMs: Date.now(),
				sessionId: "forged-session",
			});
			eventAttacker.sendEvent("agent.settled", {
				runId: "forged-run",
				generation: 999,
				sessionId: "forged-session",
				aborted: false,
				stopReason: "stop",
				assistantMessages: 3,
				atMs: Date.now(),
			});
			eventAttacker.sendEvent("reload.completed", {
				attemptId: "forged-attempt",
				generation: 999,
				atMs: Date.now(),
			});
		} finally {
			await closeAfter(eventAttacker);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));

		const afterState = await harness.runtime.coordinator.currentState();
		const afterWatchdog = await harness.runtime.watchdog.status();
		assert.notEqual(afterState.health?.attemptId, "forged-attempt");
		assert.notEqual(afterState.lkg?.generation, 999);
		assert.notEqual(afterState.active?.generation, 999);
		assert.notEqual(afterWatchdog.workerPid, 999_999);
		assert.notEqual(afterWatchdog.lastSequence, 424_242);
		assert.equal(harness.runtime.currentGeneration, beforeGeneration);
		assert.equal(afterWatchdog.workerPid, beforeWatchdog.workerPid);
		assert.equal((await harness.runtime.status()).state, "idle");
	} finally {
		await harness.cleanup();
	}
});
