import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
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

function heartbeat(sequence: number) {
	return {
		sequence,
		workerPid: 2,
		generation: 1,
		state: "idle" as const,
		healthTurns: 0,
		memoryRevision: null,
		sessionId: "session-a",
		sentAtMs: Date.now(),
	};
}

test("one-time Worker credentials bind exactly one peer and reject replay without replacing it", { timeout: 30_000 }, async () => {
	const port = await freeTcpPort();
	const endpoint = `tcp://127.0.0.1:${port}`;
	let peers = 0;
	const host = new SupervisorIpcHost({
		endpoint,
		maxFrameBytes: 1_048_576,
		requestTimeoutMs: 5_000,
		allowTcpForTests: true,
		handshakeTimeoutMs: 2_000,
		onPeer: (peer) => {
			if (peer !== null) peers += 1;
		},
	});
	const heartbeats: number[] = [];
	host.handle("heartbeat", async (payload) => {
		heartbeats.push(payload.sequence);
		return {
			accepted: true as const,
			serverTimeMs: Date.now(),
			leaseExpiresAtMs: Date.now() + 5_000,
			directive: "none" as const,
		};
	});
	await host.listen();
	const first = createWorkerBootstrap(1);
	let worker: WorkerIpcConnection | undefined;
	let replay: WorkerIpcConnection | undefined;
	let extra: WorkerIpcConnection | undefined;
	let replacement: WorkerIpcConnection | undefined;
	try {
		host.expectWorker({ launchId: first.launchId, token: first.token, generation: first.generation });

		// A connection that sends a normal request before authentication cannot
		// invoke the registered heartbeat handler or displace anyone.
		extra = await WorkerIpcConnection.connect({
			endpoint,
			maxFrameBytes: 1_048_576,
			requestTimeoutMs: 5_000,
		});
		await assert.rejects(
			extra.request("heartbeat", heartbeat(1), { timeoutMs: 2_000 }),
			/authentication|auth/i,
		);
		assert.equal(host.connected, false);
		assert.deepEqual(heartbeats, []);

		// A wrong launch generation and a wrong token are both rejected.
		await assert.rejects(
			WorkerIpcConnection.connect({
				endpoint,
				maxFrameBytes: 1_048_576,
				requestTimeoutMs: 5_000,
				authentication: {
					launchId: first.launchId,
					token: first.token,
					generation: 2,
				},
			}),
			/auth|credential|failed/i,
		);
		await assert.rejects(
			WorkerIpcConnection.connect({
				endpoint,
				maxFrameBytes: 1_048_576,
				requestTimeoutMs: 5_000,
				authentication: {
					launchId: first.launchId,
					token: createWorkerBootstrap(1).token,
					generation: 1,
				},
			}),
			/auth|credential|failed/i,
		);
		assert.equal(host.connected, false);

		worker = await WorkerIpcConnection.connect({
			endpoint,
			maxFrameBytes: 1_048_576,
			requestTimeoutMs: 5_000,
			authentication: {
				launchId: first.launchId,
				token: first.token,
				generation: 1,
			},
		});
		assert.equal(host.connected, true);
		assert.deepEqual(host.currentIdentity, { launchId: first.launchId, generation: 1 });
		await worker.request("heartbeat", heartbeat(2), { timeoutMs: 2_000 });
		assert.deepEqual(heartbeats, [2]);

		// Replaying the consumed credential cannot close or replace the healthy
		// authenticated peer.
		await assert.rejects(
			WorkerIpcConnection.connect({
				endpoint,
				maxFrameBytes: 1_048_576,
				requestTimeoutMs: 5_000,
				authentication: {
					launchId: first.launchId,
					token: first.token,
					generation: 1,
				},
			}),
			/auth|credential|failed/i,
		);
		assert.equal(host.connected, true);
		await worker.request("heartbeat", heartbeat(3), { timeoutMs: 2_000 });
		assert.deepEqual(heartbeats, [2, 3]);
		assert.equal(peers, 1);

		// A new Supervisor launch replaces the old connection with a new identity.
		// The old credential and old peer cannot submit more state afterwards.
		const second = createWorkerBootstrap(1);
		host.expectWorker({ launchId: second.launchId, token: second.token, generation: second.generation });
		assert.equal(host.connected, false);
		await assert.rejects(worker.request("heartbeat", heartbeat(4), { timeoutMs: 1_000 }));
		await assert.rejects(
			WorkerIpcConnection.connect({
				endpoint,
				maxFrameBytes: 1_048_576,
				requestTimeoutMs: 5_000,
				authentication: {
					launchId: first.launchId,
					token: first.token,
					generation: 1,
				},
			}),
			/auth|credential|failed/i,
		);
		replacement = await WorkerIpcConnection.connect({
			endpoint,
			maxFrameBytes: 1_048_576,
			requestTimeoutMs: 5_000,
			authentication: {
				launchId: second.launchId,
				token: second.token,
				generation: 1,
			},
		});
		assert.deepEqual(host.currentIdentity, { launchId: second.launchId, generation: 1 });
		await replacement.request("heartbeat", heartbeat(5), { timeoutMs: 2_000 });
		assert.deepEqual(heartbeats, [2, 3, 5]);
		assert.equal(peers, 2);
	} finally {
		await extra?.close().catch(() => undefined);
		await worker?.close().catch(() => undefined);
		await replay?.close().catch(() => undefined);
		await replacement?.close().catch(() => undefined);
		await host.close().catch(() => undefined);
	}
});

test("the handshake deadline closes only the unauthenticated extra connection", { timeout: 30_000 }, async () => {
	const port = await freeTcpPort();
	const endpoint = `tcp://127.0.0.1:${port}`;
	const host = new SupervisorIpcHost({
		endpoint,
		maxFrameBytes: 1_048_576,
		requestTimeoutMs: 5_000,
		allowTcpForTests: true,
		handshakeTimeoutMs: 100,
		maxPendingConnections: 2,
	});
	host.handle("heartbeat", async () => ({
		accepted: true as const,
		serverTimeMs: Date.now(),
		leaseExpiresAtMs: Date.now() + 5_000,
		directive: "none" as const,
	}));
	await host.listen();
	const bootstrap = createWorkerBootstrap(1);
	let silent: WorkerIpcConnection | undefined;
	let valid: WorkerIpcConnection | undefined;
	try {
		host.expectWorker({ launchId: bootstrap.launchId, token: bootstrap.token, generation: 1 });
		silent = await WorkerIpcConnection.connect({
			endpoint,
			maxFrameBytes: 1_048_576,
			requestTimeoutMs: 5_000,
		});
		await Promise.race([
			silent.closed,
			new Promise((_, reject) => setTimeout(() => reject(new Error("handshake was not bounded")), 3_000)),
		]);
		assert.equal(host.connected, false);
		valid = await WorkerIpcConnection.connect({
			endpoint,
			maxFrameBytes: 1_048_576,
			requestTimeoutMs: 5_000,
			authentication: {
				launchId: bootstrap.launchId,
				token: bootstrap.token,
				generation: 1,
			},
		});
		assert.equal(host.connected, true);
		await valid.request("heartbeat", heartbeat(1), { timeoutMs: 2_000 });
	} finally {
		await silent?.close().catch(() => undefined);
		await valid?.close().catch(() => undefined);
		await host.close().catch(() => undefined);
	}
});
