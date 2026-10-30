import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ImmutableCandidateStore } from "../../src/reload/candidate-store.ts";
import { LocalProcessGroupLauncher } from "../../src/reload/process-tree.ts";
import { ReloadPreflight, SandboxLauncherPreflight } from "../../src/reload/preflight-runner.ts";
import { PREFLIGHT_RESULT_ENV } from "../../src/reload/workers/child-protocol.ts";
import type { ReloadCandidate } from "../../src/reload/types.ts";
import {
	FakeClock,
	LOCAL_TEST_SANDBOX_POLICY,
	cleanupRoot,
	makeTempRoot,
	simpleExtensionSource,
	simplePackage,
	writeFiles,
} from "./helpers.ts";

const RSI_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RSI_NODE_MODULES = join(RSI_ROOT, "node_modules");

async function withPreflight(
	label: string,
	files: Record<string, string>,
	run: (context: {
		readonly root: string;
		readonly source: string;
		readonly store: ImmutableCandidateStore;
		readonly preflight: ReloadPreflight;
		readonly candidate: ReloadCandidate;
	}) => Promise<void>,
	options: { readonly trustedDependencyRoots?: readonly string[] } = {},
): Promise<void> {
	const root = await makeTempRoot(`preflight-${label}`);
	try {
		const source = join(root, "plugins", "demo");
		await writeFiles(source, files);
		const store = new ImmutableCandidateStore({
			snapshotDir: join(root, "state", "snapshots"),
			forbiddenRoots: [join(root, "state")],
			trustedDependencyRoots: options.trustedDependencyRoots ?? [RSI_NODE_MODULES],
		});
		const clock = new FakeClock();
		const candidate = await store.prepareCandidate({
			generation: 1,
			sourceRoots: [{ id: "demo", path: source, discovery: "extension" }],
			now: clock.now(),
		});
		const launcher = new SandboxLauncherPreflight(new LocalProcessGroupLauncher(), LOCAL_TEST_SANDBOX_POLICY);
		const preflight = new ReloadPreflight({ candidateStore: store, launcher, clock });
		await run({ root, source, store, preflight, candidate });
	} finally {
		await cleanupRoot(root);
	}
}

/** A passing plugin can exceed 3s only when the host is saturated by other test files. */
async function runPassingPreflight(
	preflight: ReloadPreflight,
	candidate: ReloadCandidate,
): Promise<Awaited<ReturnType<ReloadPreflight["run"]>>> {
	const first = await preflight.run(candidate);
	if (first.report.ok) return first;
	const contentionTimeout =
		first.report.staticSyntaxCheck.ok &&
		first.diagnostics.mockLoad.timedOut &&
		first.report.mockLoad.errors.some((error) => /no preflight result/i.test(error));
	return contentionTimeout ? preflight.run(candidate) : first;
}

test("preflight results are pre-created by the Supervisor and writable by the distinct child UID", async () => {
	await withPreflight("result-owner", { ...simplePackage(), "index.ts": simpleExtensionSource() }, async ({ store, candidate }) => {
		const delegate = new SandboxLauncherPreflight(new LocalProcessGroupLauncher(), LOCAL_TEST_SANDBOX_POLICY);
		let observed = 0;
		const preflight = new ReloadPreflight({
			candidateStore: store,
			clock: new FakeClock(),
			launcher: {
				async launch(input) {
					const info = await lstat(input.env[PREFLIGHT_RESULT_ENV]!);
					assert.equal(info.isFile(), true);
					assert.equal(info.nlink, 1);
					if (process.platform !== "win32") {
						assert.equal(info.uid, process.getuid?.());
						assert.equal(info.mode & 0o666, 0o666);
					}
					observed++;
					return await delegate.launch(input);
				},
			},
		});
		const result = await runPassingPreflight(preflight, candidate);
		assert.equal(result.report.ok, true, JSON.stringify(result.report));
		assert.ok(observed >= 2);
	});
});

