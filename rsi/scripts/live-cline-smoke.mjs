#!/usr/bin/env node
// Bounded live-provider smoke: isolated Docker volumes, no OKX credentials or orders.
// Set CLINE_API_KEY in the calling environment. Never prints or writes the key.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const key = process.env.CLINE_API_KEY;
if (!key) throw new Error("CLINE_API_KEY is required; do not put the key on the command line.");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const image = process.env.RSI_SMOKE_IMAGE || "rsi-agent:local";
const timeoutMs = Number(process.env.RSI_SMOKE_TIMEOUT_MS || 180000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 600000) {
	throw new Error("RSI_SMOKE_TIMEOUT_MS must be 30000..600000.");
}
const suffix = randomBytes(6).toString("hex");
const container = `rsi-cline-smoke-${suffix}`;
const volumes = ["prompt", "data", "state"].map((name) => `rsi-cline-smoke-${name}-${suffix}`);
const marker = `RSI-LIVE-SMOKE-${suffix}`;
const checkSandbox = process.env.RSI_SMOKE_SANDBOX === "1";
const protectedPaths = ["/opt/rsi/src/main.ts", "/opt/rsi/src/pi/worker.ts", "/opt/rsi/node_modules/@earendil-works/pi-coding-agent/package.json", "/run/config/system-prompt.txt", "/data/markdowns/Memory.md"];
const sandboxCommand = `for f in ${protectedPaths.join(" ")}; do if { printf RSI_PROBE >> "$f"; } 2>/dev/null; then echo WRITE_ALLOWED:$f; else echo WRITE_DENIED:$f; fi; done; printf ok > /data/workspace/rsi-sandbox-probe && echo WORKSPACE_WRITE_OK`;
const prompt = `You are performing a bounded integration test. ${checkSandbox ? `First use bash to run exactly this command: ${sandboxCommand}. ` : ""}Use read on /data/markdowns/index.md, then use write to set /data/markdowns/Memory.md to exactly ${marker}, then call sleep for 10m. Perform no other actions and do not use ${checkSandbox ? "other shell commands" : "bash"}, web search, or network tools. Do not reveal credentials.`;
const redact = (value) => String(value).split(key).join("[REDACTED]");
function docker(args, options = {}) {
	try {
		return execFileSync("docker", args, {
			encoding: "utf8",
			timeout: options.timeout ?? 30000,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		if (options.ignore) return "";
		throw new Error(redact(error.stderr || error.message));
	}
}
const probe = `const fs=require('fs');const path=require('path');let health={};try{health=JSON.parse(fs.readFileSync('/state/runtime/health.json','utf8'))}catch{};let memory='';try{memory=fs.readFileSync('/data/markdowns/Memory.md','utf8')}catch{};function walk(p){let a=[];try{for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);if(e.isDirectory())a.push(...walk(q));else if(e.isFile()&&e.name.endsWith('.jsonl'))a.push(fs.readFileSync(q,'utf8'))}}catch{}return a};const files=walk('/data/pi-sessions');const sessions=files.join('\\n');let stderr='';try{stderr=fs.readFileSync('/state/logs/worker-stderr.log','utf8').slice(-3000)}catch{};let logs='';for(const n of ['runtime.log','reload.log','watchdog.log'])try{logs+=n+':'+fs.readFileSync('/state/logs/'+n,'utf8').slice(-2000)+'\\n'}catch{};let events=[],sandbox=false;for(const line of sessions.split('\\n'))try{const x=JSON.parse(line);events.push({type:x.type,role:x.message?.role,stop:x.message?.stopReason,error:x.message?.errorMessage});if(x.message?.role==='toolResult'&&x.message.toolName==='bash'&&!x.message.isError){const t=(x.message.content||[]).map(p=>p.text||'').join('\\n');sandbox=${JSON.stringify(protectedPaths)}.every(p=>t.includes('WRITE_DENIED:'+p))&&t.includes('WORKSPACE_WRITE_OK')&&!t.includes('WRITE_ALLOWED:')}}catch{};console.log(JSON.stringify({worker:health.worker?.state||null,sleep:health.sleep?.active===true,memory:memory===${JSON.stringify(marker)},memoryMeta:sessions.includes('Current Memory Usage:'),time:/Current Time: \\d{4}\\/\\d{2}\\/\\d{2}/.test(sessions),index:sessions.includes('/data/markdowns/index.md'),sandbox,sessionFiles:files.length,events:events.slice(-5),health,stderr,logs}));`;
let started = false;
try {
	for (const volume of volumes) docker(["volume", "create", volume]);
	docker(["run", "--rm", "--network", "none", "--entrypoint", "node", "--mount", `type=volume,source=${volumes[0]},target=/run/config`, image, "-e", `require('fs').writeFileSync('/run/config/system-prompt.txt',${JSON.stringify(prompt)},{mode:0o644})`]);
	const seccomp = resolve(root, "deploy/seccomp-bwrap.json");
	docker(["run", "-d", "--name", container, "--init", "--pids-limit", "512", "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "CHOWN", "--security-opt", `seccomp=${seccomp}`, "--mount", `type=volume,source=${volumes[0]},target=/run/config,readonly`, "--mount", `type=volume,source=${volumes[1]},target=/data,volume-nocopy`, "--mount", `type=volume,source=${volumes[2]},target=/state,volume-nocopy`, "-e", "CLINE_API_KEY", "-e", "RSI_PROVIDER=cline", "-e", "RSI_MODEL=cline-pass/deepseek-v4.1-flash", "-e", "RSI_THINKING_LEVEL=high", image]);
	started = true;
	const deadline = Date.now() + timeoutMs;
	let last = {};
	while (Date.now() < deadline) {
		const running = docker(["inspect", "-f", "{{.State.Running}}", container], { ignore: true });
		if (running !== "true") break;
		const raw = docker(["exec", container, "node", "-e", probe], { ignore: true, timeout: 10000 });
		try { last = JSON.parse(raw); } catch {}
		if (last.memory && last.sleep && last.memoryMeta && last.time && last.index && (!checkSandbox || last.sandbox)) {
			console.log(`PASS: real Cline/Pi Worker, indexed read, Memory write and metadata, timestamp, and sleep inside Docker/bwrap${checkSandbox ? "; protected writes denied and workspace write allowed" : ""}.`);
			console.log(JSON.stringify({ worker: last.worker, sleep: last.sleep, memory: last.memory, memoryMeta: last.memoryMeta, time: last.time, index: last.index, ...(checkSandbox ? { sandbox: last.sandbox } : {}) }));
			process.exitCode = 0;
			break;
		}
		await new Promise((done) => setTimeout(done, 3000));
	}
	if (!(last.memory && last.sleep && last.memoryMeta && last.time && last.index && (!checkSandbox || last.sandbox))) {
		console.error("INCOMPLETE: " + redact(JSON.stringify(last)));
		console.error(redact(docker(["logs", "--tail", "80", container], { ignore: true })));
		process.exitCode = 1;
	}
} finally {
	if (started) docker(["rm", "-f", container], { ignore: true, timeout: 30000 });
	for (const volume of volumes) docker(["volume", "rm", volume], { ignore: true });
}
