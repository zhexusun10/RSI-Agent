import assert from "node:assert/strict";
import test from "node:test";
import { buildSandboxEnvironment, FORBIDDEN_ENV_KEYS } from "../../src/sandbox/environment.ts";
import { assertSandboxIdentity } from "../../src/sandbox/plan.ts";
import {
	assertPreflightOk,
	formatPreflightReport,
	inspectBubblewrapRuntime,
	resolveBubblewrapExecutable,
} from "../../src/sandbox/preflight.ts";
import type { BubblewrapPreflightReport } from "../../src/sandbox/types.ts";

test("sandbox environment drops Supervisor secrets and injection variables", () => {
	const env = buildSandboxEnvironment({
		inherited: {
			PATH: "/usr/bin:/bin",
			LANG: "C.UTF-8",
			SECRET_TOKEN: "must-not-leak",
			NODE_OPTIONS: "--require=/tmp/evil.js",
			LD_PRELOAD: "/tmp/evil.so",
		},
		explicit: { MODEL_KEY: "explicit-is-allowed" },
		home: "/data/worker-home",
		tmpDir: "/tmp",
		workerUid: 61001,
		timeZone: "UTC",
	});
	assert.equal(env.SECRET_TOKEN, undefined);
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(env.LD_PRELOAD, undefined);
	assert.equal(env.MODEL_KEY, "explicit-is-allowed");
	assert.equal(env.HOME, "/data/worker-home");
	assert.equal(env.TMPDIR, "/tmp");
	assert.equal(env.TZ, "UTC");
	assert.equal(env.PATH, "/usr/bin:/bin");
});

test("explicit environment injection variables fail closed", () => {
	for (const key of FORBIDDEN_ENV_KEYS) {
		assert.throws(
			() =>
				buildSandboxEnvironment({
					explicit: { [key]: "x" },
					home: "/home/worker",
					tmpDir: "/tmp",
					workerUid: 1,
				}),
			(error: unknown) => (error as { code?: string }).code === "SANDBOX_INVALID",
			`${key} must be rejected`,
		);
	}
	assert.throws(
		() =>
			buildSandboxEnvironment({
				explicit: { "BAD-NAME": "x" },
				home: "/home/worker",
				tmpDir: "/tmp",
				workerUid: 1,
			}),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_INVALID",
	);
});

test("worker identity must be non-root, valid, and distinct", () => {
	assert.doesNotThrow(() => assertSandboxIdentity({ workerUid: 61001, workerGid: 61001, supervisorUid: 0 }));
	assert.throws(
		() => assertSandboxIdentity({ workerUid: 0, workerGid: 0, supervisorUid: 0 }),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_INVALID",
	);
	assert.throws(
		() => assertSandboxIdentity({ workerUid: 61001, workerGid: 61001, supervisorUid: 61001 }),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_INVALID",
	);
	assert.throws(
		() => assertSandboxIdentity({ workerUid: -1, workerGid: 1, supervisorUid: 0 }),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_INVALID",
	);
});

test("missing bubblewrap executable is an actionable hard failure", async () => {
	await assert.rejects(
		() => resolveBubblewrapExecutable("/definitely/not/a/real/bwrap"),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_INVALID",
	);
	await assert.rejects(
		() => resolveBubblewrapExecutable("relative/bwrap"),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_INVALID",
	);
});

test(
	"non-Linux runtime preflight fails closed",
	{ skip: process.platform === "linux" ? "Linux host; non-Linux branch is not exercised here" : false },
	async () => {
		const report = await inspectBubblewrapRuntime({ workerUid: 65_534, workerGid: 65_534, supervisorUid: 0 });
		assert.equal(report.ok, false);
		assert.match(report.errors.join("\n"), /only available on Linux/);
		assert.equal(report.bwrapPath, null);
		assert.equal(report.credentialStrategy, "none");
	},
);

test("preflight failures throw instead of falling back to an unsandboxed launch", () => {
	const report: BubblewrapPreflightReport = {
		ok: false,
		errors: ["missing bubblewrap"],
		protectedHardlinksEnabled: false,
		workerUidDistinct: false,
		aliasRisks: [],
		platform: process.platform,
		bwrapPath: null,
		bwrapVersion: null,
		features: { disableUserns: false, seccompFd: false, unshareCgroupTry: false },
		credentialStrategy: "none",
		credentialHelperPath: null,
		checks: [{ name: "bubblewrap", ok: false, message: "missing" }],
	};
	assert.throws(
		() => assertPreflightOk(report),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_INVALID",
	);
	const formatted = formatPreflightReport(report);
	assert.match(formatted, /FAIL/);
	assert.match(formatted, /missing bubblewrap/);
	assert.match(formatted, /bubblewrap: not found/);
});
