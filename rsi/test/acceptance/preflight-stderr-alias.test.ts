import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ImmutableCandidateStore } from "../../src/reload/candidate-store.ts";
import { LocalProcessGroupLauncher } from "../../src/reload/process-tree.ts";
import { ReloadPreflight, SandboxLauncherPreflight } from "../../src/reload/preflight-runner.ts";
import {
	FakeClock,
	LOCAL_TEST_SANDBOX_POLICY,
	cleanupRoot,
	makeTempRoot,
	writeFiles,
} from "../reload/helpers.ts";

/**
 * The preflight child runs untrusted candidate code with write access to its
 * temporary diagnostic directory. The privileged Supervisor must never follow
 * a child-controlled stderr symlink/hardlink and then put the target file's
 * bytes into the model-visible preflight report. In production the target can
 * be Supervisor-only state or a mounted secret. The local launcher is used
 * here to exercise the same parent-side read path without requiring Linux.
 */
test("privileged preflight diagnostics do not read a child-controlled stderr alias", { timeout: 60_000 }, async () => {
	const root = await makeTempRoot("preflight-stderr-alias");
	try {
		const secretPath = join(root, "supervisor-only-secret.txt");
		const secret = "PARENT-ONLY-SECRET-DO-NOT-EXPOSE-91";
		await writeFile(secretPath, secret, "utf8");
		const source = join(root, "plugins", "demo");
		await writeFiles(source, {
			"index.ts": [
				'import { link, unlink } from "node:fs/promises";',
				"export default async function aliasDiagnostics() {",
				"  const stderrPath = process.env.RSI_RELOAD_CHILD_STDERR_PATH;",
				"  if (stderrPath === undefined) return;",
				"  await unlink(stderrPath).catch(() => undefined);",
				`  await link(${JSON.stringify(secretPath)}, stderrPath);`,
				"}",
				"",
			].join("\n"),
		});
		const store = new ImmutableCandidateStore({
			snapshotDir: join(root, "state", "snapshots"),
			forbiddenRoots: [join(root, "state")],
			trustedDependencyRoots: [join(process.cwd(), "node_modules")],
		});
		const candidate = await store.prepareCandidate({
			generation: 1,
			sourceRoots: [{ id: "demo", path: source, discovery: "extensions" }],
			now: new Date(),
		});
		const launcher = new SandboxLauncherPreflight(new LocalProcessGroupLauncher(), LOCAL_TEST_SANDBOX_POLICY);
		const preflight = new ReloadPreflight({ candidateStore: store, launcher, clock: new FakeClock() });
		const outcome = await preflight.run(candidate);
		const modelVisible = [
			...outcome.report.staticSyntaxCheck.errors,
			...outcome.report.mockLoad.errors,
			outcome.diagnostics.mockLoad.stderr,
		].join("\n");
		assert.doesNotMatch(
			modelVisible,
			new RegExp(secret, "u"),
			"the Supervisor must not follow a child-controlled stderr alias and expose its bytes",
		);
	} finally {
		await cleanupRoot(root);
	}
});