test("valid multi-file TypeScript extension passes real static and Mock load", async () => {
	const files: Record<string, string> = {
		"package.json": JSON.stringify({ name: "valid-plugin", version: "1.0.0", type: "module" }),
		"index.ts": [
			'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
			'import { value } from "./lib/helper.ts";',
			"export default function extension(pi: ExtensionAPI): void {",
			"\tpi.registerFlag('valid-plugin', { type: 'boolean', default: true });",
			"\tpi.registerCommand('valid', { description: 'valid', handler: async () => undefined });",
			"\tpi.registerTool({",
			"\t\tname: 'valid_tool',",
			"\t\tdescription: 'valid tool',",
			"\t\tparameters: { type: 'object', properties: {}, additionalProperties: false },",
			"\t\texecute: async () => ({ content: [{ type: 'text', text: String(value) }] }),",
			"\t});",
			"\tpi.on('session_start', () => { if (value !== 42) throw new Error('bad helper'); });",
			"}",
			"",
		].join("\n"),
		"lib/helper.ts": "export const value = 42;\n",
	};
	await withPreflight("valid", files, async ({ preflight, candidate, store }) => {
		const outcome = await runPassingPreflight(preflight, candidate);
		assert.equal(outcome.report.ok, true, JSON.stringify(outcome.report, null, 2));
		assert.equal(outcome.report.staticSyntaxCheck.ok, true);
		assert.equal(outcome.report.mockLoad.ok, true);
		assert.equal(outcome.diagnostics.mockLoad.timedOut, false);
		assert.equal((await store.verifyCandidate(candidate.path)).digest, candidate.digest);
	});
});

test("syntax errors and missing local imports fail static preflight without Mock load", async () => {
	await withPreflight(
		"syntax",
		{
			...simplePackage(),
			"index.ts": "export default function broken( {\n",
		},
		async ({ preflight, candidate }) => {
			const outcome = await preflight.run(candidate);
			assert.equal(outcome.report.ok, false);
			assert.equal(outcome.report.staticSyntaxCheck.ok, false);
			assert.match(outcome.report.staticSyntaxCheck.errors.join("\n"), /TS1005|TS1\d+/);
			assert.match(outcome.report.mockLoad.errors.join("\n"), /skipped/i);
			assert.equal(outcome.diagnostics.mockLoad.exitCode, null);
		},
	);

	await withPreflight(
		"missing-import",
		{
			...simplePackage(),
			"index.ts": 'import { x } from "./missing.ts";\nexport default function extension(): void { void x; }\n',
		},
		async ({ preflight, candidate }) => {
			const outcome = await preflight.run(candidate);
			assert.equal(outcome.report.ok, false);
			assert.match(outcome.report.staticSyntaxCheck.errors.join("\n"), /missing local import|missing/i);
		},
	);

	await withPreflight(
		"nested-syntax",
		{
			...simplePackage(),
			"index.ts": 'import { helper } from "./lib/helper.ts";\nexport default function extension(): void { helper(); }\n',
			"lib/helper.ts": "export function helper( {\n",
		},
		async ({ preflight, candidate }) => {
			const outcome = await preflight.run(candidate);
			assert.equal(outcome.report.ok, false);
			assert.match(outcome.report.staticSyntaxCheck.errors.join("\n"), /helper\.ts/);
		},
	);
});

test("top-level infinite loop is killed by the real 3000ms parent deadline", async () => {
	await withPreflight(
		"infinite-loop",
		{
			...simplePackage(),
			"index.ts": "while (true) {}\nexport default function extension(): void {}\n",
		},
		async ({ preflight, candidate }) => {
			const started = Date.now();
			const outcome = await preflight.run(candidate);
			const elapsed = Date.now() - started;
			assert.equal(outcome.report.ok, false);
			assert.equal(outcome.report.staticSyntaxCheck.ok, true);
			assert.equal(outcome.report.mockLoad.ok, false);
			assert.equal(outcome.diagnostics.mockLoad.timedOut, true);
			assert.ok(elapsed >= 2_800, `expected at least ~3s, got ${elapsed}ms`);
			assert.match(outcome.report.mockLoad.errors.join("\n"), /timed out after 3000ms/i);
			assert.match(outcome.report.mockLoad.errors.join("\n"), /process tree was terminated/i);
			assert.ok(outcome.report.mockLoad.durationMs >= 2_900);
		},
	);
});

test("async factory that never resolves is killed by the parent deadline", async () => {
	await withPreflight(
		"hanging-factory",
		{
			...simplePackage(),
			"index.ts": [
				"export default async function extension(): Promise<void> {",
				"\tawait new Promise<void>(() => undefined);",
				"}",
				"",
			].join("\n"),
		},
		async ({ preflight, candidate }) => {
			const outcome = await preflight.run(candidate);
			assert.equal(outcome.report.ok, false);
			assert.equal(outcome.diagnostics.mockLoad.timedOut, true);
			assert.match(outcome.report.mockLoad.errors.join("\n"), /timed out/i);
		},
	);
});

