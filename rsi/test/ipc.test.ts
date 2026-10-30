import assert from "node:assert/strict";
import test from "node:test";
import {
	assertIpcDirection,
	BoundedIpcOutboundQueue,
	decodeIpcLine,
	encodeIpcFrame,
	errorResponseFrame,
	eventFrame,
	IpcFrameDecoder,
	IpcOutboundWriter,
	isIpcRequest,
	isIpcResponse,
	requestFrame,
	responseFrame,
	validateIpcFrame,
} from "../src/shared/index.ts";

const MAX = 4_096;

test("request frames round-trip across arbitrary fragmentation", () => {
	const request = requestFrame("memory.current", {}, { requestId: "req-1" });
	const bytes = encodeIpcFrame(request, { maxFrameBytes: MAX });
	const decoder = new IpcFrameDecoder({ maxFrameBytes: MAX });
	const frames = [];
	for (const byte of bytes) frames.push(...decoder.push(Uint8Array.of(byte)));
	decoder.finish();
	assert.equal(frames.length, 1);
	const frame = frames[0];
	assert.ok(frame && isIpcRequest(frame));
	assert.equal(frame.method, "memory.current");
	assert.equal(frame.requestId, "req-1");
});

test("responses and events round-trip and preserve U+2028 inside strings", () => {
	const request = requestFrame("docs.commit", {
		name: "a.md",
		content: "line\u2028separator",
		expectedRevision: null,
		operation: "write",
	});
	const response = responseFrame(request, {
		name: "a.md",
		revision: "sha256:abc",
		words: 2,
		created: false,
		indexWarnings: [],
		committedAtMs: 1,
	});
	const event = eventFrame("docs.changed", { name: "a.md", revision: "sha256:abc" }, { eventId: "evt-1" });
	const bytes = Buffer.concat([
		encodeIpcFrame(request, { maxFrameBytes: MAX }),
		encodeIpcFrame(response, { maxFrameBytes: MAX }),
		encodeIpcFrame(event, { maxFrameBytes: MAX }),
	]);
	const decoder = new IpcFrameDecoder({ maxFrameBytes: MAX });
	const frames = decoder.push(bytes);
	decoder.finish();
	assert.equal(frames.length, 3);
	assert.equal(frames[0]?.type, "request");
	assert.ok(frames[1] && isIpcResponse(frames[1]));
	assert.equal(frames[2]?.type, "event");
});

test("CRLF is accepted and malformed or partial frames fail closed", () => {
	const request = requestFrame("docs.list", {});
	const encoded = encodeIpcFrame(request, { maxFrameBytes: MAX });
	const crlf = Buffer.concat([Buffer.from(encoded.subarray(0, encoded.length - 1)), Buffer.from("\r\n")]);
	const decoder = new IpcFrameDecoder({ maxFrameBytes: MAX });
	assert.equal(decoder.push(crlf).length, 1);
	decoder.finish();
	assert.throws(() => decodeIpcLine(Buffer.from("{not json")), /valid JSON/);
	const partial = new IpcFrameDecoder({ maxFrameBytes: MAX });
	partial.push(Buffer.from('{"protocol":"rsi-ipc"'));
	assert.throws(() => partial.finish(), /partial frame/);
});

test("frame and queue size limits are enforced", () => {
	const request = requestFrame("docs.commit", {
		name: "a.md",
		content: "x".repeat(200),
		expectedRevision: null,
		operation: "write",
	});
	assert.throws(
		() => encodeIpcFrame(request, { maxFrameBytes: 64 }),
		(error: unknown) => (error as { code?: string }).code === "IPC_FRAME_TOO_LARGE",
	);
	const decoder = new IpcFrameDecoder({ maxFrameBytes: 64 });
	assert.throws(
		() => decoder.push(encodeIpcFrame(request, { maxFrameBytes: MAX })),
		(error: unknown) => (error as { code?: string }).code === "IPC_FRAME_TOO_LARGE",
	);
	const queue = new BoundedIpcOutboundQueue(5);
	queue.enqueue(new Uint8Array(3));
	assert.throws(
		() => queue.enqueue(new Uint8Array(3)),
		(error: unknown) => (error as { code?: string }).code === "IPC_BACKPRESSURE",
	);
	assert.equal(queue.dequeue()?.length, 3);
	assert.equal(queue.size, 0);
});

test("outbound writer serializes queued frames", async () => {
	const writer = new IpcOutboundWriter({ maxQueuedBytes: 32 });
	writer.enqueue(Uint8Array.of(1));
	writer.enqueue(Uint8Array.of(2));
	const written: number[] = [];
	await writer.flush(async (chunk) => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		written.push(chunk[0] ?? 0);
	});
	assert.deepEqual(written, [1, 2]);
	assert.equal(writer.pendingBytes, 0);
});

test("error responses carry the request id and direction is explicit", () => {
	const request = requestFrame("heartbeat", {
		sequence: 1,
		workerPid: 2,
		generation: null,
		state: "idle",
		healthTurns: 0,
		memoryRevision: null,
		sentAtMs: 3,
	}, { requestId: "heartbeat-1" });
	const response = errorResponseFrame(request, {
		name: "RsiError",
		code: "IPC_TIMEOUT",
		message: "timeout",
		retryable: true,
	});
	assert.equal(response.ok, false);
	assert.equal(response.error.requestId, "heartbeat-1");
	assert.doesNotThrow(() => assertIpcDirection("memory.current", "worker-to-supervisor"));
	assert.throws(
		() => assertIpcDirection("memory.current", "supervisor-to-worker"),
		(error: unknown) => (error as { code?: string }).code === "IPC_DIRECTION_FORBIDDEN",
	);
	const invalid = { protocol: "rsi-ipc", version: 1, type: "request", requestId: "x", method: "unknown", payload: {} };
	assert.throws(
		() => validateIpcFrame(invalid),
		(error: unknown) => (error as { code?: string }).code === "IPC_METHOD_UNKNOWN",
	);
});
