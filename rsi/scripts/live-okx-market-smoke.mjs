#!/usr/bin/env node
// Read-only public market-data test: real model -> Pi -> official OKX demo MCP.
// No OKX credentials or orders. Run after building rsi-agent:local.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const key = process.env.CLINE_API_KEY;
if (!key) throw new Error("CLINE_API_KEY is required; do not put it on the command line.");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const image = process.env.RSI_SMOKE_IMAGE || "rsi-agent:local";
const timeoutMs = Number(process.env.RSI_SMOKE_TIMEOUT_MS || 240000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 600000) throw new Error("RSI_SMOKE_TIMEOUT_MS must be 30000..600000.");
const suffix = randomBytes(6).toString("hex");
const container = `rsi-okx-smoke-${suffix}`;
const volumes = ["prompt", "data", "state"].map((name) => `rsi-okx-smoke-${name}-${suffix}`);
const prompt = "You are performing a bounded read-only integration test. Use mcp__okx_demo__market_get_ticker with instId BTC-USDT and demo true. If the request has a transient error, retry it. After a successful result, call sleep for 10m. Do not place any trades, use bash, or reveal credentials.";
const mcp = { mcpServers: { "okx-demo": { exposure: "direct", command: "npx", args: ["--yes", "@okx_ai/okx-trade-mcp@1.5.0", "--demo", "--modules", "market", "--read-only"], description: "Read-only OKX simulated public market data." } } };
const redact = (value) => String(value).split(key).join("[REDACTED]");
function docker(args, options = {}) {
	try {
		return execFileSync("docker", args, { encoding: "utf8", timeout: options.timeout ?? 30000, env: process.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (error) {
		if (options.ignore) return "";
		throw new Error(redact(error.stderr || error.message));
	}
}
const probe = `const fs=require('fs'),path=require('path');let health={};try{health=JSON.parse(fs.readFileSync('/state/runtime/health.json','utf8'))}catch{};function walk(p){let a=[];try{for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);if(e.isDirectory())a.push(...walk(q));else if(e.isFile()&&e.name.endsWith('.jsonl'))a.push(fs.readFileSync(q,'utf8'))}}catch{}return a}const files=walk('/data/pi-sessions');let records=[];for(const line of files.join('\\n').split('\\n'))try{records.push(JSON.parse(line))}catch{};const ids=new Set(records.flatMap(x=>x.message?.role==='assistant'?(x.message.content||[]).filter(p=>p.type==='toolCall'&&p.name==='mcp__okx_demo__market_get_ticker'&&p.arguments?.instId==='BTC-USDT'&&p.arguments?.demo===true).map(p=>p.id):[]));let ok=false,timestamp=false;for(const x of records){const m=x.message;if(m?.role!=='toolResult'||!ids.has(m.toolCallId)||m.isError)continue;const text=(m.content||[]).map(p=>p.text||'').join('\\n');if(/"ok"\\s*:\\s*true/i.test(text)&&/BTC-USDT/i.test(text)){ok=true;timestamp=/Current Time: \\d{4}\\/\\d{2}\\/\\d{2}/.test(text)}}const events=records.slice(-12).map(x=>({type:x.type,role:x.message?.role,tool:x.message?.toolName,stop:x.message?.stopReason,error:x.message?.errorMessage}));let stderr='';try{stderr=fs.readFileSync('/state/logs/worker-stderr.log','utf8').slice(-3000)}catch{};console.log(JSON.stringify({ok,timestamp,sleep:health.sleep?.active===true,worker:health.worker?.state,sessionFiles:files.length,events,stderr}));`;
let started = false;
try {
	for (const volume of volumes) docker(["volume", "create", volume]);
	const seed = `const f=require('fs');f.writeFileSync('/run/config/system-prompt.txt',${JSON.stringify(prompt)},{mode:0o644});f.mkdirSync('/data/pi-agent',{recursive:true});f.writeFileSync('/data/pi-agent/mcp.json',${JSON.stringify(JSON.stringify(mcp))})`;
	docker(["run", "--rm", "--network", "none", "--entrypoint", "node", "--mount", `type=volume,source=${volumes[0]},target=/run/config`, "--mount", `type=volume,source=${volumes[1]},target=/data`, image, "-e", seed]);
	const seccomp = resolve(root, "deploy/seccomp-bwrap.json");
	docker(["run", "-d", "--name", container, "--init", "--pids-limit", "512", "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "CHOWN", "--security-opt", `seccomp=${seccomp}`, "--security-opt", "apparmor=unconfined", "--mount", `type=volume,source=${volumes[0]},target=/run/config,readonly`, "--mount", `type=volume,source=${volumes[1]},target=/data,volume-nocopy`, "--mount", `type=volume,source=${volumes[2]},target=/state,volume-nocopy`, "-e", "CLINE_API_KEY", "-e", "RSI_PROVIDER=cline", "-e", "RSI_MODEL=cline-pass/deepseek-v4.1-flash", "-e", "RSI_THINKING_LEVEL=high", image]);
	started = true;
	const deadline = Date.now() + timeoutMs;
	let last = {};
	while (Date.now() < deadline) {
		if (docker(["inspect", "-f", "{{.State.Running}}", container], { ignore: true }) !== "true") break;
		const raw = docker(["exec", container, "node", "-e", probe], { ignore: true, timeout: 10000 });
		try { last = JSON.parse(raw); } catch {}
		if (last.ok && last.timestamp && last.sleep) {
			console.log("PASS: real Cline model called the read-only official OKX demo MCP for BTC-USDT inside Docker/bwrap; tool result included a timestamp.");
			process.exitCode = 0;
			break;
		}
		await new Promise((done) => setTimeout(done, 3000));
	}
	if (!(last.ok && last.timestamp && last.sleep)) {
		console.error("INCOMPLETE: " + redact(JSON.stringify(last)));
		console.error(redact(docker(["logs", "--tail", "80", container], { ignore: true })));
		process.exitCode = 1;
	}
} finally {
	if (started) docker(["rm", "-f", container], { ignore: true, timeout: 30000 });
	for (const volume of volumes) docker(["volume", "rm", volume], { ignore: true });
}
