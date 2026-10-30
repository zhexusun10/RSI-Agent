#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const scriptDir = dirname(fileURLToPath(import.meta.url));
export const rsiRoot = resolve(scriptDir, "..");
export const repoRoot = resolve(rsiRoot, "..");
export const seccompPath = resolve(rsiRoot, "deploy", "seccomp-bwrap.json");
export const testMountPath = resolve(rsiRoot, "test");
export const targetTestFile = "/opt/rsi/test/deployment/linux-target-acceptance.test.ts";
export const soakRunnerFile = "/opt/rsi/test/deployment/linux-soak-runner.ts";
export const restartPhaseFile = "/opt/rsi/test/deployment/linux-target-restart-phase.ts";
export const TARGET_PROMPT_FIXTURE =
	"TARGET-VALIDATION-HUMAN-PROMPT-FIXTURE\nThis temporary fixture is never installed as a production prompt.\n";

export function secretRedactionValues(env = process.env) {
	return Object.entries(env)
		.filter(([name, value]) => {
			if (typeof value !== "string" || value.length < 8) return false;
			return /(key|token|secret|password|credential|auth)/i.test(name);
		})
		.map(([, value]) => value);
}

export function redact(text, values = secretRedactionValues()) {
	let result = String(text);
	for (const value of values) {
		if (value.length >= 8) result = result.split(value).join("[REDACTED]");
	}
	return result
		.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
		.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/gi, "$1[REDACTED]");
}

export function formatCommand(command, args) {
	return [command, ...args].map((item) => JSON.stringify(item)).join(" ");
}

export function runCommand(
	command,
	args,
	{ cwd = repoRoot, env = process.env, timeoutMs = 0, stream = true, label = "" } = {},
) {
	return new Promise((resolveRun, rejectRun) => {
		const redactions = secretRedactionValues(env);
		if (stream) {
			console.error(`[target] ${label ? `${label}: ` : ""}${formatCommand(command, args)}`);
		}
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						try {
							child.kill("SIGKILL");
						} catch {
							// The close handler reports the timeout.
						}
					}, timeoutMs)
				: undefined;
		timer?.unref?.();
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stream) process.stdout.write(redact(chunk, redactions));
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (stream) process.stderr.write(redact(chunk, redactions));
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			rejectRun(error);
		});
		child.on("close", (status, signal) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolveRun({
				status,
				signal,
				stdout: redact(stdout, redactions),
				stderr: redact(stderr, redactions),
				timedOut,
			});
		});
	});
}

export async function hostPrerequisiteSnapshot() {
	if (process.platform !== "linux") {
		throw new Error(`Linux target validation requires a Linux host; current platform is ${process.platform}.`);
	}
	const read = async (path) => {
		try {
			return (await readFile(path, "utf8")).trim();
		} catch {
			return "unavailable";
		}
	};
	return {
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		kernel: (await import("node:os")).release(),
		protectedHardlinks: await read("/proc/sys/fs/protected_hardlinks"),
		protectedSymlinks: await read("/proc/sys/fs/protected_symlinks"),
		unprivilegedUsernsClone: await read("/proc/sys/kernel/unprivileged_userns_clone"),
		maxUserNamespaces: await read("/proc/sys/user/max_user_namespaces"),
		apparmorRestrictUnprivilegedUserns: await read(
			"/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
		),
		setpriv: existsSync("/usr/bin/setpriv"),
		bwrap: existsSync("/usr/bin/bwrap"),
		dockerSocket: existsSync("/var/run/docker.sock"),
	};
}

export function assertHostPrerequisites(snapshot) {
	if (snapshot.protectedHardlinks !== "1") {
		throw new Error(
			`fs.protected_hardlinks must be 1 on the target host (found ${snapshot.protectedHardlinks}).`,
		);
	}
	if (snapshot.protectedSymlinks !== "1") {
		throw new Error(
			`fs.protected_symlinks must be 1 on the target host (found ${snapshot.protectedSymlinks}).`,
		);
	}
	if (snapshot.maxUserNamespaces !== "unavailable" && Number(snapshot.maxUserNamespaces) <= 0) {
		throw new Error(`user.max_user_namespaces must be positive (found ${snapshot.maxUserNamespaces}).`);
	}
}

export async function assertDockerDaemon() {
	const info = await runCommand("docker", ["info", "--format", "{{json .ServerVersion}}"], {
		timeoutMs: 30_000,
		label: "docker-daemon",
	});
	if (info.status !== 0) {
		throw new Error(
			"Docker daemon is not available. Linux/Docker acceptance cannot be claimed from compose syntax or static Dockerfile checks.\n" +
				`${info.stderr || info.stdout}`,
		);
	}
	return info.stdout.trim();
}

