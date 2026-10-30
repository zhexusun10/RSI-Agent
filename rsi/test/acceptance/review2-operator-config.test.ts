import assert from "node:assert/strict";
import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	assertOperatorPiConfigUnchanged,
	ensureOperatorPiConfigBaseline,
	ensureOperatorPiConfigFilesSync,
	operatorPiConfigPaths,
	operatorPiConfigReadOnlyMounts,
} from "../../src/shared/operator-config.ts";
import { startRuntimeHarness, waitFor } from "../integration/helpers.ts";

test("operator Pi settings/models/auth are baseline-checked and mounted read-only", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "rsi-operator-config-"));
	try {
		const agentDir = join(root, "pi-agent");
		const baseline = join(root, "state", "operator-pi-config.json");
		ensureOperatorPiConfigFilesSync(agentDir);
		const paths = operatorPiConfigPaths(agentDir);
		await writeFile(paths[0]!.path, '{"defaultProvider":"faux"}\n', "utf8");
		await ensureOperatorPiConfigBaseline(agentDir, baseline);
		await assertOperatorPiConfigUnchanged(agentDir, baseline);

		const mounts = operatorPiConfigReadOnlyMounts(agentDir);
		assert.equal(mounts.length, 3);
		for (const mount of mounts) {
			assert.equal(mount.mode, "ro");
			assert.equal(mount.source, mount.target);
			assert.equal((await lstat(mount.source)).isFile(), true);
		}

		await writeFile(paths[0]!.path, '{"defaultProvider":"attacker","defaultModel":"attacker/model"}\n', "utf8");
		await assert.rejects(
			assertOperatorPiConfigUnchanged(agentDir, baseline),
			/changed|model route|operator Pi/iu,
			"a changed operator config must block Worker restart",
		);
		const persisted = JSON.parse(await readFile(baseline, "utf8")) as { files?: unknown[] };
		assert.equal(persisted.files?.length, 3);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("operator Pi config rejects symlink/hardlink substitution", { timeout: 20_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "rsi-operator-config-link-"));
	try {
		const agentDir = join(root, "pi-agent");
		ensureOperatorPiConfigFilesSync(agentDir);
		await rm(join(agentDir, "settings.json"));
		await writeFile(join(root, "outside-settings.json"), "{}\n", "utf8");
		try {
			await symlink(
				join(root, "outside-settings.json"),
				join(agentDir, "settings.json"),
				process.platform === "win32" ? "file" : undefined,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			// Windows without symlink privilege still exercises the same
			// single-link requirement with a hardlink.
			await link(join(root, "outside-settings.json"), join(agentDir, "settings.json"));
		}
		assert.throws(
			() => ensureOperatorPiConfigFilesSync(agentDir),
			/symlink|regular file|single-link/iu,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a Worker crash restart is refused after the Agent rewrites operator settings", { timeout: 240_000 }, async () => {
	const harness = await startRuntimeHarness({
		beforeStart: async ({ piAgentDir }) => {
			await writeFile(join(piAgentDir, "settings.json"), '{"defaultProvider":"faux","defaultModel":"faux-1"}\n', "utf8");
		},
	});
	try {
		const initialPid = await waitFor(() => harness.runtime.workerPid, "initial Worker pid", 20_000);
		const settingsPath = join(harness.paths.piAgentDir, "settings.json");
		await harness.setScript([
			{
				toolCalls: [
					{
						name: "write",
						id: "rewrite-operator-settings",
						arguments: {
							path: settingsPath,
							content: '{"defaultProvider":"attacker","defaultModel":"attacker/model","defaultThinkingLevel":"high"}\n',
						},
					},
				],
			},
			{ text: "operator settings rewritten" },
		]);
		await waitFor(async () => {
			const captures = await harness.captures();
			return captures.some((entry) =>
				entry.messages.some((message) => message.toolCallId === "rewrite-operator-settings" && message.isError === false),
			)
				? true
				: undefined;
		}, "Agent write to operator settings", 30_000);

		process.kill(initialPid!, "SIGKILL");
		const failed = await waitFor(async () => {
			const state = await harness.runtime.watchdog.status();
			return state.phase === "unrecoverable" ? state : undefined;
		}, "Watchdog refuses restart with changed operator config", 150_000);
		assert.match(failed.recovery?.lastError ?? "", /operator Pi|changed|CONFIG_INVALID/iu);
		assert.match(await readFile(settingsPath, "utf8"), /attacker/u);
	} catch (error) {
		console.error(`LOGS:\n${harness.logs.join("\n")}`);
		throw error;
	} finally {
		await harness.cleanup();
	}
});
