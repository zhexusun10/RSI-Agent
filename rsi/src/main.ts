#!/usr/bin/env node
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRsiConfigFile, type RsiConfig } from "./shared/config.ts";
import { isRsiError, RsiError } from "./shared/errors.ts";
import { verifyRuntimeLayout, type VerifiedRuntimeLayout } from "./shared/layout-verify.ts";
import { createBubblewrapLauncherForConfig } from "./sandbox/launcher.ts";
import {
	formatPreflightReport,
	inspectConfiguredSandboxPreflight,
} from "./sandbox/preflight.ts";
import type { BubblewrapPreflightReport } from "./sandbox/types.ts";
import { SupervisorRuntime } from "./integration/runtime.ts";
import { SANDBOX_PLUGIN_ROOT } from "./integration/reload-service.ts";

export const RSI_CLI_VERSION = "0.1.0";

export interface CliOptions {
	readonly mode: "check" | "start";
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
	for (const arg of argv) {
		if (arg === "--check" || arg === "check") return { mode: "check" };
		if (arg === "--start" || arg === "start") return { mode: "start" };
		if (arg === "--help" || arg === "-h") {
			console.log(
				[
					"RSI-Agent Supervisor",
					"",
					"Usage:",
					"  rsi --start    Start the real bwrap Worker runtime (default)",
					"  rsi --check    Run the complete sandbox preflight (bwrap, Host Worker UID/GID, groups, namespaces, mount, CapEff, sysctls); never starts the Worker",
					"  rsi --help",
					"",
					"Required environment: RSI_CONFIG_PATH, plus the manual prompt path in that config.",
				].join("\n"),
			);
			process.exit(0);
		}
		throw new RsiError(
			"CONFIG_INVALID",
			`Unknown argument: ${arg}. Use --start, --check, or --help.`,
		);
	}
	return { mode: "start" };
}

export function formatError(error: unknown): string {
	if (isRsiError(error)) {
		const details = error.details === undefined ? "" : `\n details: ${JSON.stringify(error.details)}`;
		return `[rsi] ${error.code}: ${error.message}${details}${error.stack === undefined ? "" : `\n${error.stack}`}`;
	}
	return `[rsi] ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
}

async function ensurePluginDirectory(path: string): Promise<void> {
	const { mkdir, chmod } = await import("node:fs/promises");
	await mkdir(path, { recursive: true });
	await chmod(path, 0o777).catch(() => undefined);
}

async function requireReadable(path: string, label: string): Promise<void> {
	try {
		await access(path);
	} catch (error) {
		throw new RsiError("CONFIG_INVALID", `${label} is not readable: ${path}`, { cause: error });
	}
}

async function checkBubblewrap(config: RsiConfig): Promise<BubblewrapPreflightReport> {
	const report = await inspectConfiguredSandboxPreflight(config, {
		supervisorUid: typeof process.geteuid === "function" ? process.geteuid() : 1,
		supervisorGid: typeof process.getegid === "function" ? process.getegid() : 1,
	});
	if (!report.ok) {
		throw new RsiError("SANDBOX_INVALID", `Bubblewrap preflight failed.\n${formatPreflightReport(report)}`, {
			details: {
				errors: [...report.errors],
				checks: report.checks.map((check) => ({
					name: check.name,
					ok: check.ok,
					message: check.message,
					...(check.hint === undefined ? {} : { hint: check.hint }),
				})),
			},
		});
	}
	console.error(formatPreflightReport(report));
	return report;
}

async function loadConfig(): Promise<RsiConfig> {
	const configPath = process.env.RSI_CONFIG_PATH;
	if (configPath === undefined || configPath.length === 0) {
		throw new RsiError("CONFIG_INVALID", "RSI_CONFIG_PATH is not set.");
	}
	return await loadRsiConfigFile(configPath);
}

async function startRuntime(config: RsiConfig, verified: VerifiedRuntimeLayout): Promise<SupervisorRuntime> {
	if (typeof process.geteuid === "function" && process.geteuid() !== 0) {
		throw new RsiError(
			"SANDBOX_INVALID",
			"The Supervisor must run as root inside its constrained container so it can start bwrap as the distinct Worker UID. There is no unsandboxed fallback.",
		);
	}
	await checkBubblewrap(config);
	const configured = createBubblewrapLauncherForConfig(config, verified, {
		readOnlyMounts: [
			{ source: config.paths.snapshotDir, target: SANDBOX_PLUGIN_ROOT, mode: "ro" },
		],
		terminationGraceMs: 2_000,
		killWaitMs: 2_000,
		maxStdoutBytes: 4 * 1024 * 1024,
		maxStderrBytes: 4 * 1024 * 1024,
	});
	const runtime = new SupervisorRuntime({
		config,
		verified,
		launcher: configured.launcher,
		policy: configured.policy,
		sandboxed: true,
		installSignalHandlers: true,
		controlToken: process.env.RSI_CONTROL_TOKEN,
	});
	try {
		await runtime.start();
		return runtime;
	} catch (error) {
		await runtime.stop("startup failed").catch(() => undefined);
		throw error;
	}
}

export async function runCli(argv: readonly string[]): Promise<number> {
	const options = parseCliArgs(argv);
	const config = await loadConfig();
	await ensurePluginDirectory(config.paths.pluginSourceDir);
	await requireReadable(config.paths.systemPromptFile, "Manual system prompt");
	const verified = await verifyRuntimeLayout(config.paths);
	if (options.mode === "check") {
		const report = await checkBubblewrap(config);
		console.log(
			`rsi --check: configuration, external prompt, protected layout and the complete sandbox preflight passed ` +
				`(namespace_verified=${report.namespaceVerified === true}, mount_verified=${report.mountVerified === true}, ` +
				`host_uid=${report.observedHostUid ?? "unverified"}, namespace_uid=${report.observedNamespaceUid ?? "unverified"}, ` +
				`CapEff=0, supplementary_groups=cleared, protected_hardlinks=1, protected_symlinks=1). ` +
				"The Worker was NOT started; this validates the real sandbox probe, not a running Worker.",
		);
		return 0;
	}
	await startRuntime(config, verified);
	// The listener, timers and Worker keep the event loop alive. Signals perform
	// the ordered shutdown in SupervisorRuntime.
	return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const code = await runCli(process.argv.slice(2));
		process.exitCode = code;
	} catch (error) {
		console.error(formatError(error));
		process.exitCode = 78;
	}
}
