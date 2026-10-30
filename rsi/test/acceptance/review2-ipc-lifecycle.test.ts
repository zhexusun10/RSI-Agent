import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
	SupervisorIpcHost,
	WorkerIpcConnection,
} from "../../src/integration/ipc-transport.ts";
import { createWorkerBootstrap } from "../../src/shared/ipc/bootstrap.ts";

async function freeTcpPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

function healthTurn(turnIndex: number) {
	return {
		attemptId: "review2-attempt",
		generation: 1,
		turnIndex,
		stopReason: "stop",
		aborted: false,
		assistantMessages: 1,
		sessionId: "review2-session",
		atMs: Date.now(),
	};
}

function heartbeat(sequence: number) {
	return {
		sequence,
		workerPid: 2,
		generation: 1,
		state: "idle" as const,
		healthTurns: 0,
		memoryRevision: null,
		sessionId: "review2-session",
		sentAtMs: Date.now(),
	};
}

/**
 * Independent review regression for the launch-credential lifetime and
 * revocation boundary: an expired credential cannot be replayed, a new launch
 * revokes the old authenticated peer, three forged health rounds from that old
 * peer cannot reach the handler, and a fresh legitimate peer still works.
 */
test("review2: expired/replayed credentials cannot forge health rounds after launch revocation", { timeout: 30_000 }, async () => {
	const endpoint = `tcp://127.0.0.1:${await freeTcpPort()}`;
	const healed: number[] = [];
	const host = new SupervisorIpcHost({
		endpoint,
		maxFrameBytes: 1_048_576,
		requestTimeoutMs: 5_000,
		allowTcpForTests: true,
		handshakeTimeoutMs: 2_000,
		workerExpectationTimeoutMs: 100,
	});
	host.handle("health.turn", async (payload) => {
		healed.push(payload.turnIndex);
		return {
			consecutiveHealthyTurns: payload.turnIndex + 1,
			required: 3,
			promoted: false,
			lkgGeneration: null,
			failed: false,
		};
	});
	host.handle("heartbeat", async () => ({
		accepted: true as const,
		serverTimeMs: Date.now(),
		leaseExpiresAtMs: Date.now() + 5_000,
		directive: "none" as const,
	}));
	await host.listen();
	let oldPeer: WorkerIpcConnection | undefined;
	let freshPeer: WorkerIpcConnection | undefined;
	try {
		const expired = createWorkerBootstrap(1);
		host.expectWorker({
			launchId: expired.launchId,
			token: expired.token,
			generation: expired.generation,
		});
		await delay(300);
		await assert.rejects(
			WorkerIpcConnection.connect({
				endpoint,
				maxFrameBytes: 1_048_576,
				requestTimeoutMs: 5_000,
				authentication: {
					launchId: expired.launchId,
					token: expired.token,
					generation: expired.generation,
				},
			}),
			/auth|credential|expired|used/iu,
		);
		assert.equal(host.connected, false);

		const first = createWorkerBootstrap(1);
		host.expectWorker({ launchId: first.launchId, token: first.token, generation: first.generation });
		oldPeer = await WorkerIpcConnection.connect({
			endpoint,
			maxFrameBytes: 1_048_576,
			requestTimeoutMs: 5_000,
			authentication: {
				launchId: first.launchId,
				token: first.token,
				generation: first.generation,
			},
		});
		await oldPeer.request("health.turn", healthTurn(0), { timeoutMs: 2_000 });
		assert.deepEqual(healed, [0]);

		const second = createWorkerBootstrap(1);
		host.expectWorker({ launchId: second.launchId, token: second.token, generation: second.generation });
		assert.equal(host.connected, false, "a new launch must revoke the old peer before authentication");
		const forged = await Promise.allSettled(
			[0, 1, 2].map((turn) =>
				oldPeer!.request("health.turn", healthTurn(turn), { timeoutMs: 1_000 }),
			),
		);
		assert.equal(forged.filter((result) => result.status === "fulfilled").length, 0);
		assert.deepEqual(healed, [0], "revoked peer health rounds must not reach the handler");

		await assert.rejects(
			WorkerIpcConnection.connect({
				endpoint,
				maxFrameBytes: 1_048_576,
				requestTimeoutMs: 5_000,
				authentication: {
					launchId: first.launchId,
					token: first.token,
					generation: first.generation,
				},
			}),
			/auth|credential|used|replay/iu,
		);

		freshPeer = await WorkerIpcConnection.connect({
			endpoint,
			maxFrameBytes: 1_048_576,
			requestTimeoutMs: 5_000,
			authentication: {
				launchId: second.launchId,
				token: second.token,
				generation: second.generation,
			},
		});
		assert.equal(host.connected, true);
		for (const turn of [0, 1, 2]) {
			await freshPeer.request("health.turn", healthTurn(turn), { timeoutMs: 2_000 });
		}
		await freshPeer.request("heartbeat", heartbeat(1), { timeoutMs: 2_000 });
		assert.deepEqual(healed, [0, 0, 1, 2]);
	} finally {
		await oldPeer?.close().catch(() => undefined);
		await freshPeer?.close().catch(() => undefined);
		await host.close().catch(() => undefined);
	}
});
