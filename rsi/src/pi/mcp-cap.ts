import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createMcpExtension,
	type ExtensionFactory,
	type RegisteredMcpServer,
} from "@earendil-works/pi-coding-agent";
import { RsiError } from "../shared/errors.ts";
import { MAX_MCP_SERVERS } from "../shared/policy.ts";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";

interface NativeMcpEntry {
	readonly name: string;
	readonly config: McpServerConfig;
	readonly source: string;
	readonly scope?: "global" | "project" | "extension";
}
interface NativeLoadedMcpConfig {
	readonly servers: NativeMcpEntry[];
	readonly errors: string[];
	readonly autoEnableCodemode?: boolean;
	readonly projectConfig?: string;
}
type NativeMcpConfigModule = {
	loadMcpConfig(options: {
		agentDir: string;
		cwd: string;
		projectTrusted: boolean;
	}): NativeLoadedMcpConfig;
};

async function importNativeMcpConfig(): Promise<NativeMcpConfigModule> {
	// The published SDK exports only the MCP config *types*. The pinned 1.4.0
	// package ships this loader, and using it keeps merge/precedence semantics
	// identical to Pi instead of inventing a second config dialect.
	const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const modulePath = resolve(dirname(sdkEntry), "extensions", "mcp", "config.js");
	return (await import(pathToFileURL(modulePath).href)) as NativeMcpConfigModule;
}

export interface McpCapState {
	readonly cap: number;
	configuredNames: Set<string>;
	lastError: RsiError | undefined;
}

export function createMcpCapState(cap = MAX_MCP_SERVERS): McpCapState {
	return { cap, configuredNames: new Set(), lastError: undefined };
}

/** Reject an invalid or oversized native MCP configuration before a queued reload. */
export async function assertMcpConfigurationAllowed(input: {
	readonly agentDir: string;
	readonly cwd: string;
	readonly projectTrusted: boolean;
}): Promise<void> {
	const native = await importNativeMcpConfig();
	const loaded = native.loadMcpConfig(input);
	if (loaded.errors.length > 0) {
		throw new RsiError("PREFLIGHT_FAILED", `MCP configuration is invalid: ${loaded.errors.join("; ")}`);
	}
	const names = new Set(loaded.servers.map((server) => server.name));
	if (names.size > MAX_MCP_SERVERS) {
		throw new RsiError(
			"RESOURCE_CAP_EXCEEDED",
			`At most ${MAX_MCP_SERVERS} MCP servers may be configured; found ${names.size} before reload.`,
			{ details: { count: names.size, max: MAX_MCP_SERVERS, servers: [...names].sort() } },
		);
	}
}

export function assertMcpRegistrationWithinCap(
	state: McpCapState,
	registry: { get(name: string): unknown; list(): RegisteredMcpServer[] },
	serverName: string,
): void {
	const existing = registry.get(serverName);
	const names = new Set(registry.list().map((server) => server.name));
	names.delete(serverName);
	if (existing === undefined) names.add(serverName);
	for (const name of state.configuredNames) names.add(name);
	if (names.size > state.cap) {
		const error = new RsiError(
			"RESOURCE_CAP_EXCEEDED",
			`At most ${state.cap} MCP servers may be configured (attempted ${names.size}).`,
			{ details: { count: names.size, max: state.cap, servers: [...names].sort() } },
		);
		state.lastError = error;
		throw error;
	}
}

/** Enforce the dynamic `pi.registerMcpServer()` path before the registry mutates or connects. */
export function installMcpRegistrationCap(
	state: McpCapState,
	registry: {
		get(name: string): unknown;
		list(): RegisteredMcpServer[];
		register(server: RegisteredMcpServer): void;
	},
): void {
	const marker = Symbol.for("rsi.mcpCapInstalled");
	const mutable = registry as unknown as Record<PropertyKey, unknown>;
	if (mutable[marker] === true) return;
	mutable[marker] = true;
	const originalRegister = registry.register.bind(registry);
	registry.register = (server: RegisteredMcpServer) => {
		assertMcpRegistrationWithinCap(state, registry, server.name);
		originalRegister(server);
	};
}

/**
 * Native built-in MCP extension with a pre-activation cap. Config and dynamically
 * registered servers are counted as one final namespace before any connection
 * starts; six are an explicit error, never a silent slice or a late disconnect.
 */
export function createCappedMcpExtension(
	state: McpCapState,
	nativeConfig: NativeMcpConfigModule,
	agentDir: string,
): ExtensionFactory {
	return (pi) => {
		const native = createMcpExtension({
			loadConfig: (ctx) => {
				state.lastError = undefined;
				const loaded = nativeConfig.loadMcpConfig({
					agentDir,
					cwd: ctx.cwd,
					projectTrusted: ctx.isProjectTrusted(),
				});
				state.configuredNames = new Set(loaded.servers.map((entry) => entry.name));
				const registered = pi.getMcpServers().map((server) => server.name);
				const names = new Set([...state.configuredNames, ...registered]);
				if (names.size > state.cap) {
					const error = new RsiError(
						"RESOURCE_CAP_EXCEEDED",
						`At most ${state.cap} MCP servers may be configured; found ${names.size} before connection.`,
						{ details: { count: names.size, max: state.cap, servers: [...names].sort() } },
					);
					state.lastError = error;
					throw error;
				}
				return loaded as never;
			},
		});
		return native(pi);
	};
}

export async function createNativeMcpExtensionFactory(
	state: McpCapState,
	agentDir: string,
): Promise<ExtensionFactory> {
	const config = await importNativeMcpConfig();
	return createCappedMcpExtension(state, config, agentDir);
}
