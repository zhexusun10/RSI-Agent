#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 18080;
const DEFAULT_MODEL = "rsi-entrypoint-mock-model";

export function createProductionEntrypointMockProvider(options = {}) {
	const captureDir = resolve(options.captureDir ?? "/run/rsi-entrypoint-capture");
	const fixtureDir = resolve(options.fixtureDir ?? "/run/rsi-entrypoint-fixture");
	const host = options.host ?? "0.0.0.0";
	const port = Number(options.port ?? DEFAULT_PORT);
	const scenarioPath = join(fixtureDir, "scenario.json");
	const capturePath = join(captureDir, "requests.jsonl");
	const readyPath = join(captureDir, "mock-ready.json");
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid mock provider port: ${String(options.port)}`);
	}
	mkdirSync(captureDir, { recursive: true, mode: 0o777 });
	const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
	if (
		scenario === null ||
		typeof scenario !== "object" ||
		typeof scenario.memoryMarker !== "string" ||
		scenario.memoryMarker.length === 0 ||
		typeof scenario.probeCommand !== "string" ||
		typeof scenario.sleepDuration !== "string"
	) {
		throw new Error(`Invalid production entrypoint mock scenario: ${scenarioPath}`);
	}
	writeFileSync(capturePath, "", { mode: 0o666 });
	let requestIndex = 0;
	let listeningPort = null;

	function textOf(content) {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part !== null && typeof part === "object" && typeof part.text === "string") return part.text;
				return "";
			})
			.join("\n");
	}

	function captureRequest(body) {
		const messages = Array.isArray(body?.messages) ? body.messages : [];
		const tools = Array.isArray(body?.tools)
			? body.tools
					.map((tool) => tool?.function?.name ?? tool?.name)
					.filter((name) => typeof name === "string" && name.length > 0)
			: [];
		const mappedMessages = messages.map((message) => ({
			role: typeof message?.role === "string" ? message.role : "unknown",
			name: typeof message?.name === "string" ? message.name : undefined,
			toolCallId: typeof message?.tool_call_id === "string" ? message.tool_call_id : undefined,
			text: textOf(message?.content),
			toolCalls: Array.isArray(message?.tool_calls)
				? message.tool_calls.map((call) => ({
						id: call?.id,
						name: call?.function?.name,
						arguments: call?.function?.arguments,
					}))
				: undefined,
		}));
		const record = {
			index: requestIndex,
			atMs: Date.now(),
			model: typeof body?.model === "string" ? body.model : null,
			stream: body?.stream === true,
			toolNames: tools,
			system: messages
				.filter((message) => message?.role === "system" || message?.role === "developer")
				.map((message) => textOf(message?.content))
				.join("\n\n"),
			messages: mappedMessages,
		};
		appendFileSync(capturePath, `${JSON.stringify(record)}\n`, "utf8");
		return record;
	}

	function toolCall(id, name, args) {
		return { id, name, arguments: JSON.stringify(args) };
	}

	function responseFor(index, record) {
		if (index === 0) {
			return {
				kind: "tool_calls",
				toolCalls: [
					toolCall("pe-sandbox-probe", "bash", { command: scenario.probeCommand }),
					toolCall("pe-read-index", "read", { path: "/data/markdowns/index.md" }),
					toolCall("pe-write-memory", "write", {
						path: "/data/markdowns/Memory.md",
						content: `${scenario.memoryMarker}\n`,
					}),
					toolCall("pe-write-task", "write", {
						path: "/data/workspace/production-entrypoint-task.txt",
						content: `${scenario.memoryMarker}:TASK\n`,
					}),
				],
			};
		}
		if (index === 1) {
			return {
				kind: "tool_calls",
				toolCalls: [toolCall("pe-sleep", "sleep", { duration: scenario.sleepDuration })],
			};
		}
		if (index === 2) {
			return { kind: "text", text: "PRODUCTION-ENTRYPOINT-OPERATOR-CANCEL-WAKE" };
		}
		if (record.system.includes(scenario.memoryMarker)) {
			return {
				kind: "tool_calls",
				toolCalls: [toolCall(`pe-sleep-park-${index}`, "sleep", { duration: scenario.sleepDuration })],
			};
		}
		return { kind: "text", text: "PRODUCTION-ENTRYPOINT-MOCK-IDLE" };
	}

	function sendChunk(response, model, delta, finishReason = null) {
		const chunk = {
			id: "chatcmpl-rsi-entrypoint-mock",
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1_000),
			model,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		};
		response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	}

	function writeSse(response, record) {
		const model = record.model ?? DEFAULT_MODEL;
		const selected = responseFor(record.index, record);
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
		});
		sendChunk(response, model, { role: "assistant", content: "" });
		if (selected.kind === "text") {
			sendChunk(response, model, { content: selected.text });
			sendChunk(response, model, {}, "stop");
		} else {
			for (let index = 0; index < selected.toolCalls.length; index += 1) {
				const call = selected.toolCalls[index];
				sendChunk(response, model, {
					tool_calls: [
						{
							index,
							id: call.id,
							type: "function",
							function: { name: call.name, arguments: call.arguments },
						},
					],
				});
			}
			sendChunk(response, model, {}, "tool_calls");
		}
		response.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-rsi-entrypoint-mock",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1_000),
				model,
				choices: [],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			})}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	}

	const server = createServer((request, response) => {
		if (request.method === "GET" && request.url === "/health") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(`${JSON.stringify({ ok: true, requests: requestIndex, port: listeningPort })}\n`);
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404, { "content-type": "application/json" });
			response.end('{"error":"not found"}\n');
			return;
		}
		const chunks = [];
		let bytes = 0;
		request.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > 8 * 1024 * 1024) {
				response.writeHead(413, { "content-type": "application/json" });
				response.end('{"error":"request too large"}\n');
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (response.writableEnded) return;
			let body;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				response.writeHead(400, { "content-type": "application/json" });
				response.end('{"error":"invalid json"}\n');
				return;
			}
			const record = captureRequest(body);
			requestIndex += 1;
			writeSse(response, record);
		});
		request.on("error", () => {
			if (!response.writableEnded) response.destroy();
		});
	});

	return {
		server,
		capturePath,
		readyPath,
		get requestIndex() {
			return requestIndex;
		},
		async start() {
			await new Promise((resolveStart, rejectStart) => {
				server.once("error", rejectStart);
				server.listen(port, host, () => {
					server.off("error", rejectStart);
					const address = server.address();
					listeningPort = typeof address === "object" && address !== null ? address.port : port;
					writeFileSync(
						readyPath,
						`${JSON.stringify({ ready: true, host, port: listeningPort, pid: process.pid })}\n`,
						{ mode: 0o644 },
					);
					resolveStart();
				});
			});
			return this;
		},
		async close() {
			if (!server.listening) return;
			await new Promise((resolveClose) => server.close(() => resolveClose()));
		},
	};
}

async function main() {
	const args = process.argv.slice(2);
	let port = Number(process.env.RSI_ENTRYPOINT_MOCK_PORT ?? DEFAULT_PORT);
	let captureDir = process.env.RSI_ENTRYPOINT_CAPTURE_DIR ?? "/run/rsi-entrypoint-capture";
	let fixtureDir = process.env.RSI_ENTRYPOINT_FIXTURE_DIR ?? "/run/rsi-entrypoint-fixture";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--port") port = Number(args[++index]);
		else if (arg === "--capture-dir") captureDir = resolve(args[++index] ?? "");
		else if (arg === "--fixture-dir") fixtureDir = resolve(args[++index] ?? "");
		else if (arg === "--help" || arg === "-h") {
			console.log("Usage: production-entrypoint-mock-provider.mjs [--port N] [--capture-dir DIR] [--fixture-dir DIR]");
			return;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	const provider = createProductionEntrypointMockProvider({ port, captureDir, fixtureDir });
	await provider.start();
	console.log(`[rsi-mock-provider] listening on ${port} capture=${captureDir}`);
	const shutdown = async () => {
		await provider.close().catch(() => undefined);
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main().catch((error) => {
		console.error(`[rsi-mock-provider] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
