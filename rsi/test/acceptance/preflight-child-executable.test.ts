import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isPathWithin } from "../../src/shared/paths.ts";
import { test } from "node:test";
import { MappedPreflightLauncher } from "../../src/integration/reload-service.ts";
import type { SandboxHandle, SandboxLauncher, SandboxPolicy } from "../../src/shared/sandbox.ts";
import type { SandboxExecutionRequest } from "../../src/sandbox/types.ts";

/**
 * Production preflight does not use the local test launcher: it uses the
 * bubblewrap launcher, which exec()s the request's executable directly. The
 * static/mock preflight entries are TypeScript source files with no shebang,
 * so the request must run the trusted Node executable with the source entry in
 * argv. Sending the .ts path as the executable makes every reload preflight
 * fail (EACCES/ENOEXEC) in the real Linux deployment even though the Windows
 * local launcher hides the problem by wrapping it in `node`.
 */
test("production preflight requests use the trusted Node executable for .ts entries", async () => {
	const requests: SandboxExecutionRequest[] = [];
	const fakeLauncher: SandboxLauncher = {
		async launch(request: SandboxExecutionRequest): Promise<SandboxHandle> {
			requests.push(request);
			return {
				pid: 1,
				startedAtMs: 0,
				async wait() {
					return { exitCode: 0, signal: null };
				},
				async terminate() {},
			};
		},
	};
	const policy = {
		kind: "bubblewrap",
		bwrapPath: "bwrap",
		network: "unrestricted",
		capabilities: [],
		noNewPrivileges: true,
		unsharePid: true,
		unshareIpc: true,
		unshareUts: true,
		procfs: "isolated",
		rootFilesystem: "container-root",
		protected: [],
		canonicalProtected: [],
		hidden: [],
		writable: [],
		ipc: {
			transport: "unix",
			hostSocketPath: "/state/run/worker.sock",
			workerSocketPath: "/run/rsi/worker.sock",
			stdoutIsProtocol: false,
		},
		hardlinkPolicy: "broker-owned-nlink-1-and-protected-hardlinks",
	} as const satisfies SandboxPolicy;
	const launcher = new MappedPreflightLauncher({
		launcher: fakeLauncher,
		policy,
		snapshotDir: "/state/snapshots",
		sandboxPathMapping: false,
	});
	const entry = resolve("src/reload/workers/static-check-worker.ts");
	await launcher.launch({ workerEntry: entry, cwd: resolve("src/reload/workers"), env: {} });
	assert.equal(requests.length, 1);
	const request = requests[0]!;
	assert.equal(
		request.executable,
		process.execPath,
		"bwrap must exec the trusted Node binary, not the .ts source file",
	);
	assert.deepEqual(
		request.args,
		[entry],
		"the .ts preflight entry must be passed as argv to Node",
	);
	assert.equal(
		isPathWithin(resolve("."), request.cwd),
		false,
		"preflight cwd must be outside the protected RSI source tree",
	);
	assert.equal(
		isPathWithin(dirname(entry), request.cwd),
		false,
		"preflight cwd must not be the worker entry's protected source directory",
	);
	assert.equal(
		(await stat(request.cwd)).isDirectory(),
		true,
		"the preflight cwd must be an existing, usable staging directory",
	);
});
