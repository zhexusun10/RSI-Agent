import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	assessSandboxProbeFacts,
	formatPreflightReport,
	inspectBubblewrapRuntime,
	inspectConfiguredSandboxPreflight,
	inspectProtectedSysctls,
	parseBubblewrapFeatureSet,
	resolveBubblewrapExecutable,
	runSandboxRuntimeProbe,
	type SandboxProbeExpectations,
	type SandboxProbeFacts,
	type SandboxRuntimeProbeHostIdentity,
} from "../../src/sandbox/preflight.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const rsiRoot = resolve(testDir, "../..");
const STRICT = process.env.RSI_TARGET_STRICT === "1";
const WORKER_UID = 10_002;
const WORKER_GID = 10_002;

function expectations(overrides: Partial<SandboxProbeExpectations> = {}): SandboxProbeExpectations {
	return {
		workerUid: WORKER_UID,
		workerGid: WORKER_GID,
		supervisorUid: 0,
		supervisorGid: 0,
		marker: "review3-marker",
		hostPidNamespace: "host-pid-ns",
		hostMountNamespace: "host-mnt-ns",
		hostUserNamespace: "host-user-ns",
		...overrides,
	};
}

function probeFacts(overrides: Partial<SandboxProbeFacts> = {}): SandboxProbeFacts {
	return {
		marker: "review3-marker",
		pid: 2,
		ppid: 1,
		uid: WORKER_UID,
		gid: WORKER_GID,
		groups: [],
		capEff: "0000000000000000",
		pidNs: "sandbox-pid-ns",
		mntNs: "sandbox-mnt-ns",
		userNs: "sandbox-user-ns",
		hostname: "rsi-preflight",
		rootMount: true,
		procMount: true,
		procFsType: 0x9fa0,
		nestedUsernsBlocked: true,
		error: null,
		...overrides,
	};
}

function hostIdentity(overrides: Partial<SandboxRuntimeProbeHostIdentity> = {}): SandboxRuntimeProbeHostIdentity {
	return {
		pid: 4_242,
		uidValues: [WORKER_UID, WORKER_UID, WORKER_UID, WORKER_UID],
		gidValues: [WORKER_GID, WORKER_GID, WORKER_GID, WORKER_GID],
		...overrides,
	};
}

function runNode(script: string, args: readonly string[], env: Record<string, string> = {}) {
	return spawnSync(process.execPath, [script, ...args], {
		cwd: rsiRoot,
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, ...env },
	});
}

