#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const { REQUIRED_PLUGIN_PINS } = await import(new URL("../src/shared/plugins.ts", import.meta.url).href);

function usage() {
	console.error(
		"Usage: install-plugins.mjs --agent-dir DIR [--source-root DIR] [--pi FILE] [--verify-only]",
	);
}

function parseArgs(argv) {
	const scriptRoot = resolve(scriptDir, "..");
	const options = {
		agentDir: undefined,
		sourceRoot: scriptRoot,
		pi: undefined,
		verifyOnly: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--agent-dir") options.agentDir = resolve(argv[++index] ?? "");
		else if (arg === "--source-root") options.sourceRoot = resolve(argv[++index] ?? "");
		else if (arg === "--pi") options.pi = resolve(argv[++index] ?? "");
		else if (arg === "--verify-only") options.verifyOnly = true;
		else if (arg === "--help" || arg === "-h") {
			usage();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!options.agentDir) throw new Error("--agent-dir is required.");
	options.pi ??= join(
		options.sourceRoot,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"bundle",
		"cli.js",
	);
	return options;
}

async function treeDigest(root) {
	const entries = [];
	async function walk(directory) {
		const list = await readdir(directory, { withFileTypes: true });
		list.sort((left, right) => left.name.localeCompare(right.name, "en"));
		for (const entry of list) {
			const path = join(directory, entry.name);
			const info = await lstat(path);
			const name = relative(root, path).split(sep).join("/");
			if (info.isSymbolicLink()) throw new Error(`Refusing symlink in installed package: ${name}`);
			if (info.isDirectory()) {
				entries.push(`d\t${name}`);
				await walk(path);
			} else if (info.isFile()) {
				const hash = createHash("sha256").update(await readFile(path)).digest("hex");
				entries.push(`f\t${name}\t${hash}`);
			} else {
				throw new Error(`Unsupported file type in installed package: ${name}`);
			}
		}
	}
	await walk(root);
	return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function normalizePackages(settings) {
	const packages = settings?.packages;
	if (!Array.isArray(packages)) return [];
	return packages.map((entry) => (typeof entry === "string" ? entry : entry?.source)).filter(Boolean);
}

export async function verifyAgentHome({ agentDir, sourceRoot }) {
	const resolvedAgentDir = await realpath(agentDir);
	const settingsPath = join(resolvedAgentDir, "settings.json");
	const settings = JSON.parse(await readFile(settingsPath, "utf8"));
	const configured = normalizePackages(settings);
	for (const pin of REQUIRED_PLUGIN_PINS) {
		if (!configured.includes(pin.piSpec)) {
			throw new Error(`Pi settings do not declare ${pin.piSpec}: ${settingsPath}`);
		}
		const installedRoot = join(resolvedAgentDir, "npm", "node_modules", pin.packageName);
		const manifestPath = join(installedRoot, "package.json");
		if (!existsSync(manifestPath)) throw new Error(`Installed package is missing: ${installedRoot}`);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		if (manifest.name !== pin.packageName || manifest.version !== pin.version) {
			throw new Error(
				`Installed manifest mismatch for ${pin.packageName}: ${manifest.name}@${manifest.version}, expected ${pin.version}`,
			);
		}
		if (!(manifest.pi?.extensions ?? []).includes(`./${pin.extension}`)) {
			throw new Error(`${pin.packageName}@${pin.version} does not declare ./${pin.extension}`);
		}
		const extensionPath = join(installedRoot, ...pin.extension.split("/"));
		if (!existsSync(extensionPath)) throw new Error(`Installed extension is missing: ${extensionPath}`);
		const lockedRoot = join(sourceRoot, "node_modules", pin.packageName);
		if (!existsSync(lockedRoot)) throw new Error(`Lock-verified package is missing: ${lockedRoot}`);
		const [installedDigest, lockedDigest] = await Promise.all([treeDigest(installedRoot), treeDigest(lockedRoot)]);
		if (installedDigest !== lockedDigest) {
			throw new Error(`${pin.packageName}@${pin.version} differs from the lock-verified package contents.`);
		}
	}
	const { DefaultResourceLoader } = await import(
		new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href
	);
	const loader = new DefaultResourceLoader({
		cwd: resolvedAgentDir,
		agentDir: resolvedAgentDir,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();
	const result = loader.getExtensions();
	if (result.errors.length > 0) {
		throw new Error(`Pi extension discovery errors:\n${result.errors.map((entry) => `${entry.path}: ${entry.error}`).join("\n")}`);
	}
	if (result.extensions.length !== REQUIRED_PLUGIN_PINS.length) {
		throw new Error(`Pi discovered ${result.extensions.length} extensions; expected ${REQUIRED_PLUGIN_PINS.length}.`);
	}
	const loadedPaths = result.extensions.map((extension) => resolve(resolvedAgentDir, extension.path));
	for (const pin of REQUIRED_PLUGIN_PINS) {
		const expected = join(resolvedAgentDir, "npm", "node_modules", pin.packageName, ...pin.extension.split("/"));
		if (!loadedPaths.includes(expected)) {
			throw new Error(`Pi did not load ${pin.packageName}@${pin.version} from ${expected}.`);
		}
	}
	return {
		settingsPath,
		extensions: result.extensions.map((extension) => extension.path),
	};
}

function runPiInstall(pi, spec, agentDir) {
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		npm_config_ignore_scripts: "true",
		NPM_CONFIG_IGNORE_SCRIPTS: "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
	};
	console.log(`[rsi-plugins] pi install ${spec} (PI_CODING_AGENT_DIR=${agentDir}, npm lifecycle scripts disabled)`);
	const result = spawnSync(process.execPath, [pi, "install", spec], { env, stdio: "inherit" });
	if (result.error) throw new Error(`Could not run pi install ${spec}: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`pi install ${spec} exited with ${result.status ?? "unknown"}`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!options.verifyOnly) {
		for (const pin of REQUIRED_PLUGIN_PINS) {
			if (!existsSync(options.pi)) throw new Error(`Pi CLI is missing: ${options.pi}`);
			runPiInstall(options.pi, pin.piSpec, options.agentDir);
		}
	}
	const verified = await verifyAgentHome({ agentDir: options.agentDir, sourceRoot: options.sourceRoot });
	console.log(`[rsi-plugins] verified Pi discovery loaded ${verified.extensions.length} extensions from ${verified.settingsPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(`[rsi-plugins] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
