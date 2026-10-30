import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../src/shared/time.ts";
import { AtomicLoopStateStore } from "../../src/loop/state.ts";
import type { LoopTimerHandle, LoopTimerPort } from "../../src/loop/timer.ts";

export class FakeClock implements Clock {
	private currentMs: number;

	constructor(startMs = Date.UTC(2026, 9, 26, 12, 0, 0)) {
		this.currentMs = startMs;
	}

	now(): Date {
		return new Date(this.currentMs);
	}

	set(ms: number): void {
		if (!Number.isFinite(ms)) throw new Error("clock must be finite");
		this.currentMs = ms;
	}

	advance(ms: number): void {
		this.currentMs += ms;
	}

	get timeMs(): number {
		return this.currentMs;
	}
}

interface FakeTimerTask {
	readonly id: number;
	readonly dueAtMs: number;
	readonly callback: () => void;
	cancelled: boolean;
}

/** Deterministic wall-clock timer queue. `advance()` fires due tasks in order. */
export class FakeTimer implements LoopTimerPort {
	private readonly clock: FakeClock;
	private readonly tasks: FakeTimerTask[] = [];
	private nextId = 1;

	constructor(clock: FakeClock) {
		this.clock = clock;
	}

	setTimeout(callback: () => void, delayMs: number): LoopTimerHandle {
		const task: FakeTimerTask = {
			id: this.nextId++,
			dueAtMs: this.clock.now().getTime() + Math.max(0, delayMs),
			callback,
			cancelled: false,
		};
		this.tasks.push(task);
		return {
			cancel: () => {
				task.cancelled = true;
			},
		};
	}

	pendingDelays(): number[] {
		return this.tasks
			.filter((task) => !task.cancelled)
			.map((task) => Math.max(0, task.dueAtMs - this.clock.now().getTime()))
			.sort((left, right) => left - right);
	}

	get pendingCount(): number {
		return this.tasks.filter((task) => !task.cancelled).length;
	}

	/** Advance the fake clock and synchronously fire all tasks that become due. */
	advance(ms: number): void {
		this.clock.advance(ms);
		this.runDue();
	}

	/** Run one due task only; useful for zero-delay continuation scheduling. */
	runDue(): void {
		for (;;) {
			const now = this.clock.now().getTime();
			let index = -1;
			let earliest = Number.POSITIVE_INFINITY;
			for (let taskIndex = 0; taskIndex < this.tasks.length; taskIndex++) {
				const task = this.tasks[taskIndex];
				if (!task || task.cancelled) continue;
				if (task.dueAtMs < earliest) {
					earliest = task.dueAtMs;
					index = taskIndex;
				}
			}
			if (index === -1 || earliest > now) return;
			const [task] = this.tasks.splice(index, 1);
			if (task && !task.cancelled) task.callback();
		}
	}
}

export async function flushTasks(rounds = 8): Promise<void> {
	for (let index = 0; index < rounds; index++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/** Wait for filesystem-backed async loop work without consuming fake timers. */
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	label = "condition",
	timeoutMs = 3_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${label}.`);
}

/** Let real filesystem/microtask work settle before asserting a negative. */
export async function settle(): Promise<void> {
	await flushTasks();
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	await flushTasks();
}

export interface TempState {
	readonly dir: string;
	readonly stateDir: string;
	readonly store: AtomicLoopStateStore;
	cleanup(): Promise<void>;
}

export async function createTempState(clock: Clock, label = "rsi-loop"): Promise<TempState> {
	const dir = await mkdtemp(join(tmpdir(), `${label}-`));
	const stateDir = join(dir, "state");
	const store = new AtomicLoopStateStore({
		filePath: join(stateDir, "sleep.json"),
		stateDir,
		clock,
	});
	return {
		dir,
		stateDir,
		store,
		async cleanup() {
			await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
		},
	};
}

export class RecordingEvents {
	private readonly events: Array<{ readonly event: string; readonly payload: unknown }> = [];

	emit<K extends string>(event: K, payload: unknown): void {
		this.events.push({ event, payload });
	}

	names(): string[] {
		return this.events.map((entry) => entry.event);
	}

	count(name: string): number {
		return this.events.filter((entry) => entry.event === name).length;
	}

	all(): ReadonlyArray<{ readonly event: string; readonly payload: unknown }> {
		return this.events;
	}
}
