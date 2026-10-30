import { connect } from "node:net";
import { RsiError } from "../shared/errors.ts";
import {
	assertControlResponse,
	type ControlRequestEnvelope,
	type ControlResponseEnvelope,
} from "./protocol.ts";
import { CONTROL_DEFAULT_TIMEOUT_MS, CONTROL_MAX_FRAME_BYTES } from "./types.ts";

export interface ControlClientOptions {
	readonly timeoutMs?: number;
	readonly maxFrameBytes?: number;
}

/**
 * One request, one LF-delimited JSON response over a Unix socket (or a Windows
 * named pipe with the same path semantics). The shim never logs or persists a
 * control token.
 */
export async function sendControlRequest(
	endpoint: string,
	request: ControlRequestEnvelope,
	options: ControlClientOptions = {},
): Promise<ControlResponseEnvelope> {
	if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.includes("\u0000")) {
		throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Control endpoint is invalid.");
	}
	const timeoutMs = options.timeoutMs ?? CONTROL_DEFAULT_TIMEOUT_MS;
	const maxFrameBytes = options.maxFrameBytes ?? CONTROL_MAX_FRAME_BYTES;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Control timeout must be a positive number.");
	}
	const payload = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
	if (payload.length > maxFrameBytes) {
		throw new RsiError("IPC_FRAME_TOO_LARGE", "Control request exceeds the frame limit.");
	}
	return new Promise<ControlResponseEnvelope>((resolve, reject) => {
		const socket = connect({ path: endpoint });
		let buffer = Buffer.alloc(0);
		let settled = false;
		const finish = (error?: unknown, response?: ControlResponseEnvelope): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error !== undefined) reject(error);
			else if (response !== undefined) resolve(response);
			else reject(new RsiError("IPC_CLOSED", "Control connection closed without a response."));
		};
		const timer = setTimeout(() => {
			finish(new RsiError("IPC_TIMEOUT", "Control request timed out.", { retryable: true }));
		}, timeoutMs);
		socket.on("connect", () => {
			socket.write(payload);
		});
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > maxFrameBytes) {
				finish(new RsiError("IPC_FRAME_TOO_LARGE", "Control response exceeds the frame limit."));
				return;
			}
			const newline = buffer.indexOf(0x0a);
			if (newline === -1) return;
			const line = buffer.subarray(0, newline).toString("utf8");
			try {
				const parsed: unknown = JSON.parse(line);
				const response = assertControlResponse(parsed, request.requestId);
				finish(undefined, response);
			} catch (error) {
				finish(error);
			}
		});
		socket.on("error", (error) => {
			finish(new RsiError("IPC_CLOSED", `Control connection failed: ${error.message}`, { cause: error }));
		});
		socket.on("close", () => {
			if (!settled) finish();
		});
	});
}
