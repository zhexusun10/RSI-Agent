import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../src/shared/time.ts";
import { KnowledgeService, type KnowledgeServiceOptions } from "../../src/knowledge/index.ts";

export class FakeClock implements Clock {
	private currentMs: number;

	constructor(initial: Date | number) {
		this.currentMs = typeof initial === "number" ? initial : initial.getTime();
	}

	now(): Date {
		return new Date(this.currentMs);
	}

	set(date: Date | number): void {
		this.currentMs = typeof date === "number" ? date : date.getTime();
	}

	advance(milliseconds: number): void {
		this.currentMs += milliseconds;
	}
}

export interface KnowledgeFixture {
	readonly baseDir: string;
	readonly markdownsDir: string;
	readonly stateDir: string;
	readonly readStatsFile: string;
	readonly clock: FakeClock;
	readonly service: KnowledgeService;
	open(options?: Partial<KnowledgeServiceOptions>): Promise<KnowledgeService>;
	cleanup(): Promise<void>;
}

export async function createKnowledgeFixture(options: {
	readonly now?: Date;
	readonly service?: Partial<KnowledgeServiceOptions>;
} = {}): Promise<KnowledgeFixture> {
	const baseDir = await mkdtemp(join(tmpdir(), "rsi-knowledge-"));
	const markdownsDir = join(baseDir, "markdowns");
	const stateDir = join(baseDir, "state");
	await mkdir(markdownsDir);
	await mkdir(stateDir);
	const clock = new FakeClock(options.now ?? Date.UTC(2026, 0, 2, 3, 4, 5));
	const readStatsFile = join(stateDir, "read-stats", "reads.json");
	const service = await KnowledgeService.open({
		markdownsDir,
		stateDir,
		readStatsFile,
		clock,
		timeZone: "UTC",
		...options.service,
	});
	return {
		baseDir,
		markdownsDir,
		stateDir,
		readStatsFile,
		clock,
		service,
		async open(openOptions = {}) {
			return KnowledgeService.open({
				markdownsDir,
				stateDir,
				readStatsFile,
				clock,
				timeZone: "UTC",
				...openOptions,
			});
		},
		async cleanup() {
			await rm(baseDir, { recursive: true, force: true });
		},
	};
}

export async function readText(path: string): Promise<string> {
	return readFile(path, "utf8");
}

export async function readBytes(path: string): Promise<Buffer> {
	return readFile(path);
}

export async function fileTimes(path: string): Promise<{ mtimeMs: number; atimeMs: number; size: number }> {
	const info = await stat(path);
	return { mtimeMs: info.mtimeMs, atimeMs: info.atimeMs, size: info.size };
}

export async function writeRaw(path: string, content: string | Uint8Array): Promise<void> {
	await writeFile(path, content);
}

export function makeIndex(rows: readonly { name: string; description: string; location: string }[]): string {
	const lines = [
		"# Managed Markdown Index",
		"",
		"| md名 | description | 链接位置 |",
		"| --- | --- | --- |",
		...rows.map((row) => `| ${row.name} | ${row.description} | ${row.location} |`),
		"",
	];
	return lines.join("\n");
}

export function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}
