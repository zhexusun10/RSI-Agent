import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createProductionModel } from "../../src/worker-main.ts";
import { stderrRedactionValues, redactStderrText } from "../../src/shared/stderr-log.ts";

const root = resolve(import.meta.dirname, "../..");
const modelId = "cline-pass/deepseek-v4.1-flash";

async function withModelDirectory(fn: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "rsi-cline-"));
	try {
		await copyFile(join(root, "deploy/cline.models.json"), join(dir, "models.json"));
		await writeFile(join(dir, "auth.json"), "{}\n");
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("ClinePass model is registered with the specified route and capabilities", async () => {
	await withModelDirectory(async (dir) => {
		const { model } = await createProductionModel({
			cwd: dir,
			agentDir: dir,
			env: { RSI_PROVIDER: "cline", RSI_MODEL: modelId },
		});
		assert.equal(model.provider, "cline");
		assert.equal(model.id, modelId);
		assert.equal(model.baseUrl, "https://api.cline.bot/api/v1");
		assert.equal(model.api, "openai-completions");
		assert.equal(model.contextWindow, 1_000_000);
		assert.equal(model.maxTokens, 128_000);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.thinkingLevelMap?.max, "max");
		assert.equal(model.reasoning, true);
	});
});

test("an explicitly selected but unknown model fails instead of silently falling back", async () => {
	await withModelDirectory(async (dir) => {
		await assert.rejects(
			createProductionModel({
				cwd: dir,
				agentDir: dir,
				env: { RSI_PROVIDER: "cline", RSI_MODEL: "typo" },
			}),
			/refusing to fall back/,
		);
	});
});

test("OKX MCP sample exposes a pinned demo server to Pi without embedding credentials", async () => {
	const raw = await readFile(join(root, "deploy", "okx-demo.mcp.json"), "utf8");
	const parsed = JSON.parse(raw);
	const server = parsed.mcpServers["okx-demo"];
	assert.equal(server.exposure, "direct");
	assert.equal(server.command, "npx");
	assert.ok(server.args.includes("@okx_ai/okx-trade-mcp@1.5.0"));
	assert.ok(server.args.includes("--demo"));
	assert.ok(server.args.includes("--profile"));
	assert.ok(!/api_key|secret_key|passphrase/i.test(raw));
});

test("deployment seeds the model without embedding credentials or replacing an existing model file", async () => {
	const config = JSON.parse(await readFile(join(root, "deploy/cline.models.json"), "utf8"));
	assert.equal(config.providers.cline.apiKey, "$CLINE_API_KEY");
	const entrypoint = await readFile(join(root, "scripts/container-entrypoint.sh"), "utf8");
	assert.match(entrypoint, /if \[ ! -e \/data\/pi-agent\/models\.json \]; then\s+cp \/opt\/rsi\/deploy\/cline\.models\.json/);
	const runtime = await readFile(join(root, "src/integration/runtime.ts"), "utf8");
	assert.match(runtime, /"CLINE_API_KEY"/);
	const key = "test-cline-secret";
	assert.equal(redactStderrText(key, stderrRedactionValues({ CLINE_API_KEY: key })), "[REDACTED]");
});
