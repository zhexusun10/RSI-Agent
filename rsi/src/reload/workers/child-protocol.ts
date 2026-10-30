import { writeFileSync } from "node:fs";

export const PREFLIGHT_MANIFEST_ENV = "RSI_RELOAD_PREFLIGHT_MANIFEST";
export const PREFLIGHT_RESULT_ENV = "RSI_RELOAD_PREFLIGHT_RESULT";
export const PREFLIGHT_SETTLE_MS_ENV = "RSI_RELOAD_PREFLIGHT_SETTLE_MS";
export const PREFLIGHT_KIND_ENV = "RSI_RELOAD_PREFLIGHT_KIND";

export type PreflightWorkerKind = "static" | "mock";

export interface StaticCheckWorkerResult {
	readonly kind: "static";
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly filesChecked: number;
	readonly externalModules: number;
	readonly stack?: string;
}

export interface MockLoadWorkerResult {
	readonly kind: "mock";
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly loadedEntries: readonly string[];
	readonly extensionCount: number;
	readonly registrations: {
		readonly tools: number;
		readonly commands: number;
		readonly flags: number;
		readonly handlers: number;
	};
	readonly sessionStartHandlers: number;
	readonly stack?: string;
}

export type PreflightWorkerResult = StaticCheckWorkerResult | MockLoadWorkerResult;

export function writeWorkerResult(path: string | undefined, result: PreflightWorkerResult): void {
	if (!path) return;
	// Child diagnostics must be complete before the parent observes exit. Use a
	// bounded synchronous write so uncaught-exception and load-time paths work.
	try {
		writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		// The parent still has the exit code and stderr tail.
	}
}
