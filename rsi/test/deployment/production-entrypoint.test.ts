import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

const testDir = dirname(fileURLToPath(import.meta.url));
const rsiRoot = resolve(testDir, "../..");
const repoRoot = resolve(rsiRoot, "..");

async function read(relativePath: string): Promise<string> {
	return (await readFile(join(repoRoot, relativePath), "utf8")).replace(/\r\n/g, "\n");
}

function between(source: string, startMarker: string, endMarker: string): string {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	assert.ok(start >= 0 && end > start, `missing ${startMarker}..${endMarker}`);
	return source.slice(start, end);
}

async function freeTcpPort(): Promise<number> {
	// Fetch blocks certain otherwise valid TCP ports (e.g. 6566); Windows may
	// allocate those with listen(0). Choose from the unblocked dynamic range.
	for (let attempt = 0; attempt < 32; attempt += 1) {
		const port = randomInt(49_152, 65_536);
		const server = createServer();
		try {
			await new Promise<void>((resolveListen, reject) => {
				server.once("error", reject);
				server.listen(port, "127.0.0.1", () => resolveListen());
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
			throw error;
		}
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		return port;
	}
	throw new Error("Could not allocate a Fetch-compatible local TCP port.");
}

async function waitForFile(path: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		} catch {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

test("production entrypoint smoke uses the image entrypoint, real production main, and dedicated fixture resources", async () => {
	const strictTarget = await read("rsi/scripts/linux-target-docker.mjs");
	assert.match(strictTarget, /"--entrypoint",\s*"node",\s*image,\s*command/);
	const smoke = await read("rsi/scripts/linux-entrypoint-smoke.mjs");
	const targetArgs = between(smoke, "function targetRunArgs", "function mockRunArgs");
	assert.doesNotMatch(targetArgs, /--entrypoint/, "the tested container must use the image default ENTRYPOINT");
	assert.match(targetArgs, /target=\$\{productionEntrypointPromptTarget\},readonly/);
	assert.match(smoke, /productionEntrypointPromptTarget = "\/run\/config\/system-prompt\.txt"/);
	assert.match(smoke, /\[rsi-preflight\] full sandbox preflight passed/);
	assert.match(smoke, /host_uid=\$\{WORKER_UID\}/);
	assert.match(smoke, /host_gid=\$\{WORKER_GID\}/);
	assert.match(smoke, /namespace_uid=\$\{WORKER_UID\}/);
	assert.match(smoke, /namespace_gid=\$\{WORKER_GID\}/);
	assert.match(smoke, /CapEff=0/);
	assert.match(smoke, /supplementary_groups=cleared/);
	assert.match(smoke, /protected_hardlinks=true/);
	assert.match(smoke, /protected_symlinks=true/);
	assert.doesNotMatch(smoke, /bwrap namespace probe passed/);
	assert.match(targetArgs, /type=volume,source=\$\{dataVolume\},target=\/data,volume-nocopy/);
	assert.match(targetArgs, /type=volume,source=\$\{stateVolume\},target=\/state,volume-nocopy/);
	assert.match(targetArgs, /seccomp=\$\{seccompPath\}/);
	assert.match(targetArgs, /"--cap-drop",\n\t\t"ALL"/);
	assert.doesNotMatch(targetArgs, /--privileged|docker\.sock/);
	assert.match(smoke, /\["network", "create"/);
	assert.match(smoke, /--network-alias/);
	assert.match(smoke, /production-entrypoint-smoke\.ts/);
	assert.match(smoke, /production-entrypoint-mock-provider\.mjs/);
	assert.match(smoke, /"stop", "--time", "30"/);
	assert.match(smoke, /state\.ExitCode !== 0/);
	assert.match(smoke, /sending SIGKILL/);
	assert.match(smoke, /removeDockerVolumes/);
	assert.match(smoke, /removeContainer/);

	const driver = await read("rsi/test/deployment/production-entrypoint-smoke.ts");
	for (const marker of [
		"install-plugins.mjs",
		"--verify-only",
		"Memory.md",
		"architecture.md",
		"operations.md",
		"security.md",
		"indexConsistent",
		"verifyRenderedConfig",
		"rendered config sandbox.",
		"must report only the Worker GID",
		"must report the exact Worker",
		"WRITE_FAIL:settings",
		"WRITE_FAIL:models",
		"WRITE_FAIL:auth",
		"WRITE_FAIL:prompt",
		"WRITE_FAIL:memory-direct",
		"WRITE_OK:workspace",
		"sleepDeadlineMs",
		"cancelSleep",
		"operator-pi-config.json",
		"workerPidChanged",
	]) {
		assert.ok(driver.includes(marker), `production entrypoint driver must assert ${marker}`);
	}
	assert.match(driver, /mode 0640/);
	assert.match(driver, /root-owned/);
	assert.match(driver, /plugin discovery did not load exactly two pinned plugins/);
	assert.match(driver, /Memory did not survive the volume reuse restart/);
	assert.match(driver, /plugin digest was not preserved/);
	assert.match(driver, /LKG digest was not preserved/);
	assert.match(driver, /operator-controlled wake to reach the real Worker provider request/);

	const mock = await read("rsi/test/deployment/production-entrypoint-mock-provider.mjs");
	assert.match(mock, /\/v1\/chat\/completions/);
	assert.match(mock, /text\/event-stream/);
	assert.match(mock, /pe-sandbox-probe/);
	assert.match(mock, /pe-sleep/);
	assert.match(mock, /requests\.jsonl/);

	const validation = await read("rsi/scripts/linux-validation.mjs");
	assert.match(validation, /runProductionEntrypointSmoke/);
	assert.match(validation, /--suite target\|entrypoint\|all/);
	assert.match(validation, /--suite target/);
	assert.match(validation, /Report\.errorStack|report\.errorStack/);
});

test("CI runs both bounded suites, and soak evidence is explicitly the target harness rather than production entrypoint", async () => {
	const workflow = await read(".github/workflows/rsi-linux.yml");
	for (const path of ['".dockerignore"', '"markdowns/**"', '"rsi/**"']) {
		assert.ok(workflow.includes(path), `CI paths must include ${path}`);
	}
	assert.ok((workflow.match(/--suite target/gu) ?? []).length === 1);
	assert.ok((workflow.match(/--suite entrypoint/gu) ?? []).length === 1);
	assert.match(workflow, /production-entrypoint-report\.json/);
	assert.match(workflow, /production-entrypoint\.test\.ts/);
	assert.match(workflow, /repository-docs\.test\.ts/);
	assert.match(workflow, /review2-markdown-seed\.test\.ts/);
	assert.match(workflow, /root Markdown seed inventory and index regression/i);
	assert.match(workflow, /timeout-minutes: 60/);
	assert.doesNotMatch(workflow, /linux-soak\.mjs[\s\S]{0,120}?--hours 24\s*(?:\n|$)/);

	const soak = await read("rsi/scripts/linux-soak.mjs");
	assert.match(soak, /kind: "linux-target-harness-soak"/);
	assert.match(soak, /productionEntrypoint: false/);
	assert.match(soak, /bypasses container-entrypoint\.sh/);
	assert.match(soak, /production entrypoint NOT exercised/);

	const fixtureModels = JSON.parse(
		await read("rsi/test/deployment/fixtures/production-entrypoint/models.json"),
	) as { providers?: Record<string, { baseUrl?: string }> };
	assert.equal(
		fixtureModels.providers?.["rsi-entrypoint-mock"]?.baseUrl,
		"http://rsi-mock-provider:18080/v1",
	);
	const auth = JSON.parse(await read("rsi/test/deployment/fixtures/production-entrypoint/auth.json"));
	assert.deepEqual(auth, {});
});

test("the local mock provider speaks the real Pi SDK OpenAI-compatible SSE path without a real key", { timeout: 60_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "rsi-entrypoint-mock-test-"));
	const fixtureDir = join(root, "fixture");
	const captureDir = join(root, "capture");
	await mkdir(fixtureDir, { recursive: true });
	await mkdir(captureDir, { recursive: true });
	await writeFile(
		join(fixtureDir, "scenario.json"),
		`${JSON.stringify({
			version: 1,
			memoryMarker: "LOCAL-MOCK-MEMORY-MARKER",
			sleepDuration: "10m",
			probeCommand: "echo PROBE_COMPLETE",
		})}\n`,
	);
	const port = await freeTcpPort();
	const child = spawn(
		process.execPath,
		[
			join(rsiRoot, "test", "deployment", "production-entrypoint-mock-provider.mjs"),
			"--port",
			String(port),
			"--fixture-dir",
			fixtureDir,
			"--capture-dir",
			captureDir,
		],
		{ cwd: rsiRoot, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
	try {
		await waitForFile(join(captureDir, "mock-ready.json"), 20_000);

		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		const modelsPath = join(agentDir, "models.json");
		const authPath = join(agentDir, "auth.json");
		await writeFile(
			join(agentDir, "settings.json"),
			`${JSON.stringify({
				defaultProvider: "rsi-entrypoint-mock",
				defaultModel: "rsi-entrypoint-mock-model",
			})}\n`,
		);
		await writeFile(authPath, "{}\n");
		await writeFile(
			modelsPath,
			`${JSON.stringify({
				providers: {
					"rsi-entrypoint-mock": {
						name: "Local fixture",
						baseUrl: `http://127.0.0.1:${port}/v1`,
						apiKey: "fixture-key-not-a-secret",
						api: "openai-completions",
						authHeader: true,
						models: [
							{
								id: "rsi-entrypoint-mock-model",
								name: "Local fixture model",
								api: "openai-completions",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128_000,
								maxTokens: 16_384,
							},
						],
					},
				},
			})}\n`,
		);
		const runtime = await ModelRuntime.create({
			authPath,
			modelsPath,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const settings = SettingsManager.create(root, agentDir);
		assert.equal(settings.getDefaultProvider(), "rsi-entrypoint-mock");
		assert.equal(settings.getDefaultModel(), "rsi-entrypoint-mock-model");
		const model = runtime.getModel(
			settings.getDefaultProvider() ?? "",
			settings.getDefaultModel() ?? "",
		);
		assert.ok(model, "the operator-style settings/models must produce a real Pi SDK model");
		const result = await runtime
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "fixture-only local request" }] } as never,
			)
			.result();
		const toolNames = result.content
			.filter((block) => block.type === "toolCall")
			.map((block) => block.name);
		assert.deepEqual(toolNames, ["bash", "read", "write", "write"], `port=${port} result=${JSON.stringify(result)}`);
		const capture = (await readFile(join(captureDir, "requests.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		assert.equal(capture.length, 1);
		assert.equal(capture[0]?.model, "rsi-entrypoint-mock-model");
		assert.equal(capture[0]?.stream, true);
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.stack ?? error.message : String(error)}\n` +
				`mock stdout:\n${stdout}\nmock stderr:\n${stderr}`,
			{ cause: error },
		);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
			child.kill("SIGTERM");
			await exited.catch(() => undefined);
		}
		await rm(root, { recursive: true, force: true });
	}
});
