import type { Clock } from "../shared/time.ts";

/**
 * Node clamps any delay above 2^31-1 ms to 1 ms. Long sleeps must therefore be
 * split into chunks and rechecked against the wall clock.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface LoopTimerHandle {
	cancel(): void;
}

export interface LoopTimerPort {
	setTimeout(callback: () => void, delayMs: number): LoopTimerHandle;
}

class NodeTimerHandle implements LoopTimerHandle {
	private handle: NodeJS.Timeout | undefined;

	set(handle: NodeJS.Timeout): void {
		this.handle = handle;
	}

	cancel(): void {
		if (this.handle) clearTimeout(this.handle);
		this.handle = undefined;
	}
}

export class NodeLoopTimer implements LoopTimerPort {
	setTimeout(callback: () => void, delayMs: number): LoopTimerHandle {
		const handle = new NodeTimerHandle();
		handle.set(
			globalThis.setTimeout(() => {
				handle.cancel();
				callback();
			}, delayMs),
		);
		return handle;
	}
}

/**
 * Arm a timer for an absolute wall-clock deadline. It never passes an
 * out-of-range delay to the host timer; the final segment is at most
 * MAX_TIMER_DELAY_MS and then the wall clock is checked again.
 */
export function scheduleAtDeadline(
	deadlineMs: number,
	clock: Clock,
	timers: LoopTimerPort,
	onFire: () => void,
): LoopTimerHandle {
	let cancelled = false;
	let current: LoopTimerHandle | undefined;

	const arm = (): void => {
		if (cancelled) return;
		const remaining = deadlineMs - clock.now().getTime();
		if (remaining <= 0) {
			current = timers.setTimeout(() => {
				if (cancelled) return;
				if (clock.now().getTime() >= deadlineMs) onFire();
				else arm();
			}, 0);
			return;
		}
		const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
		current = timers.setTimeout(() => {
			if (cancelled) return;
			if (clock.now().getTime() >= deadlineMs) onFire();
			else arm();
		}, delay);
	};

	arm();
	return {
		cancel(): void {
			cancelled = true;
			current?.cancel();
			current = undefined;
		},
	};
}

export function scheduleAfterDelay(
	delayMs: number,
	clock: Clock,
	timers: LoopTimerPort,
	onFire: () => void,
): LoopTimerHandle {
	if (!Number.isFinite(delayMs) || delayMs < 0) {
		throw new Error("delayMs must be a finite non-negative number.");
	}
	return scheduleAtDeadline(clock.now().getTime() + delayMs, clock, timers, onFire);
}
