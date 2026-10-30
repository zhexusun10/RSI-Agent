import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RSI_ROOT } from "./helpers.ts";

async function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [join(RSI_ROOT, "bin", "rsi.mjs"), ...args], {
			cwd: RSI_ROOT,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
		child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

test("the Runtime CLI documents --check, validates config, and never reports a Worker start when sandbox prerequisites fail", { timeout: 60_000 }, async () => {
	const help = await run(["--help"]);
	assert.equal(help.code, 0);
	assert.match(help.stdout, /--check/);
	assert.match(help.stdout, /never starts the Worker/);

	const missing = await run(["--check"]);
	assert.notEqual(missing.code, 0);
	assert.match(missing.stderr, /RSI_CONFIG_PATH/);

	const root = await mkdtemp(join(tmpdir(), "rsi-cli-"));
	try {
		for (const name of ["workspace", "data", "data/markdowns", "data/plugins", "state", "pi", "rsi"]) {
			await mkdir(join(root, name), { recursive: true });
		}
		const prompt = join(root, "prompt.txt");
		await writeFile(prompt, "CLI CHECK HUMAN PROMPT\n");
		const config = join(root, "config.json");
		await writeFile(
			config,
			JSON.stringify({
				version: 1,
				timeZone: "UTC",
				paths: {
					workspaceDir: join(root, "workspace"),
					dataDir: join(root, "data"),
					stateDir: join(root, "state"),
					markdownsDir: join(root, "data", "markdowns"),
					pluginSourceDir: join(root, "data", "plugins"),
					piSourceDir: join(root, "pi"),
					rsiSourceDir: join(root, "rsi"),
					systemPromptFile: prompt,
				},
				sandbox: { bwrapPath: "bwrap", network: "unrestricted", workerUid: 65_534, workerGid: 65_534 },
			}),
		);
		const check = await run(["--check"], { RSI_CONFIG_PATH: config });
		assert.notEqual(check.code, 0);
		assert.doesNotMatch(check.stdout, /preflight passed/);
		assert.match(check.stderr, /SANDBOX_INVALID|bubblewrap|Supervisor must run as root|requires Linux/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
