#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, chownSync, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { rotateLogs, DEFAULT_MAX_BYTES, DEFAULT_KEEP_FILES } from "./deployment-log-rotate.mjs";

const entry = resolve(process.env.RSI_SUPERVISOR_ENTRY ?? "/opt/rsi/src/main.ts");
const logsDir = resolve(process.env.RSI_LOGS_DIR ?? "/state/logs");
const maxBytes = Number(process.env.RSI_LOG_MAX_BYTES ?? DEFAULT_MAX_BYTES);
const keepFiles = Number(process.env.RSI_LOG_KEEP_FILES ?? DEFAULT_KEEP_FILES);
const rotateIntervalMs = Number(process.env.RSI_LOG_ROTATE_MS ?? 30_000);
const graceMs = Number(process.env.RSI_SHUTDOWN_GRACE_MS ?? 20_000);
const workerSocket = resolve(process.env.RSI_IPC_SOCKET ?? "/state/run/worker.sock");
const workerGid = Number(process.env.RSI_WORKER_GID ?? 10002);

if (!existsSync(entry)) {
	console.error(
		`[rsi-run] Supervisor entry is missing: ${entry}\n` +
			"[rsi-run] Provide the Supervisor entry or set RSI_SUPERVISOR_ENTRY. " +
			"No fallback process will be started.",
	);
	process.exit(78);
}
if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
	console.error("[rsi-run] RSI_LOG_MAX_BYTES must be a positive integer.");
	process.exit(78);
}
if (!Number.isSafeInteger(keepFiles) || keepFiles < 2) {
	console.error("[rsi-run] RSI_LOG_KEEP_FILES must be an integer >= 2.");
	process.exit(78);
}
if (!Number.isSafeInteger(rotateIntervalMs) || rotateIntervalMs < 1_000) {
	console.error("[rsi-run] RSI_LOG_ROTATE_MS must be an integer >= 1000.");
	process.exit(78);
}
if (!Number.isSafeInteger(graceMs) || graceMs < 1_000) {
	console.error("[rsi-run] RSI_SHUTDOWN_GRACE_MS must be an integer >= 1000.");
	process.exit(78);
}

const posix = process.platform !== "win32";
const child = spawn(process.execPath, [entry], {
	cwd: process.cwd(),
	env: process.env,
	stdio: "inherit",
	detached: posix,
});
let stopping = false;
let forceTimer;
let rotationBusy = false;
let lastRotationError = "";
let lastRotationErrorAt = 0;
let lastSocketError = "";
let lastSocketErrorAt = 0;

function listDescendants(rootPid) {
	const parents = new Map();
	try {
		for (const entry of readdirSync("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			const end = stat.lastIndexOf(")");
			if (end === -1) continue;
			const fields = stat.slice(end + 2).split(" ");
			const ppid = Number(fields[1]);
			if (Number.isSafeInteger(ppid)) parents.set(Number(entry), ppid);
		}
	} catch {
		return [];
	}
	const descendants = [];
	const queue = [rootPid];
	while (queue.length > 0) {
		const parent = queue.shift();
		for (const [pid, ppid] of parents) {
			if (ppid === parent && !descendants.includes(pid)) {
				descendants.push(pid);
				queue.push(pid);
			}
		}
	}
	return descendants.reverse();
}

function signalChild(signal, tree = false) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (posix) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch (error) {
		if (error?.code !== "ESRCH") console.error(`[rsi-run] could not send ${signal}: ${error.message}`);
	}
	if (!tree || !posix) return;
	for (const pid of listDescendants(child.pid)) {
		try {
			process.kill(pid, signal);
		} catch (error) {
			if (error?.code !== "ESRCH") console.error(`[rsi-run] could not signal descendant ${pid}: ${error.message}`);
		}
	}
}

function stop(signal) {
	if (stopping) return;
	stopping = true;
	clearInterval(rotationTimer);
	if (socketTimer) clearInterval(socketTimer);
	signalChild(signal);
	forceTimer = setTimeout(() => {
		console.error(`[rsi-run] Supervisor did not exit within ${graceMs} ms; sending SIGKILL to its process tree.`);
		signalChild("SIGKILL", true);
	}, graceMs);
}

async function rotateOnce() {
	if (rotationBusy) return;
	rotationBusy = true;
	try {
		const result = await rotateLogs({ dir: logsDir, maxBytes, keepFiles });
		for (const entry of result.rotated) {
			console.error(`[rsi-run] rotated ${entry.path} (${entry.previousBytes} bytes)`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const now = Date.now();
		if (message !== lastRotationError || now - lastRotationErrorAt > 300_000) {
			console.error(`[rsi-run] log rotation failed: ${message}`);
			lastRotationError = message;
			lastRotationErrorAt = now;
		}
	} finally {
		rotationBusy = false;
	}
}

function allowWorkerSocket() {
	if (!posix) return;
	try {
		const info = lstatSync(workerSocket);
		if (!info.isSocket()) return;
		chmodSync(workerSocket, 0o660);
		if (typeof process.getuid === "function") chownSync(workerSocket, process.getuid(), workerGid);
	} catch (error) {
		if (error?.code === "ENOENT") return;
		const now = Date.now();
		if (error.message !== lastSocketError || now - lastSocketErrorAt > 300_000) {
			console.error(`[rsi-run] cannot set Worker socket permissions: ${error.message}`);
			lastSocketError = error.message;
			lastSocketErrorAt = now;
		}
	}
}

const rotationTimer = setInterval(rotateOnce, rotateIntervalMs);
rotationTimer.unref();
const socketTimer = posix ? setInterval(allowWorkerSocket, 1_000) : undefined;
socketTimer?.unref();
allowWorkerSocket();
void rotateOnce();

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

child.on("error", (error) => {
	console.error(`[rsi-run] failed to start ${entry}: ${error.message}`);
	clearInterval(rotationTimer);
	if (socketTimer) clearInterval(socketTimer);
	process.exitCode = 1;
});

child.on("exit", (code, signal) => {
	if (forceTimer) clearTimeout(forceTimer);
	clearInterval(rotationTimer);
	if (socketTimer) clearInterval(socketTimer);
	if (stopping) {
		process.exit(0);
	}
	if (signal) {
		console.error(`[rsi-run] Supervisor terminated by ${signal}.`);
		process.exitCode = 1;
	} else {
		process.exitCode = code ?? 1;
	}
});
