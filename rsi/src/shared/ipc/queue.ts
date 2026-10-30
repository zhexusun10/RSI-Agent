import { RsiError } from "../errors.ts";
import { DEFAULT_IPC_MAX_FRAME_BYTES } from "../policy.ts";

/** Bounded outbound queue. A full queue is an error, never an unbounded memory growth path. */
export class BoundedIpcOutboundQueue {
	private readonly frames: Uint8Array[] = [];
	private queuedBytes = 0;

	readonly maxQueuedBytes: number;

	constructor(maxQueuedBytes: number = DEFAULT_IPC_MAX_FRAME_BYTES * 2) {
		this.maxQueuedBytes = maxQueuedBytes;
		if (!Number.isInteger(maxQueuedBytes) || maxQueuedBytes <= 0) {
			throw new RsiError("INTERNAL", "maxQueuedBytes must be a positive integer.");
		}
	}

	enqueue(frame: Uint8Array): void {
		if (this.queuedBytes + frame.length > this.maxQueuedBytes) {
			throw new RsiError("IPC_BACKPRESSURE", "IPC outbound queue is full.", {
				retryable: true,
				details: { queuedBytes: this.queuedBytes, frameBytes: frame.length, maxQueuedBytes: this.maxQueuedBytes },
			});
		}
		this.frames.push(frame);
		this.queuedBytes += frame.length;
	}

	dequeue(): Uint8Array | undefined {
		const frame = this.frames.shift();
		if (frame !== undefined) this.queuedBytes -= frame.length;
		return frame;
	}

	clear(): void {
		this.frames.length = 0;
		this.queuedBytes = 0;
	}

	get size(): number {
		return this.queuedBytes;
	}

	get pendingFrames(): number {
		return this.frames.length;
	}
}

/** Write callback supplied by the socket transport; resolve only after the write is accepted/drained. */
export type IpcWrite = (chunk: Uint8Array) => Promise<void>;

/**
 * Serializes frame writes and applies queue backpressure. Transports must await
 * flush() and close on errors; they must not fall back to stdout.
 */
export class IpcOutboundWriter {
	private readonly queue: BoundedIpcOutboundQueue;
	private flushing: Promise<void> | undefined;

	constructor(options: { maxQueuedBytes?: number } = {}) {
		this.queue = new BoundedIpcOutboundQueue(options.maxQueuedBytes);
	}

	enqueue(frame: Uint8Array): void {
		this.queue.enqueue(frame);
	}

	async flush(write: IpcWrite): Promise<void> {
		if (this.flushing) return this.flushing;
		this.flushing = (async () => {
			try {
				for (;;) {
					const frame = this.queue.dequeue();
					if (frame === undefined) return;
					await write(frame);
				}
			} catch (error) {
				this.queue.clear();
				throw error;
			} finally {
				this.flushing = undefined;
			}
		})();
		return this.flushing;
	}

	get pendingBytes(): number {
		return this.queue.size;
	}

	clear(): void {
		this.queue.clear();
	}
}
