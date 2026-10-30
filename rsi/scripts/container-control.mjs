#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMANDS = new Set(["reload", "shutdown", "cancelSleep"]);

function usage() {
	console.error(
		"Usage: container-control.mjs <reload|shutdown|cancelSleep|status> [--candidate ID] [--reason TEXT]",
	);
}

function parseArgs(argv) {
	const command = argv[0];
	if (!command) throw new Error("A command is required.");
	if (command === "status") {
		const rest = argv.slice(1);
		for (const arg of rest) {
			if (arg !== "--json") throw new Error(`Unknown status argument: ${arg}`);
		}
		return { command, json: rest.includes("--json") };
	}
	if (!COMMANDS.has(command)) throw new Error(`Unknown control command: ${command}`);
	const request = { command };
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--candidate") request.candidateId = argv[++index] ?? "";
		else if (arg === "--reason") request.reason = argv[++index] ?? "";
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (command === "reload" && request.candidateId !== undefined && request.candidateId.length === 0) {
		throw new Error("--candidate must not be empty.");
	}
	return { command, request };
}

async function showStatus(json) {
	const path = process.env.RSI_HEALTH_FILE ?? "/state/runtime/health.json";
	const health = JSON.parse(await readFile(path, "utf8"));
	if (json) {
		console.log(JSON.stringify(health, null, 2));
		return;
	}
	console.log(`supervisor pid=${health.supervisor?.pid} state=${health.supervisor?.state}`);
	console.log(`worker pid=${health.worker?.pid ?? "-"} state=${health.worker?.state} generation=${health.worker?.generation ?? "-"}`);
	console.log(`sleep active=${health.sleep?.active ? "yes" : "no"} deadline=${health.sleep?.deadlineMs ?? "-"}`);
	if (health.plugin) {
		console.log(
			`plugin generation=${health.plugin.generation ?? "-"} healthTurns=${health.plugin.healthTurns ?? "-"} lkg=${health.plugin.lkgGeneration ?? "-"}`,
		);
	}
	if (health.watchdog) console.log(`watchdog phase=${health.watchdog.phase ?? "-"}`);
}

function sendRequest(socketPath, request) {
	return new Promise((resolvePromise, reject) => {
		const id = randomUUID();
		const reason = typeof request.reason === "string" && request.reason.trim().length > 0
			? request.reason
			: `${request.command} requested by the operator`;
		const envelope = {
			protocol: "rsi-control",
			version: 1,
			type: "request",
			requestId: id,
			source: "supervisor",
			generation: null,
			sessionId: null,
			...(process.env.RSI_CONTROL_TOKEN ? { token: process.env.RSI_CONTROL_TOKEN } : {}),
			command: {
				kind: request.command,
				reason,
				...(typeof request.candidateId === "string" && request.candidateId.length > 0
					? { candidateId: request.candidateId }
					: {}),
			},
		};
		const socket = connect(socketPath);
		let buffer = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(new Error("operator control socket timed out after 15 seconds"));
		}, 15_000);
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolvePromise(value);
		};
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(`${JSON.stringify(envelope)}\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (buffer.length > 1_048_576) {
				finish(new Error("operator control response exceeded 1 MiB"));
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline);
			try {
				const response = JSON.parse(line);
				const legacy = response.protocol === undefined;
				const okId = legacy ? response.id === id : response.requestId === id;
				if (response.version !== 1 || !okId) {
					finish(new Error("operator control response id/version mismatch"));
				} else if (response.ok !== true) {
					finish(new Error(
						legacy
							? (response.error ?? "operator control request failed")
							: (response.error?.message ?? "operator control request failed"),
					));
				} else {
					finish(undefined, response);
				}
			} catch (error) {
				finish(new Error(`invalid operator control response: ${error instanceof Error ? error.message : error}`));
			}
		});
		socket.on("error", (error) => {
			if (error?.code === "ENOENT" || error?.code === "ECONNREFUSED") {
				finish(
					new Error(
						`operator control socket is unavailable at ${socketPath}. ` +
							"The trusted Supervisor must expose its private control socket; it is not published over TCP.",
					),
				);
			} else {
				finish(error);
			}
		});
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args.command === "status") {
			await showStatus(args.json);
		} else {
			const socketPath = process.env.RSI_CONTROL_SOCKET ?? "/state/control/operator.sock";
			const response = await sendRequest(socketPath, args.request);
			console.log(
				JSON.stringify(
					response.protocol === undefined
						? response
						: { ...response, detail: response.result?.detail, generation: response.result?.generation },
					null,
					2,
				),
			);
		}
	} catch (error) {
		console.error(`[rsi-control] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
