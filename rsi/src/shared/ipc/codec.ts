import { RsiError } from "../errors.ts";
import { DEFAULT_IPC_MAX_FRAME_BYTES } from "../policy.ts";
import { IPC_FRAME_DELIMITER, type IpcFrame, validateIpcFrame } from "./protocol.ts";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface IpcCodecOptions {
	/** Maximum bytes for one UTF-8 JSON record, excluding the LF delimiter. */
	readonly maxFrameBytes?: number;
}

function decodeJsonLine(line: Uint8Array): IpcFrame {
	let text: string;
	try {
		text = utf8Decoder.decode(line);
	} catch (error) {
		throw new RsiError("IPC_INVALID_FRAME", "IPC frame is not valid UTF-8.", { cause: error });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new RsiError("IPC_INVALID_FRAME", "IPC frame is not valid JSON.", { cause: error });
	}
	return validateIpcFrame(parsed);
}

/** Encode one validated frame as UTF-8 JSON plus a single LF delimiter. */
export function encodeIpcFrame(frame: IpcFrame, options: IpcCodecOptions = {}): Uint8Array {
	const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_IPC_MAX_FRAME_BYTES;
	const validated = validateIpcFrame(frame);
	const json = JSON.stringify(validated);
	const bytes = Buffer.from(json, "utf8");
	if (bytes.length > maxFrameBytes) {
		throw new RsiError("IPC_FRAME_TOO_LARGE", `IPC frame is ${bytes.length} bytes; maximum is ${maxFrameBytes}.`, {
			details: { bytes: bytes.length, maxFrameBytes },
		});
	}
	return Buffer.concat([bytes, Buffer.from([IPC_FRAME_DELIMITER])]);
}

/** Decode a single line without its LF/CR delimiter. */
export function decodeIpcLine(line: Uint8Array, options: IpcCodecOptions = {}): IpcFrame {
	const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_IPC_MAX_FRAME_BYTES;
	const trimmed =
		line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line;
	if (trimmed.length === 0) {
		throw new RsiError("IPC_INVALID_FRAME", "IPC frame is empty.");
	}
	if (trimmed.length > maxFrameBytes) {
		throw new RsiError("IPC_FRAME_TOO_LARGE", `IPC frame exceeds ${maxFrameBytes} bytes.`, {
			details: { bytes: trimmed.length, maxFrameBytes },
		});
	}
	return decodeJsonLine(trimmed);
}

/**
 * Byte-oriented LF frame decoder.
 *
 * JSON strings can contain U+2028/U+2029, so this decoder splits only on byte
 * 0x0A. `readline` is deliberately not used. Once a framing error occurs the
 * decoder stays failed so the transport can close instead of resynchronizing.
 */
export class IpcFrameDecoder {
	private buffer: Buffer = Buffer.alloc(0);
	private failed: RsiError | undefined;
	private readonly maxFrameBytes: number;

	constructor(options: IpcCodecOptions = {}) {
		this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_IPC_MAX_FRAME_BYTES;
	}

	push(chunk: Uint8Array): IpcFrame[] {
		if (this.failed) throw this.failed;
		if (chunk.length === 0) return [];
		this.buffer =
			this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, Buffer.from(chunk)]);
		const frames: IpcFrame[] = [];
		try {
			let start = 0;
			for (;;) {
				const newline = this.buffer.indexOf(IPC_FRAME_DELIMITER, start);
				if (newline === -1) break;
				const line = this.buffer.subarray(start, newline);
				frames.push(decodeIpcLine(line, { maxFrameBytes: this.maxFrameBytes }));
				start = newline + 1;
			}
			if (start > 0) this.buffer = this.buffer.subarray(start);
			if (this.buffer.length > this.maxFrameBytes) {
				throw new RsiError(
					"IPC_FRAME_TOO_LARGE",
					`Buffered IPC frame exceeds ${this.maxFrameBytes} bytes without an LF delimiter.`,
					{ details: { bytes: this.buffer.length, maxFrameBytes: this.maxFrameBytes } },
				);
			}
			return frames;
		} catch (error) {
			this.failed =
				error instanceof RsiError && error.code.startsWith("IPC_")
					? error
					: new RsiError("IPC_INVALID_FRAME", "Failed to decode IPC frame stream.", { cause: error });
			this.buffer = Buffer.alloc(0);
			throw this.failed;
		}
	}

	/** Assert that the stream ended on a record boundary. */
	finish(): void {
		if (this.failed) throw this.failed;
		if (this.buffer.length > 0) {
			throw new RsiError("IPC_INVALID_FRAME", "IPC stream ended with a partial frame.");
		}
	}
}