async function withTempConfig(
	run: (input: { readonly root: string; readonly configPath: string }) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "rsi-review3-preflight-"));
	try {
		for (const name of ["workspace", "data", "data/markdowns", "state", "pi", "rsi"]) {
			await mkdir(join(root, name), { recursive: true });
		}
		const prompt = join(root, "prompt.txt");
		await writeFile(prompt, "external fixture; not an agent prompt\n", "utf8");
		const configPath = join(root, "config.json");
		const config = {
			version: 1,
			timeZone: "UTC",
			paths: {
				workspaceDir: join(root, "workspace"),
				dataDir: join(root, "data"),
				stateDir: join(root, "state"),
				piSourceDir: join(root, "pi"),
				rsiSourceDir: join(root, "rsi"),
				systemPromptFile: prompt,
			},
			sandbox: {
				bwrapPath: join(root, "missing-bwrap"),
				network: "unrestricted",
				workerUid: WORKER_UID,
				workerGid: WORKER_GID,
			},
		};
		await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		await run({ root, configPath });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("a fully verified probe report is accepted only when every fact is present", () => {
	const assessment = assessSandboxProbeFacts(probeFacts(), hostIdentity(), expectations());
	assert.equal(assessment.ok, true, assessment.errors.join(" | "));
	assert.equal(assessment.hostIdentityVerified, true);
	assert.equal(assessment.namespaceVerified, true);
	assert.equal(assessment.mountVerified, true);
	assert.equal(assessment.capEffZero, true);
	assert.equal(assessment.supplementaryGroupsCleared, true);
	assert.equal(assessment.observedHostUid, WORKER_UID);
	assert.equal(assessment.observedNamespaceUid, WORKER_UID);
});

test("either protected sysctl unreadable or not 1 is a hard failure", async () => {
	const good = await inspectProtectedSysctls(async () => "1");
	assert.equal(good.protectedHardlinksEnabled, true);
	assert.equal(good.protectedSymlinksEnabled, true);
	assert.deepEqual(good.errors, []);

	const unreadable = await inspectProtectedSysctls(async (path) => {
		if (path.endsWith("protected_hardlinks")) throw new Error("EACCES fixture");
		return "1";
	});
	assert.equal(unreadable.protectedHardlinksEnabled, false);
	assert.equal(unreadable.protectedSymlinksEnabled, true);
	assert.match(unreadable.errors.join("\n"), /must be readable and equal 1/);

	const zero = await inspectProtectedSysctls(async (path) =>
		path.endsWith("protected_symlinks") ? "0" : "1",
	);
	assert.equal(zero.protectedHardlinksEnabled, true);
	assert.equal(zero.protectedSymlinksEnabled, false);
	assert.match(zero.errors.join("\n"), /protected_symlinks=1 is required/);
});

test("non-zero CapEff, wrong host uid/gid, and residual supplementary groups are rejected", () => {
	const escapedCap = assessSandboxProbeFacts(
		probeFacts({ capEff: "0000000000000001" }),
		hostIdentity(),
		expectations(),
	);
	assert.equal(escapedCap.ok, false);
	assert.equal(escapedCap.capEffZero, false);
	assert.match(escapedCap.errors.join("\n"), /CapEff/);

	const wrongHostUid = assessSandboxProbeFacts(
		probeFacts(),
		hostIdentity({ uidValues: [0, 0, 0, 0] }),
		expectations(),
	);
	assert.equal(wrongHostUid.ok, false);
	assert.equal(wrongHostUid.hostIdentityVerified, false);
	assert.match(wrongHostUid.errors.join("\n"), /host UID values/);

	const residualHostGid = assessSandboxProbeFacts(
		probeFacts(),
		hostIdentity({ gidValues: [WORKER_GID, 0, WORKER_GID, WORKER_GID] }),
		expectations(),
	);
	assert.equal(residualHostGid.ok, false);
	assert.match(residualHostGid.errors.join("\n"), /host GID values/);

	const residualGroup = assessSandboxProbeFacts(
		probeFacts({ groups: [0, WORKER_GID] }),
		hostIdentity(),
		expectations(),
	);
	assert.equal(residualGroup.ok, false);
	assert.equal(residualGroup.supplementaryGroupsCleared, false);
	assert.match(residualGroup.errors.join("\n"), /Supplementary groups/);
});

test("a namespace-only id is not accepted when host identity or namespace facts are missing", () => {
	const namespaceOnly = assessSandboxProbeFacts(
		probeFacts({ uid: 99_999 }),
		hostIdentity(),
		expectations(),
	);
	assert.equal(namespaceOnly.ok, false);
	assert.match(namespaceOnly.errors.join("\n"), /namespace uid 99999/);

	const noHostIdentity = assessSandboxProbeFacts(probeFacts(), null, expectations(), "fixture /proc unavailable");
	assert.equal(noHostIdentity.ok, false);
	assert.equal(noHostIdentity.hostIdentityVerified, false);
	assert.match(noHostIdentity.errors.join("\n"), /fixture \/proc unavailable/);

	const samePid = assessSandboxProbeFacts(probeFacts(), hostIdentity({ pid: 2 }), expectations());
	assert.equal(samePid.namespaceVerified, false);
	assert.equal(samePid.ok, false);

	const sameNamespaces = assessSandboxProbeFacts(
		probeFacts({
			pidNs: "host-pid-ns",
			mntNs: "host-mnt-ns",
			userNs: "host-user-ns",
		}),
		hostIdentity(),
		expectations(),
	);
	assert.equal(sameNamespaces.namespaceVerified, false);
	assert.equal(sameNamespaces.mountVerified, false);
	assert.match(sameNamespaces.errors.join("\n"), /namespace|mount/i);

	const badMountFacts = assessSandboxProbeFacts(
		probeFacts({ rootMount: false, procMount: false, procFsType: 0x0102_1994 }),
		hostIdentity(),
		expectations(),
	);
	assert.equal(badMountFacts.mountVerified, false);
	assert.equal(badMountFacts.ok, false);
});

test("a probe timeout is reported as timed out and cannot be mistaken for success", async () => {
	const result = await runSandboxRuntimeProbe({
		command: process.execPath,
		args: ["-e", "setTimeout(() => {}, 5000)"],
		timeoutMs: 300,
		marker: "review3-timeout",
		readyMarker: "RSI_PREFLIGHT_READY",
		resultMarker: "RSI_PREFLIGHT_RESULT",
		nodePath: process.execPath,
	});
	assert.equal(result.timedOut, true);
	assert.match(result.error ?? "", /timed out after 300ms/);
	assert.notEqual(result.status, 0);
});

test("missing bubblewrap and missing --seccomp are hard failures", async () => {
	await assert.rejects(
		() => resolveBubblewrapExecutable("/definitely/not/a/real/bwrap"),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_INVALID",
	);
	const missingProbe = await runSandboxRuntimeProbe({
		command: "/definitely/not/a/real/bwrap",
		args: [],
		timeoutMs: 1_000,
		marker: "review3-missing",
		readyMarker: "RSI_PREFLIGHT_READY",
		resultMarker: "RSI_PREFLIGHT_RESULT",
		nodePath: process.execPath,
	});
	assert.equal(missingProbe.hostIdentity, null);
	assert.match(missingProbe.error ?? "", /could not start probe command/);
	assert.deepEqual(parseBubblewrapFeatureSet("--unshare-user --uid --gid", false), {
		disableUserns: false,
		seccompFd: false,
		unshareCgroupTry: false,
	});
	assert.equal(parseBubblewrapFeatureSet("--unshare-user --seccomp", false).seccompFd, true);
	assert.equal(parseBubblewrapFeatureSet("--unshare-user --seccomp", true).seccompFd, true);
	assert.equal(parseBubblewrapFeatureSet("--unshare-user --disable-userns", true).disableUserns, false);
	assert.equal(parseBubblewrapFeatureSet("--unshare-user --disable-userns", false).disableUserns, true);
});

test("configured preflight without Worker identity never reports a verified namespace", async () => {
	const report = await inspectConfiguredSandboxPreflight({ sandbox: { bwrapPath: "bwrap" } });
	assert.equal(report.ok, false);
	assert.equal(report.probeExecuted, false);
	assert.equal(report.namespaceVerified, false);
	assert.equal(report.mountVerified, false);
	assert.match(report.errors.join("\n"), /workerUid and sandbox\.workerGid are required/);
	assert.match(formatPreflightReport(report), /probe_executed=false/);
});

test("deployment --config-only clearly says the Worker/namespace were not verified", async () => {
	await withTempConfig(async ({ configPath }) => {
		const result = runNode("scripts/deployment-preflight.mjs", ["--config", configPath, "--config-only"]);
		assert.equal(result.status, 0, result.stderr);
		const output = `${result.stdout}\n${result.stderr}`;
		assert.match(output, /config-only: Worker NOT started/);
		assert.match(output, /were NOT verified/);
		assert.doesNotMatch(output, /full sandbox preflight passed/);
	});
});

test("deployment wrapper has no second bwrap probe and consumes the common preflight", async () => {
	const wrapper = await readFile(join(rsiRoot, "scripts/deployment-preflight.mjs"), "utf8");
	assert.match(wrapper, /inspectConfiguredSandboxPreflight/);
	assert.match(wrapper, /formatPreflightReport/);
	assert.match(wrapper, /\[rsi-preflight\] full sandbox preflight passed/);
	assert.doesNotMatch(wrapper, /spawnSync/);
	assert.doesNotMatch(wrapper, /buildProbeArgs/);
	assert.doesNotMatch(wrapper, /--cap-drop/);
	assert.doesNotMatch(wrapper, /readFileSync\("\/proc/);
	const main = await readFile(join(rsiRoot, "src/main.ts"), "utf8");
	assert.match(main, /inspectConfiguredSandboxPreflight/);
	assert.doesNotMatch(main, /inspectBubblewrapRuntime/);
});

test("CLI --check and the deployment wrapper fail with the same common preflight report", async () => {
	await withTempConfig(async ({ configPath }) => {
		const cli = runNode("src/main.ts", ["--check"], { RSI_CONFIG_PATH: configPath });
		const wrapper = runNode("scripts/deployment-preflight.mjs", ["--config", configPath]);
		const cliOutput = `${cli.stdout}\n${cli.stderr}`;
		const wrapperOutput = `${wrapper.stdout}\n${wrapper.stderr}`;
		assert.notEqual(cli.status, 0, cliOutput);
		assert.notEqual(wrapper.status, 0, wrapperOutput);
		assert.match(cliOutput, /Sandbox preflight: FAIL/);
		assert.match(wrapperOutput, /Sandbox preflight: FAIL/);
		assert.match(cliOutput, /protected_hardlinks=|platform/);
		assert.match(wrapperOutput, /protected_hardlinks=|platform/);
		assert.doesNotMatch(wrapperOutput, /CapEff=unavailable/);
		assert.doesNotMatch(wrapperOutput, /bwrap namespace probe passed/);
	});
});

test("production entrypoint smoke consumes the same unified preflight contract", async () => {
	const smoke = await readFile(join(rsiRoot, "scripts/linux-entrypoint-smoke.mjs"), "utf8");
	const entrypoint = await readFile(join(rsiRoot, "scripts/container-entrypoint.sh"), "utf8");
	const launcher = await readFile(join(rsiRoot, "src/sandbox/launcher.ts"), "utf8");
	const targetHarness = await readFile(join(rsiRoot, "test/deployment/linux-target-harness.ts"), "utf8");
	assert.match(entrypoint, /deployment-preflight\.mjs/);
	assert.match(entrypoint, /container-run\.mjs/);
	assert.ok(entrypoint.indexOf("deployment-preflight.mjs") < entrypoint.indexOf("container-run.mjs"));
	assert.match(smoke, /\[rsi-preflight\] full sandbox preflight passed/);
	assert.doesNotMatch(smoke, /bwrap namespace probe passed/);
	for (const marker of [
		"host_uid=",
		"host_gid=",
		"namespace_uid=",
		"namespace_gid=",
		"CapEff=0",
		"supplementary_groups=cleared",
		"namespace=verified",
		"mount=verified",
		"protected_hardlinks=true",
		"protected_symlinks=true",
	]) {
		assert.ok(smoke.includes(marker), `entrypoint acceptance must verify unified preflight fact ${marker}`);
	}
	assert.match(launcher, /inspectBubblewrapRuntime\(this\.options, bwrapCommand\)/);
	assert.match(targetHarness, /inspectBubblewrapRuntime/);
	assert.match(targetHarness, /consumes the same report as `rsi --check` and the deployment/);
});

const linuxSkip =
	process.platform === "linux" ? false : STRICT ? false : "requires Linux; this real bwrap case is not executed here";

test("real Linux preflight verifies host Worker identity, namespaces, CapEff and sysctls", { skip: linuxSkip }, async (t) => {
	if (process.platform !== "linux") {
		throw new Error(
			"RSI_TARGET_STRICT=1 requires a real Linux bwrap preflight; a missing Linux prerequisite is a failure, not a skip.",
		);
	}
	const euid = typeof process.geteuid === "function" ? process.geteuid() : 1;
	if (euid !== 0) {
		if (STRICT) {
			assert.fail("strict target mode requires a root Supervisor able to switch to a distinct Worker host UID");
		}
		t.skip("requires a root Supervisor able to switch to a distinct Worker host UID");
		return;
	}
	const bwrapCommand = process.env.RSI_TEST_BWRAP ?? "bwrap";
	const report = await inspectBubblewrapRuntime(
		{
			workerUid: WORKER_UID,
			workerGid: WORKER_GID,
			supervisorUid: euid,
			supervisorGid: typeof process.getegid === "function" ? process.getegid() : 0,
			probeTimeoutMs: 30_000,
		},
		bwrapCommand,
	);
	if (!report.ok) {
		if (STRICT) assert.fail(`strict real Linux preflight failed: ${report.errors.join(" | ")}`);
		t.skip(`real bwrap preflight unavailable: ${report.errors.join(" | ")}`);
		return;
	}
	assert.equal(report.probeExecuted, true);
	assert.equal(report.hostIdentityVerified, true);
	assert.equal(report.namespaceVerified, true);
	assert.equal(report.mountVerified, true);
	assert.equal(report.capEffZero, true);
	assert.equal(report.supplementaryGroupsCleared, true);
	assert.equal(report.protectedHardlinksEnabled, true);
	assert.equal(report.protectedSymlinksEnabled, true);
	assert.equal(report.observedHostUid, WORKER_UID);
	assert.equal(report.observedHostGid, WORKER_GID);
	assert.equal(report.observedNamespaceUid, WORKER_UID);
	assert.equal(report.observedNamespaceGid, WORKER_GID);
	assert.notEqual(report.probeHostPid, report.probeNamespacePid);
});
