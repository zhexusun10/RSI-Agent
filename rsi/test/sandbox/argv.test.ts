import assert from "node:assert/strict";
import test from "node:test";
import {
	buildBubblewrapArgv,
	buildBubblewrapCredentialCommand,
	buildBubblewrapProbeArgv,
	buildSandboxRuntimeProbeScript,
} from "../../src/sandbox/argv.ts";
import type { SandboxPlan } from "../../src/sandbox/types.ts";

function samplePlan(): SandboxPlan {
	return {
		bwrapPath: "/usr/bin/bwrap",
		workerUid: 61001,
		workerGid: 61001,
		executable: "/usr/bin/node",
		args: ["/srv/worker.mjs", "--flag", "value with spaces"],
		cwd: "/workspace",
		env: {
			PATH: "/usr/bin:/bin",
			HOME: "/data/worker-home",
			PROBE_VALUE: "a b; echo not-a-shell",
		},
		hostname: "rsi-worker",
		writableMounts: [
			{ source: "/workspace", target: "/workspace", mode: "rw", reason: "workspace" },
			{ source: "/data/plugin-edit", target: "/data/plugin-edit", mode: "rw", reason: "plugin-edit" },
		],
		readOnlyMounts: [
			{ source: "/data/state/run", target: "/run/rsi", mode: "ro", reason: "run" },
			{ source: "/data/state/snapshots/g1", target: "/run/rsi-plugins/g1", mode: "ro", reason: "plugin-candidate" },
			{ source: "/app/pi", target: "/app/pi", mode: "ro", reason: "protected" },
			{ source: "/app/rsi", target: "/app/rsi", mode: "ro", reason: "protected" },
		],
		fileMasks: ["/var/run/docker.sock"],
		hidden: [{ target: "/data/state", kind: "directory" }],
		protectedRoots: ["/app/pi", "/app/rsi"],
		hiddenRoots: ["/data/state"],
		features: { disableUserns: true, seccompFd: true, unshareCgroupTry: true },
		nestedUsernsFilterPath: "/tmp/rsi-userns-test/filter.bpf",
		purpose: "worker",
	};
}

test("argv keeps network unrestricted and the broad root writable", () => {
	const argv = buildBubblewrapArgv(samplePlan());
	assert.equal(argv.includes("--unshare-net"), false);
	assert.equal(argv.includes("--share-net"), false);
	const bindIndex = argv.findIndex(
		(value, index) => value === "--bind" && argv[index + 1] === "/" && argv[index + 2] === "/",
	);
	assert.notEqual(bindIndex, -1, "the container root must be writable, not workspace-only");
	assert.equal(
		argv.some((value, index) => value === "--ro-bind" && argv[index + 1] === "/" && argv[index + 2] === "/"),
		false,
		"the whole root filesystem must not be made read-only",
	);
});

test("argv unshares required namespaces, blocks nested userns via seccomp, and drops caps", () => {
	const argv = buildBubblewrapArgv(samplePlan());
	for (const flag of [
		"--unshare-user",
		"--seccomp",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-cgroup-try",
		"--die-with-parent",
		"--new-session",
	]) {
		assert.equal(argv.includes(flag), true, `missing ${flag}`);
	}
	assert.equal(argv[argv.indexOf("--seccomp") + 1], "3", "the filter must use the inherited fd 3");
	assert.deepEqual(argv.slice(argv.indexOf("--cap-drop"), argv.indexOf("--cap-drop") + 2), [
		"--cap-drop",
		"ALL",
	]);
	assert.equal(argv[argv.indexOf("--uid") + 1], "61001");
	assert.equal(argv[argv.indexOf("--gid") + 1], "61001");
});

test("protected mounts are applied after writable mounts; hidden state is last", () => {
	const argv = buildBubblewrapArgv(samplePlan());
	const workspace = argv.indexOf("/workspace");
	const pluginEdit = argv.indexOf("/data/plugin-edit");
	const run = argv.indexOf("/run/rsi");
	const candidate = argv.indexOf("/run/rsi-plugins/g1");
	const pi = argv.indexOf("/app/pi");
	const rsi = argv.indexOf("/app/rsi");
	const hidden = argv.indexOf("/data/state");
	assert.ok(workspace !== -1 && pluginEdit !== -1 && run !== -1 && candidate !== -1);
	assert.ok(workspace < pi && pluginEdit < pi);
	assert.ok(run < pi && candidate < rsi, "protected binds must override earlier mounts");
	assert.ok(pi < hidden && rsi < hidden, "hidden tmpfs must be applied after protected binds");
	assert.ok(argv.indexOf("/usr/bin/node") > hidden, "the Worker command must be last");
});

