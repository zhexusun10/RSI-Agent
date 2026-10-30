#!/usr/bin/env node
// LOCAL MOCK ONLY: never contacts OKX, uses invented credentials and orders.
// Install @okx_ai/okx-trade-mcp@1.5.0 under rsi/.artifacts/okx-mcp-validation
// with npm --ignore-scripts, or set OKX_MCP_PACKAGE_DIR to its installed path.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = process.env.OKX_MCP_PACKAGE_DIR || join(root, ".artifacts/okx-mcp-validation/node_modules/@okx_ai/okx-trade-mcp");
const require = createRequire(join(pkg, "package.json"));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const apiKey = "local-fake-api-key";
const secret = "local-fake-secret";
const passphrase = "local-fake-passphrase";
const home = await mkdtemp(join(tmpdir(), "rsi-okx-local-mock-"));
const trace = [];
let state = "none";
let original;
const server = createServer(async (req, res) => {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const body = Buffer.concat(chunks).toString("utf8");
	try {
		assert.equal(req.headers["x-simulated-trading"], "1", "missing demo header");
		assert.equal(req.headers["ok-access-key"], apiKey);
		assert.equal(req.headers["ok-access-passphrase"], passphrase);
		const timestamp = req.headers["ok-access-timestamp"];
		assert.equal(typeof timestamp, "string");
		const signature = createHmac("sha256", secret).update(timestamp + req.method + req.url + body).digest("base64");
		assert.equal(req.headers["ok-access-sign"], signature, "invalid HMAC signature");
		const url = new URL(req.url, "http://127.0.0.1");
		trace.push(`${req.method} ${url.pathname}`);
		let data;
		if (req.method === "GET" && url.pathname === "/api/v5/account/balance") {
			data = [{ totalEq: "1000", details: [{ ccy: "USDT", availBal: "1000" }] }];
		} else if (req.method === "POST" && url.pathname === "/api/v5/trade/order") {
			assert.equal(state, "none");
			original = JSON.parse(body);
			assert.deepEqual([original.instId, original.tdMode, original.side, original.ordType], ["BTC-USDT", "cash", "buy", "limit"]);
			state = "live";
			data = [{ ordId: "local-demo-1", clOrdId: original.clOrdId, sCode: "0", sMsg: "" }];
		} else if (req.method === "GET" && url.pathname === "/api/v5/trade/order") {
			assert.equal(url.searchParams.get("ordId"), "local-demo-1");
			data = [{ ordId: "local-demo-1", instId: "BTC-USDT", state }];
		} else if (req.method === "POST" && url.pathname === "/api/v5/trade/cancel-order") {
			const order = JSON.parse(body);
			assert.equal(order.ordId, "local-demo-1");
			assert.equal(state, "live");
			state = "canceled";
			data = [{ ordId: "local-demo-1", clOrdId: original.clOrdId, sCode: "0", sMsg: "" }];
		} else {
			throw new Error(`Unexpected mock request: ${req.method} ${url.pathname}`);
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ code: "0", msg: "", data }));
	} catch (error) {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ code: "59999", msg: String(error.message), data: [] }));
	}
});
await new Promise((resolveListen, reject) => server.listen(0, "127.0.0.1", resolveListen).once("error", reject));
const port = server.address().port;
// Also block the child's ordinary Node TCP/TLS connections except this exact
// loopback endpoint. The server rejects any request lacking the demo header.
const networkGuard = join(home, "local-only.cjs");
await writeFile(networkGuard, `const net=require('node:net');const original=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){let options=args[0];if(Array.isArray(options))options=options[0];const host=typeof options==='object'&&options!==null?(options.host||options.hostname):(typeof options==='number'?(args[1]||'localhost'):null);const port=typeof options==='object'&&options!==null?options.port:(typeof options==='number'?options:null);if(host!=='127.0.0.1'||Number(port)!==Number(process.env.RSI_LOCAL_MOCK_PORT))throw new Error('Blocked non-mock network connection');return original.apply(this,args)};require('node:tls').connect=()=>{throw new Error('Blocked TLS in local-only test')};`);
// The child gets ONLY synthetic credentials and a literal loopback URL; do not
// inherit any real provider or OKX keys from the parent process.
const env = {
	PATH: process.env.PATH || "",
	HOME: home,
	USERPROFILE: home,
	...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
	OKX_API_KEY: apiKey,
	OKX_SECRET_KEY: secret,
	OKX_PASSPHRASE: passphrase,
	OKX_API_BASE_URL: `http://127.0.0.1:${port}`,
	RSI_LOCAL_MOCK_PORT: String(port),
	NO_PROXY: "127.0.0.1,localhost",
};
const transport = new StdioClientTransport({ command: process.execPath, args: ["--require", networkGuard, join(pkg, "dist/index.js"), "--demo", "--modules", "account,spot"], env, stderr: "pipe" });
const client = new Client({ name: "rsi-local-mock", version: "1.0.0" });
async function call(name, args) {
	const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
	assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.structuredContent || result.content)}`);
	const value = result.structuredContent || JSON.parse(result.content[0].text);
	assert.equal(value.ok, true, `${name}: ${JSON.stringify(value)}`);
	return value;
}
try {
	await client.connect(transport);
	await call("account_get_balance", { ccy: "USDT" });
	await call("spot_place_order", { instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "limit", px: "1", sz: "0.001", clOrdId: "localmock1" });
	assert.equal(state, "live");
	await call("spot_get_order", { instId: "BTC-USDT", ordId: "local-demo-1" });
	await call("spot_cancel_order", { instId: "BTC-USDT", ordId: "local-demo-1" });
	await call("spot_get_order", { instId: "BTC-USDT", ordId: "local-demo-1" });
	assert.equal(state, "canceled");
	assert.deepEqual(trace, ["GET /api/v5/account/balance", "POST /api/v5/trade/order", "GET /api/v5/trade/order", "POST /api/v5/trade/cancel-order", "GET /api/v5/trade/order"]);
	console.log("PASS LOCAL MOCK ONLY: balance -> place -> query -> cancel -> query; all five requests carried demo header and valid HMAC. NO request reached OKX.");
	console.log(JSON.stringify({ trace, finalMockState: state }));
} finally {
	await client.close().catch(() => undefined);
	await new Promise((done) => server.close(done));
	await rm(home, { recursive: true, force: true });
}
