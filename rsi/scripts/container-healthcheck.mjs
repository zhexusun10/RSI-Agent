#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEALTH_VERSION = 1;
const SUPERVISOR_STATES = new Set(["running"]);
const WORKER_STATES = new Set(["starting", "healthy", "sleeping", "restarting", "stopped", "failed"]);

function fail(message) {
	console.error(`unhealthy: ${message}`);
	process.exit(1);
}

function isFiniteInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPidAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

export function evaluateHealth(health, nowMs, maxAgeMs) {
	if (health === null || typeof health !== "object" || Array.isArray(health)) return "health file must be an object";
	if (health.version !== HEALTH_VERSION) return `unsupported health version: ${String(health.version)}`;
	if (!isFiniteInteger(health.updatedAtMs)) return "updatedAtMs must be a non-negative integer";
	if (health.updatedAtMs > nowMs + 5_000) return "updatedAtMs is in the future";
	if (nowMs - health.updatedAtMs > maxAgeMs) return `health status is stale (${nowMs - health.updatedAtMs} ms old)`;
	const supervisor = health.supervisor;
	if (!supervisor || typeof supervisor !== "object") return "supervisor status is missing";
	if (!SUPERVISOR_STATES.has(supervisor.state)) return `supervisor is not running (${String(supervisor.state)})`;
	if (!isPidAlive(supervisor.pid)) return `supervisor pid ${String(supervisor.pid)} is not alive`;
	const worker = health.worker;
	if (!worker || typeof worker !== "object") return "worker status is missing";
	if (!WORKER_STATES.has(worker.state)) return `unknown worker state: ${String(worker.state)}`;
	const sleep = health.sleep;
	if (worker.state === "sleeping") {
		if (!sleep || typeof sleep !== "object" || sleep.active !== true) return "worker is sleeping but sleep.active is not true";
		if (!isFiniteInteger(sleep.deadlineMs)) return "sleep deadline is missing";
		if (sleep.deadlineMs <= nowMs) return "sleep deadline has passed but the Supervisor has not resumed work";
	} else if (worker.state === "healthy") {
		if (!isPidAlive(worker.pid)) return `worker pid ${String(worker.pid)} is not alive`;
	} else {
		return `worker is not healthy (${worker.state})`;
	}
	if (health.watchdog && typeof health.watchdog === "object") {
		if (health.watchdog.phase === "rollback" || health.watchdog.phase === "suspect") {
			return `watchdog phase is ${health.watchdog.phase}`;
		}
	}
	return undefined;
}

async function main() {
	const healthPath = process.env.RSI_HEALTH_FILE ?? "/state/runtime/health.json";
	const maxAgeMs = Number(process.env.RSI_HEALTH_MAX_AGE_MS ?? "45000");
	if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 5_000) fail("RSI_HEALTH_MAX_AGE_MS must be at least 5000");
	let raw;
	try {
		raw = await readFile(healthPath, "utf8");
	} catch (error) {
		fail(`cannot read ${healthPath}: ${error?.code ?? error}`);
	}
	let health;
	try {
		health = JSON.parse(raw);
	} catch {
		fail(`health file is not valid JSON: ${healthPath}`);
	}
	const problem = evaluateHealth(health, Date.now(), maxAgeMs);
	if (problem) fail(problem);
	const worker = health.worker.state === "sleeping" ? "sleeping" : `healthy pid=${health.worker.pid}`;
	console.log(`healthy: supervisor pid=${health.supervisor.pid}, worker ${worker}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