test("uncaught timer exception and load-time process.exit are reported with diagnostics", async () => {
	await withPreflight(
		"timer-throw",
		{
			...simplePackage(),
			"index.ts": [
				"export default function extension(): void {",
				"\tsetTimeout(() => { throw new Error('timer-boom'); }, 10);",
				"}",
				"",
			].join("\n"),
		},
		async ({ preflight, candidate }) => {
			const outcome = await preflight.run(candidate);
			assert.equal(outcome.report.ok, false);
			assert.match(outcome.report.mockLoad.errors.join("\n"), /timer-boom/);
			assert.notEqual(outcome.diagnostics.mockLoad.exitCode, 0);
		},
	);

	await withPreflight(
		"load-exit",
		{
			...simplePackage(),
			"index.ts": "export default function extension(): void { process.exit(23); }\n",
		},
		async ({ preflight, candidate }) => {
			const outcome = await preflight.run(candidate);
			assert.equal(outcome.report.ok, false);
			assert.match(outcome.report.mockLoad.errors.join("\n"), /exit(ed with code)? 23|code 23|no preflight result/i);
			assert.equal(outcome.diagnostics.mockLoad.exitCode, 23);
		},
	);
});

test("pinned npm Pi 1.4 plugins are not falsely rejected by the Mock API", async () => {
	const root = await makeTempRoot("preflight-pinned");
	try {
		for (const packageName of ["pi-continuity", "pi-better-web-search"]) {
			const source = join(RSI_NODE_MODULES, packageName);
			const store = new ImmutableCandidateStore({
				snapshotDir: join(root, "state", packageName, "snapshots"),
				trustedDependencyRoots: [RSI_NODE_MODULES],
			});
			const clock = new FakeClock();
			const candidate = await store.prepareCandidate({
				generation: 1,
				sourceRoots: [{ id: packageName.replaceAll(".", "-"), path: source, discovery: "extension" }],
				now: clock.now(),
			});
			const launcher = new SandboxLauncherPreflight(new LocalProcessGroupLauncher(), LOCAL_TEST_SANDBOX_POLICY);
			const preflight = new ReloadPreflight({ candidateStore: store, launcher, clock });
			const outcome = await runPassingPreflight(preflight, candidate);
			assert.equal(outcome.report.ok, true, `${packageName}: ${JSON.stringify(outcome.report, null, 2)}`);
			assert.equal(outcome.report.mockLoad.ok, true);
		}
	} finally {
		await cleanupRoot(root);
	}
});

test("preflight tool error text keeps timeout/exit details and blocks reload wording", async () => {
	await withPreflight(
		"tool-error",
		{
			...simplePackage(),
			"index.ts": "export default function extension(): void { process.exit(9); }\n",
		},
		async ({ preflight, candidate }) => {
			const outcome = await preflight.run(candidate);
			const { formatPreflightToolError } = await import("../../src/reload/preflight-runner.ts");
			const text = formatPreflightToolError(outcome.report);
			assert.match(text, /Real Pi reload was not performed/);
			assert.match(text, /exit/i);
		},
	);
});

test("simple extension helper remains type-only compatible", () => {
	assert.match(simpleExtensionSource(), /registerFlag/);
});

test("runtime imports from a writable ancestor node_modules are rejected unless trusted", async () => {
	await withPreflight(
		"untrusted-package",
		{
			...simplePackage(),
			"index.ts": [
				'import { Type } from "typebox";',
				"export default function extension(): void { void Type; }",
				"",
			].join("\n"),
		},
		async ({ preflight, candidate }) => {
			const outcome = await preflight.run(candidate);
			assert.equal(outcome.report.ok, false);
			assert.match(outcome.report.staticSyntaxCheck.errors.join("\n"), /missing package import typebox/i);
		},
		{ trustedDependencyRoots: [] },
	);
});

test("Mock load denies network fetches rather than contacting an external host", async () => {
	await withPreflight(
		"network-denied",
		{
			...simplePackage(),
			"index.ts": [
				"export default async function extension(): Promise<void> {",
				'\tawait fetch("https://example.invalid/preflight");',
				"}",
				"",
			].join("\n"),
		},
		async ({ preflight, candidate }) => {
			const outcome = await preflight.run(candidate);
			assert.equal(outcome.report.ok, false);
			assert.match(outcome.report.mockLoad.errors.join("\n"), /network access|forbidden|fetch/i);
		},
	);
});