export async function verifyImageBubblewrap(image, timeoutMs) {
	const version = await runCommand("docker", ["run", "--rm", "--entrypoint", "bwrap", image, "--version"], {
		timeoutMs,
		label: "image-bwrap-version",
	});
	if (version.status !== 0) throw new Error(`Image bwrap --version failed: ${version.stderr}`);
	const help = await runCommand(
		"docker",
		[
			"run",
			"--rm",
			"--entrypoint",
			"sh",
			image,
			"-c",
			"bwrap --help 2>&1 | grep -q -- '--seccomp' && printf 'FEATURE_SECCOMP_FD=yes\\n'",
		],
		{ timeoutMs, label: "image-bwrap-feature" },
	);
	if (help.status !== 0) {
		throw new Error(
			`Image bubblewrap lacks the required --seccomp FD feature.\n${version.stdout}${version.stderr}${help.stderr}`,
		);
	}
	return {
		version: version.stdout.trim().split("\n")[0] ?? "unknown",
		seccompFd: /FEATURE_SECCOMP_FD=yes/.test(help.stdout),
	};
}

export async function buildImage(image, timeoutMs) {
	const result = await runCommand(
		"docker",
		["build", "--file", join(rsiRoot, "Dockerfile"), "--tag", image, "."],
		{ cwd: repoRoot, timeoutMs, label: "docker-build" },
	);
	if (result.status !== 0) {
		throw new Error(`Docker image build failed with exit code ${String(result.status)}.`);
	}
	return result;
}

export async function createDockerVolumes(prefix) {
	const unique = `${prefix}-${process.pid}-${Date.now().toString(36)}`;
	const data = `${unique}-data`;
	const state = `${unique}-state`;
	for (const name of [data, state]) {
		const result = await runCommand("docker", ["volume", "create", "--label", "rsi.validation=true", name], {
			timeoutMs: 30_000,
			label: "volume-create",
		});
		if (result.status !== 0) throw new Error(`Could not create Docker volume ${name}: ${result.stderr}`);
	}
	return { data, state, unique };
}

export async function removeDockerVolumes(names) {
	for (const name of names) {
		await runCommand("docker", ["volume", "rm", "-f", name], {
			timeoutMs: 30_000,
			stream: false,
		}).catch(() => undefined);
	}
}

export async function makePromptFixture() {
	const dir = await mkdtemp(join(tmpdir(), "rsi-target-prompt-"));
	const file = join(dir, "manual-prompt-fixture.txt");
	await writeFile(file, TARGET_PROMPT_FIXTURE, { mode: 0o644 });
	return { dir, file };
}

export async function makeTempDir(prefix = "rsi-target-artifacts-") {
	return await mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupTempDir(dir) {
	if (dir) await rm(dir, { recursive: true, force: true });
}

export function dockerRunArgs({
	image,
	containerName,
	dataVolume,
	stateVolume,
	promptFile,
	artifactsDir,
	env,
	command,
	args,
}) {
	const dockerArgs = [
		"run",
		"--rm",
		"--name",
		containerName,
		"--init",
		"--pids-limit",
		"512",
		"--stop-timeout",
		"30",
		"--cap-drop",
		"ALL",
		"--cap-add",
		"SETUID",
		"--cap-add",
		"SETGID",
		"--cap-add",
		"CHOWN",
		"--cap-add",
		"KILL",
		"--security-opt",
		`seccomp=${seccompPath}`,
		"--security-opt",
		"apparmor=unconfined",
		"--security-opt",
		"systempaths=unconfined",
		"--tmpfs",
		"/tmp:rw,size=256m,mode=1777",
		"--mount",
		`type=volume,source=${dataVolume},target=/data,volume-nocopy`,
		"--mount",
		`type=volume,source=${stateVolume},target=/state,volume-nocopy`,
		"--mount",
		`type=bind,source=${resolve(promptFile)},target=/run/rsi-target/prompt.txt,readonly`,
		"--mount",
		`type=bind,source=${testMountPath},target=/opt/rsi/test,readonly`,
	];
	if (artifactsDir) {
		dockerArgs.push("--mount", `type=bind,source=${resolve(artifactsDir)},target=/run/rsi-artifacts`);
	}
	for (const [name, value] of Object.entries(env ?? {})) {
		dockerArgs.push("--env", `${name}=${String(value)}`);
	}
	dockerArgs.push("--entrypoint", "node", image, command, ...args);
	return dockerArgs;
}

export async function removeContainer(containerName) {
	await runCommand("docker", ["rm", "-f", containerName], {
		timeoutMs: 30_000,
		stream: false,
	}).catch(() => undefined);
}

export function parseBooleanArg(value) {
	return value === true || value === "true" || value === "1" || value === "yes";
}
