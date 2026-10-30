import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import type { CandidateManifest } from "../types.ts";
import {
	PREFLIGHT_MANIFEST_ENV,
	PREFLIGHT_RESULT_ENV,
	PREFLIGHT_SETTLE_MS_ENV,
	writeWorkerResult,
	type MockLoadWorkerResult,
} from "./child-protocol.ts";

const DEFAULT_SETTLE_MS = 250;

function contains(parent: string, candidate: string): boolean {
	const rel = relative(resolve(parent), resolve(candidate));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function noop(): undefined {
	return undefined;
}

function deepMock(path: string): unknown {
	const target = function mockFunction(): undefined {
		return undefined;
	};
	return new Proxy(target, {
		get(_target, property) {
			if (property === "then") return undefined;
			if (property === "toJSON") return () => ({ mock: path });
			if (property === Symbol.toStringTag) return "MockExtensionApi";
			return deepMock(`${path}.${String(property)}`);
		},
		apply() {
			return undefined;
		},
	});
}

function createMockContext(cwd: string): Record<string, unknown> {
	const ui: Record<string, unknown> = {
		notify: noop,
		setStatus: noop,
		setWidget: noop,
		setHeader: noop,
		setFooter: noop,
		setTheme: () => ({ success: true }),
		getTheme: () => undefined,
		getAllThemes: () => [],
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => undefined,
		setToolsExpanded: noop,
		getToolsExpanded: () => false,
	};
	const modelRegistry = {
		getAvailable: () => [],
		getAll: () => [],
		find: () => undefined,
		get: () => undefined,
	};
	const sessionManager = {
		getEntries: () => [],
		getSessionFile: () => undefined,
		getSessionId: () => "preflight-mock",
		getCwd: () => cwd,
	};
	const base: Record<string, unknown> = {
		ui,
		mode: "print",
		hasUI: false,
		cwd,
		sessionManager,
		modelRegistry,
		model: undefined,
		scopedModels: [],
		thinkingLevel: "off",
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: noop,
		hasPendingMessages: () => false,
		shutdown: noop,
		getContextUsage: () => undefined,
		compact: noop,
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({}),
		waitForIdle: async () => undefined,
	};
	return new Proxy(base, {
		get(target, property) {
			if (property in target) return target[property as string];
			return deepMock(`ctx.${String(property)}`);
		},
	});
}

function fail(resultPath: string, error: unknown, stack?: string): never {
	const result: MockLoadWorkerResult = {
		kind: "mock",
		ok: false,
		errors: [error instanceof Error ? error.message : String(error)],
		loadedEntries: [],
		extensionCount: 0,
		registrations: { tools: 0, commands: 0, flags: 0, handlers: 0 },
		sessionStartHandlers: 0,
		...(stack === undefined ? {} : { stack }),
	};
	writeWorkerResult(resultPath, result);
	process.exit(70);
}

async function main(): Promise<MockLoadWorkerResult> {
	const manifestPath = process.env[PREFLIGHT_MANIFEST_ENV];
	const resultPath = process.env[PREFLIGHT_RESULT_ENV] ?? "";
	const settleMs = Number(process.env[PREFLIGHT_SETTLE_MS_ENV] ?? DEFAULT_SETTLE_MS);
	if (!manifestPath) {
		return {
			kind: "mock",
			ok: false,
			errors: ["Missing preflight manifest path."],
			loadedEntries: [],
			extensionCount: 0,
			registrations: { tools: 0, commands: 0, flags: 0, handlers: 0 },
			sessionStartHandlers: 0,
		};
	}
	const candidateRoot = dirname(resolve(manifestPath));
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CandidateManifest;
	const entries = manifest.entries.map((entry) => resolve(candidateRoot, entry));
	for (const entry of entries) {
		if (!contains(candidateRoot, entry)) {
			throw new Error(`Entry escapes candidate: ${entry}`);
		}
	}

	// Keep the event loop alive while awaiting the factory. A never-resolving
	// async factory would otherwise let Node exit "successfully" with no result
	// before the parent's hard deadline can classify it as a timeout.
	const keepAlive = setInterval(() => undefined, 1_000);
	// No real model or external network from preflight. Static imports above may
	// initialize the SDK, but plugin code is imported only after this point.
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error("RSI preflight forbids network access.");
	}) as typeof fetch;
	try {
		const loaded = await discoverAndLoadExtensions(
			entries,
			candidateRoot,
			resolve(candidateRoot, ".rsi-preflight-empty-agent"),
		);
		// During real Pi startup the ExtensionRunner binds these actions before
		// session_start. The Mock must do the same so valid extensions that call
		// getActiveTools/setActiveTools/getSettings are not falsely rejected.
		loaded.runtime.getActiveTools = () => [];
		loaded.runtime.setActiveTools = () => undefined;
		loaded.runtime.getAllTools = () => [];
		loaded.runtime.getSettings = () => ({}) as never;
		loaded.runtime.getCommands = () => [];
		loaded.runtime.getSessionName = () => undefined;
		loaded.runtime.setSessionName = () => undefined;
		loaded.runtime.sendMessage = () => undefined;
		loaded.runtime.sendUserMessage = () => undefined;
		loaded.runtime.appendEntry = () => undefined;
		loaded.runtime.setLabel = () => undefined;
		loaded.runtime.setModel = async () => false;
		loaded.runtime.getThinkingLevel = () => "off" as never;
		loaded.runtime.setThinkingLevel = () => undefined;
		loaded.runtime.refreshTools = () => undefined;
		loaded.runtime.assertActive = () => undefined;
		loaded.runtime.createContext = () => createMockContext(candidateRoot) as never;
		const errors = loaded.errors.map((error: { path: string; error: string }) => `Failed extension ${error.path}: ${error.error}`);
		const extensionCount = loaded.extensions.length;
		const loadedEntries: string[] = [];
		let tools = 0;
		let commands = 0;
		let flags = 0;
		let handlers = 0;
		let sessionStartHandlers = 0;
		for (const extension of loaded.extensions) {
			const real = await realpath(extension.resolvedPath).catch(() => resolve(extension.resolvedPath));
			if (!contains(candidateRoot, real)) {
				errors.push(`Loaded extension resolved outside the candidate snapshot: ${real}`);
			}
			if ((extension.handlers.get("before_provider_request") ?? []).length > 0) {
				errors.push(
					`Extension ${extension.resolvedPath} registers before_provider_request; candidate plugins may not mutate provider payloads.`,
				);
			}
			loadedEntries.push(real);
			tools += extension.tools.size;
			commands += extension.commands.size;
			flags += extension.flags.size;
			for (const list of extension.handlers.values()) handlers += list.length;
			const sessionStart = extension.handlers.get("session_start") ?? [];
			sessionStartHandlers += sessionStart.length;
			if (!(extension.handlers instanceof Map) || !(extension.tools instanceof Map) || !(extension.commands instanceof Map)) {
				errors.push(`Extension ${extension.resolvedPath} did not expose Pi registration containers.`);
			}
		}
		if (errors.length === 0) {
			const ctx = createMockContext(candidateRoot);
			const sessionEvent = { type: "session_start", reason: "startup" };
			const resourcesEvent = { type: "resources_discover", cwd: candidateRoot, reason: "startup" };
			for (const extension of loaded.extensions) {
				for (const handler of extension.handlers.get("session_start") ?? []) {
					await handler(sessionEvent, ctx);
				}
			}
			for (const extension of loaded.extensions) {
				for (const handler of extension.handlers.get("resources_discover") ?? []) {
					await handler(resourcesEvent, ctx);
				}
			}
			// Give timers scheduled by the factory/session_start a bounded chance to
			// throw. Longer timers are the real Worker Watchdog's concern.
			await new Promise((resolveWait) => setTimeout(resolveWait, Math.max(0, Math.min(settleMs, 1_000))));
		}
		const result: MockLoadWorkerResult = {
			kind: "mock",
			ok: errors.length === 0,
			errors,
			loadedEntries,
			extensionCount,
			registrations: { tools, commands, flags, handlers },
			sessionStartHandlers,
		};
		writeWorkerResult(resultPath, result);
		return result;
	} finally {
		globalThis.fetch = originalFetch;
		clearInterval(keepAlive);
	}
}

process.on("uncaughtException", (error) => {
	fail(process.env[PREFLIGHT_RESULT_ENV] ?? "", error, error.stack);
});
process.on("unhandledRejection", (reason) => {
	fail(
		process.env[PREFLIGHT_RESULT_ENV] ?? "",
		reason,
		reason instanceof Error ? reason.stack : undefined,
	);
});

try {
	const result = await main();
	if (!result.ok) process.exitCode = 1;
	// Plugin timers/intervals must not keep the preflight process alive.
	process.exit(result.ok ? 0 : 1);
} catch (error) {
	fail(
		process.env[PREFLIGHT_RESULT_ENV] ?? "",
		error,
		error instanceof Error ? error.stack : undefined,
	);
}
