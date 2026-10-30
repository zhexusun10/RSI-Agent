#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const shared = await import(new URL("../src/shared/index.ts", import.meta.url).href);
const sandbox = await import(new URL("../src/sandbox/preflight.ts", import.meta.url).href);

function usage() {
	console.error("Usage: deployment-preflight.mjs [--config FILE] [--config-only]");
}

function parseArgs(argv) {
	let configPath = process.env.RSI_CONFIG_PATH ?? "/state/runtime/rsi.config.json";
	let configOnly = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--config") configPath = resolve(argv[++index] ?? "");
		else if (arg === "--config-only") configOnly = true;
		else if (arg === "--help" || arg === "-h") {
			usage();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return { configPath, configOnly };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = parseArgs(process.argv.slice(2));
		const config = await shared.loadRsiConfigFile(args.configPath);
		await shared.verifyRuntimeLayout(config.paths);
		if (args.configOnly) {
			// Configuration-only mode must never look like a full sandbox pass.
			console.log(
				"[rsi-preflight] config-only: Worker NOT started; bwrap executable, namespaces, mount, " +
					"host/namespace UID/GID, supplementary groups, CapEff and fs.protected_hardlinks/symlinks " +
					"were NOT verified. This is not a complete preflight pass.",
			);
		} else {
			// This is the same report consumed by `rsi --check` and the launcher.
			// There is deliberately no second bwrap spawn or raw /proc probe here.
			const report = await sandbox.inspectConfiguredSandboxPreflight(config, {
				probeTimeoutMs: 20_000,
			});
			if (!report.ok) {
				throw new Error(`Bubblewrap preflight failed.\n${sandbox.formatPreflightReport(report)}`);
			}
			console.log(
				`[rsi-preflight] full sandbox preflight passed: ` +
					`host_uid=${report.observedHostUid ?? "unverified"}, namespace_uid=${report.observedNamespaceUid ?? "unverified"}, ` +
					`host_gid=${report.observedHostGid ?? "unverified"}, namespace_gid=${report.observedNamespaceGid ?? "unverified"}, ` +
					`CapEff=0, supplementary_groups=cleared, namespace=verified, mount=verified, ` +
					`protected_hardlinks=${report.protectedHardlinksEnabled}, protected_symlinks=${report.protectedSymlinksEnabled === true}, ` +
					`credential=${report.credentialStrategy}, seccompFd=${report.features.seccompFd}, nested_userns_blocked=${report.nestedUsernsBlocked === true}, ` +
					`version=${report.bwrapVersion ?? "unknown"}, bwrap=${report.bwrapPath ?? "unknown"}.`,
			);
		}
		console.log(`[rsi-preflight] configuration and external prompt verified: ${args.configPath}`);
	} catch (error) {
		const payload = error && typeof error === "object" && "code" in error ? error : undefined;
		if (payload?.code && payload?.message) {
			console.error(`[rsi-preflight] ${payload.code}: ${payload.message}`);
			if (payload.details !== undefined) console.error(`[rsi-preflight] details: ${JSON.stringify(payload.details)}`);
		} else {
			console.error(`[rsi-preflight] ${error instanceof Error ? error.message : String(error)}`);
		}
		process.exitCode = 1;
	}
}