test("environment values and arguments remain single argv elements", () => {
	const argv = buildBubblewrapArgv(samplePlan());
	const envAt = argv.indexOf("PROBE_VALUE");
	assert.notEqual(envAt, -1);
	assert.equal(argv[envAt - 1], "--setenv");
	assert.equal(argv[envAt + 1], "a b; echo not-a-shell");
	assert.equal(argv.includes("a b; echo not-a-shell"), true);
	const commandIndex = argv.indexOf("/usr/bin/node");
	assert.deepEqual(argv.slice(commandIndex), ["/usr/bin/node", "/srv/worker.mjs", "--flag", "value with spaces"]);
});

test("sensitive sockets are masked with the sandbox /dev/null, not a host device", () => {
	const argv = buildBubblewrapArgv(samplePlan());
	const maskIndex = argv.findIndex(
		(value, index) =>
			value === "--ro-bind" &&
			argv[index + 1] === "/dev/null" &&
			argv[index + 2] === "/var/run/docker.sock",
	);
	assert.notEqual(maskIndex, -1);
	assert.ok(argv.indexOf("--dev") < maskIndex, "minimal /dev must exist before masks");
});

test("probe uses the same namespace/capability shape without user code", () => {
	const argv = buildBubblewrapProbeArgv({
		bwrapPath: "/usr/bin/bwrap",
		workerUid: 61001,
		workerGid: 61001,
		nodePath: "/usr/bin/node",
		features: { disableUserns: true, seccompFd: true, unshareCgroupTry: false },
		nestedUsernsFilterPath: "/tmp/rsi-userns-test/filter.bpf",
		probeCode: "process.exit(0)",
	});
	assert.equal(argv[0], "/usr/bin/bwrap");
	assert.equal(argv.includes("--unshare-net"), false);
	assert.equal(argv.includes("--seccomp"), true);
	assert.equal(argv[argv.indexOf("--seccomp") + 1], "3");
	assert.equal(argv.includes("--cap-drop"), true);
	assert.equal(argv[argv.indexOf("--hostname") + 1], "rsi-preflight");
	assert.deepEqual(argv.slice(-3), ["/usr/bin/node", "-e", "process.exit(0)"]);
});

test("runtime probe script reports facts but never decides pass/fail itself", () => {
	const script = buildSandboxRuntimeProbeScript({
		workerUid: 61001,
		workerGid: 61001,
		marker: "marker-fixture",
		holdMs: 10,
	});
	for (const marker of ["RSI_PREFLIGHT_READY", "RSI_PREFLIGHT_RESULT", "CapEff", "/proc/self/ns/", "mountinfo", "getgroups", "nestedUsernsBlocked", "/usr/bin/unshare"]) {
		assert.equal(script.includes(marker), true, `runtime probe must report ${marker}`);
	}
	assert.equal(script.includes("process.exit(41)"), false, "the in-sandbox script must not be the pass/fail authority");
	assert.doesNotThrow(() => new Function(script), "generated probe script must be valid JavaScript");
});

test("credential command uses the real production setpriv/spawn switch", () => {
	const setpriv = buildBubblewrapCredentialCommand({
		bwrapPath: "/usr/bin/bwrap",
		bwrapArgs: ["--unshare-user"],
		workerUid: 61001,
		workerGid: 61002,
		strategy: "setpriv",
		credentialHelperPath: "/usr/bin/setpriv",
	});
	assert.equal(setpriv.command, "/usr/bin/setpriv");
	assert.deepEqual(setpriv.args, [
		"--reuid",
		"61001",
		"--regid",
		"61002",
		"--clear-groups",
		"--",
		"/usr/bin/bwrap",
		"--unshare-user",
	]);
	assert.equal(setpriv.spawnUid, undefined);

	const spawnIdentity = buildBubblewrapCredentialCommand({
		bwrapPath: "/usr/bin/bwrap",
		bwrapArgs: ["--unshare-user"],
		workerUid: 61001,
		workerGid: 61002,
		strategy: "spawn-uid",
	});
	assert.equal(spawnIdentity.command, "/usr/bin/bwrap");
	assert.deepEqual(spawnIdentity.args, ["--unshare-user"]);
	assert.equal(spawnIdentity.spawnUid, 61001);
	assert.equal(spawnIdentity.spawnGid, 61002);
});
