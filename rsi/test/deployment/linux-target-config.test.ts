import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const rsiRoot = resolve(testDir, "../..");
const repoRoot = resolve(rsiRoot, "..");

async function read(relativePath: string): Promise<string> {
	return await readFile(join(repoRoot, relativePath), "utf8");
}

test("target image uses a verified bubblewrap feature check instead of assuming bookworm packages", async () => {
	const dockerfile = await read("rsi/Dockerfile");
	assert.match(dockerfile, /ARG NODE_IMAGE=node:22\.19\.0-trixie-slim/);
	assert.doesNotMatch(dockerfile, /node:22\.19\.0-bookworm-slim/);
	assert.match(dockerfile, /test ! -u \/usr\/bin\/bwrap/);
	assert.match(dockerfile, /bwrap --help 2>&1 \| grep -q -- '--seccomp'/);
	assert.match(dockerfile, /bwrap --help 2>&1 \| grep -q -- '--unshare-user'/);
	assert.match(dockerfile, /bwrap --version/);
	assert.match(dockerfile, /node \/opt\/rsi\/src\/main\.ts --help/);

	const preflight = await read("rsi/scripts/deployment-preflight.mjs");
	assert.match(preflight, /inspectConfiguredSandboxPreflight/);
	assert.match(preflight, /formatPreflightReport/);
	assert.match(preflight, /protected_symlinks/);
	assert.match(preflight, /CapEff/);
	assert.match(preflight, /config-only: Worker NOT started/);
	assert.match(preflight, /NOT verified/);
	assert.doesNotMatch(preflight, /spawnSync/);
	assert.doesNotMatch(preflight, /--cap-drop/);

	const commonPreflight = await read("rsi/src/sandbox/preflight.ts");
	assert.match(commonPreflight, /inspectProtectedSysctls/);
	assert.match(commonPreflight, /assessSandboxProbeFacts/);
	assert.match(commonPreflight, /protected_symlinks/);
	assert.match(commonPreflight, /--seccomp/);
	assert.match(commonPreflight, /CapEff/);
});

test("Linux validation and soak scripts are executable, strict, bounded, and use the deployment security flags", async () => {
	for (const script of [
		"rsi/scripts/linux-target-docker.mjs",
		"rsi/scripts/linux-validation.mjs",
		"rsi/scripts/linux-smoke.mjs",
		"rsi/scripts/linux-soak.mjs",
	]) {
		const check = spawnSync(process.execPath, ["--check", join(repoRoot, script)], {
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(check.status, 0, `${script}: ${check.stderr}`);
	}

	const lib = await read("rsi/scripts/linux-target-docker.mjs");
	assert.match(lib, /"--cap-drop",\s*\n\s*"ALL"/);
	assert.match(lib, /"--cap-add",\s*\n\s*"SETUID"/);
	assert.match(lib, /"--cap-add",\s*\n\s*"SETGID"/);
	assert.match(lib, /"--cap-add",\s*\n\s*"CHOWN"/);
	assert.match(lib, /seccomp=\$\{seccompPath\}/);
	assert.match(lib, /target=\/run\/rsi-target\/prompt\.txt,readonly/);
	assert.match(lib, /target=\/data,volume-nocopy/);
	assert.match(lib, /target=\/state,volume-nocopy/);
	assert.match(lib, /target=\/opt\/rsi\/test,readonly/);
	assert.doesNotMatch(lib, /--privileged|docker\.sock:\/|target=\/var\/run\/docker\.sock/);

	const validation = await read("rsi/scripts/linux-validation.mjs");
	assert.match(validation, /RSI_TARGET_STRICT: "1"/);
	assert.match(validation, /RSI_TARGET_EXPECT_EMPTY: "1"/);
	assert.match(validation, /Docker daemon is not available|assertDockerDaemon/);
	assert.match(validation, /process\.exitCode = code/);
	assert.match(validation, /targetTestFile/);
	assert.match(validation, /restartPhaseFile/);
	assert.match(validation, /restartPhases/);
	assert.match(validation, /A real container restart uses the same \/data and \/state volumes/);
	assert.match(validation, /runProductionEntrypointSmoke/);
	assert.match(validation, /--suite target\|entrypoint\|all/);

	const smoke = await read("rsi/scripts/linux-smoke.mjs");
	assert.match(smoke, /linux-validation\.mjs/);
	assert.doesNotMatch(smoke, /linux-soak/);

	const soak = await read("rsi/scripts/linux-soak.mjs");
	assert.match(soak, /default: 24/);
	assert.match(soak, /RSI_SOAK_HOURS/);
	assert.match(soak, /soakRunnerFile/);
	assert.match(soak, /removeDockerVolumes/);
	assert.match(soak, /removeContainer/);
	assert.match(soak, /linux-target-harness-soak/);
	assert.match(soak, /productionEntrypoint: false/);

	const soakRunner = await read("rsi/test/deployment/linux-soak-runner.ts");
	assert.match(soakRunner, /--hours N/);
	assert.match(soakRunner, /samples\.push/);
	assert.match(soakRunner, /pendingNotices/);
	assert.match(soakRunner, /logSizes/);
	assert.match(soakRunner, /processParents/);
	assert.match(soakRunner, /health file is stale/);
});

test("push CI runs only the bounded smoke and never executes or claims the 24-hour soak", async () => {
	const workflow = await read(".github/workflows/rsi-linux.yml");
	assert.match(workflow, /node rsi\/scripts\/linux-validation\.mjs/);
	assert.match(workflow, /--timeout-ms 1800000/);
	assert.match(workflow, /timeout-minutes: 60/);
	assert.doesNotMatch(workflow, /node rsi\/scripts\/linux-soak\.mjs[\s\S]{0,120}?--hours 24\s*(?:\n|$)/);
	assert.doesNotMatch(workflow, /^\s*run:\s*[^\n]*linux-soak/m);
	assert.match(workflow, /docker build --file rsi\/Dockerfile/);
	assert.match(workflow, /--seccomp/);
	assert.match(workflow, /docker compose --project-directory rsi/);
});

test("target acceptance includes MCP, extension exclusion, sleep, persistence and sandbox probes", async () => {
	const suite = await read("rsi/test/deployment/linux-target-acceptance.test.ts");
	for (const marker of [
		"clean volumes start the first real bwrap Worker",
		"an Agent-written Pi extension remains unavailable",
		"an Agent-configured MCP server exposes a callable tool",
		"TARGET-MCP-OK: hello",
		"Legacy test loads Agent-authored Pi extensions, which the current policy forbids",
		"authoritative sleeping heartbeat",
		"read statistics and a pending recovery notice survive",
		"TARGET-BROKER-UPDATE-VISIBLE",
		"target local mock search",
		"NESTED_USERNS:denied",
		"CapEff:0",
	]) {
		assert.ok(suite.includes(marker), `target suite must cover ${marker}`);
	}
	const restartPhase = await read("rsi/test/deployment/linux-target-restart-phase.ts");
	assert.match(restartPhase, /RESTART_PHASE=prepare/);
	assert.match(restartPhase, /read statistics did not survive container restart/);
	assert.match(restartPhase, /recovery notice after a real container restart/);

	const harness = await read("rsi/test/deployment/linux-target-harness.ts");
	assert.match(harness, /does not turn a missing Linux\/namespace\/Docker prerequisite into a skip/);
	assert.match(harness, /RSI_TARGET_STRICT/);
	assert.match(harness, /protectedHardlinksEnabled/);
	assert.match(harness, /protectedSymlinksEnabled/);
	assert.match(harness, /TARGET_MODEL_MODULE/);
});
