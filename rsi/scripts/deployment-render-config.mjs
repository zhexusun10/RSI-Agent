#!/usr/bin/env node
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultTemplate = resolve(scriptDir, "../deploy/rsi.config.template.json");

function usage() {
	console.error("Usage: deployment-render-config.mjs [--template FILE] [--out FILE]");
}

function parseArgs(argv) {
	let template = defaultTemplate;
	let out;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--template") template = resolve(argv[++index] ?? "");
		else if (arg === "--out") out = resolve(argv[++index] ?? "");
		else if (arg === "--help" || arg === "-h") {
			usage();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!out) throw new Error("--out is required.");
	return { template, out };
}

function validTimeZone(value) {
	if (!value || value.trim() !== value) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
		return true;
	} catch {
		return false;
	}
}

function integerEnv(name, fallback) {
	const raw = process.env[name] ?? String(fallback);
	if (!/^[1-9]\d{0,9}$/.test(raw)) {
		throw new Error(`${name} must be a positive decimal integer.`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value > 4_294_967_294) {
		throw new Error(`${name} is outside the Linux uid/gid range.`);
	}
	return value;
}

function replaceTokens(text, values) {
	return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name) => {
		if (!(name in values)) throw new Error(`Unsupported template token: \${${name}}`);
		return values[name];
	});
}

export async function renderConfig({ template, out }) {
	const timeZone = process.env.RSI_TIME_ZONE ?? process.env.TZ ?? "UTC";
	if (!validTimeZone(timeZone)) throw new Error(`Invalid IANA time zone: ${timeZone}`);
	const workerUid = integerEnv("RSI_WORKER_UID", 10002);
	const workerGid = integerEnv("RSI_WORKER_GID", 10002);
	if (typeof process.geteuid === "function" && process.geteuid() === workerUid) {
		throw new Error("RSI_WORKER_UID must differ from the Supervisor uid.");
	}
	if (typeof process.getegid === "function" && process.getegid() === workerGid) {
		throw new Error("RSI_WORKER_GID must differ from the Supervisor gid.");
	}
	const source = await readFile(template, "utf8");
	const rendered = replaceTokens(source, {
		RSI_TIME_ZONE: JSON.stringify(timeZone),
		RSI_WORKER_UID: String(workerUid),
		RSI_WORKER_GID: String(workerGid),
	});
	let parsed;
	try {
		parsed = JSON.parse(rendered);
	} catch (error) {
		throw new Error(`Rendered configuration is not valid JSON: ${error instanceof Error ? error.message : error}`);
	}
	if (parsed?.version !== 1) throw new Error("Rendered configuration must use version 1.");
	if (parsed?.sandbox?.network !== "unrestricted") {
		throw new Error("Deployment configuration may not restrict the network; sandbox.network must be 'unrestricted'.");
	}
	await mkdir(dirname(out), { recursive: true, mode: 0o700 });
	const existing = await lstat(out).catch((error) => {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	});
	if (existing?.isSymbolicLink()) throw new Error(`Refusing to replace a symlink: ${out}`);
	const temporary = `${out}.tmp.${process.pid}`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(parsed, null, "\t")}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, out);
	} finally {
		await rm(temporary, { force: true });
	}
	return parsed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = parseArgs(process.argv.slice(2));
		await renderConfig(args);
		console.log(`Rendered deployment configuration: ${args.out}`);
	} catch (error) {
		console.error(`[rsi-config] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
