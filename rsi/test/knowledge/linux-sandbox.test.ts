import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createKnowledgeFixture, errorCode } from "./helpers.ts";
import { createManagedNativeToolOperations } from "../../src/knowledge/native-tools.ts";
import { createSandboxPolicy } from "../../src/shared/sandbox.ts";
import { deriveRuntimePaths } from "../../src/shared/paths.ts";

function findBwrap(): string | undefined {
	if (process.platform !== "linux") return undefined;
	const result = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
	return result.status === 0 ? "bwrap" : undefined;
}

const bwrap = findBwrap();

test("sandbox contract marks markdowns read-only and state hidden", async () => {
	const fixture = await createKnowledgeFixture();
	try {
		const base = fixture.baseDir;
		const piSource = join(base, "pi-source");
		const rsiSource = join(base, "rsi-source");
		const workspace = join(base, "workspace");
		const prompt = join(base, "manual.txt");
		await mkdir(piSource);
		await mkdir(rsiSource);
		await mkdir(workspace);
		await writeFile(prompt, "");
		const paths = deriveRuntimePaths({
			workspaceDir: workspace,
			dataDir: join(base, "data"),
			stateDir: fixture.stateDir,
			piSourceDir: piSource,
			rsiSourceDir: rsiSource,
			systemPromptFile: prompt,
			markdownsDir: fixture.markdownsDir,
			hostIpcSocketPath: join(fixture.stateDir, "worker.sock"),
		});
		const policy = createSandboxPolicy(paths, "bwrap", {
			protectedPaths: [],
			canonicalStateDir: fixture.stateDir,
		});
		const markdownProtection = policy.protected.find((entry) => entry.reason === "managed-markdowns");
		assert.equal(markdownProtection?.source, fixture.markdownsDir);
		assert.equal(markdownProtection?.mode, "ro");
		assert.equal(policy.hidden.includes(fixture.stateDir), true);
		assert.equal(policy.hardlinkPolicy, "broker-owned-nlink-1-and-protected-hardlinks");
		assert.equal(
			policy.writable.some((mount) => mount.source === fixture.markdownsDir),
			false,
		);
		const operations = createManagedNativeToolOperations(fixture.service);
		await assert.rejects(
			() => operations.write.writeFile(join(workspace, "workspace.md"), "direct"),
			(error: unknown) => errorCode(error) === "PATH_OUTSIDE_ROOT",
		);
	} finally {
		await fixture.cleanup();
	}
});

test(
	"Linux bwrap fixture blocks direct write, unlink, and hardlink escapes from the managed mount",
	{
		skip:
			process.platform !== "linux"
				? "Linux-only bwrap integration; not a claimed security verification on this host"
				: bwrap === undefined
					? "bwrap is not installed; sandbox integration not verified"
					: false,
	},
	async (t) => {
		const fixture = await createKnowledgeFixture();
		try {
			const base = fixture.baseDir;
			const piSource = join(base, "pi-source");
			const rsiSource = join(base, "rsi-source");
			const workspace = join(base, "workspace");
			const prompt = join(base, "manual.txt");
			const dataDir = join(base, "data");
			await mkdir(piSource);
			await mkdir(rsiSource);
			await mkdir(workspace);
			await mkdir(dataDir);
			await writeFile(prompt, "");
			const marker = join(fixture.stateDir, "secret-marker.txt");
			await writeFile(marker, "external state");
			const paths = deriveRuntimePaths({
				workspaceDir: workspace,
				dataDir,
				stateDir: fixture.stateDir,
				piSourceDir: piSource,
				rsiSourceDir: rsiSource,
				systemPromptFile: prompt,
				markdownsDir: fixture.markdownsDir,
				hostIpcSocketPath: join(fixture.stateDir, "worker.sock"),
			});
			for (const directory of [
				paths.piAgentDir,
				paths.piSessionDir,
				paths.workerHomeDir,
				paths.runDir,
			]) {
				await mkdir(directory, { recursive: true });
			}
			createSandboxPolicy(paths, "bwrap", {
				protectedPaths: [],
				canonicalStateDir: fixture.stateDir,
			});
			const indexBefore = await readFile(join(fixture.markdownsDir, "index.md"));
			const indexStatBefore = await stat(join(fixture.markdownsDir, "index.md"));

			let protectedHardlinks = false;
			try {
				protectedHardlinks = (await readFile("/proc/sys/fs/protected_hardlinks", "utf8")).trim() === "1";
			} catch {
				protectedHardlinks = false;
			}
			const script = `
import { link, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
const markdowns = ${JSON.stringify(fixture.markdownsDir)};
const state = ${JSON.stringify(fixture.stateDir)};
const workspace = ${JSON.stringify(workspace)};
const index = markdowns + "/index.md";
const result = {};
const attempt = async (name, fn) => {
  try { await fn(); result[name] = "allowed"; }
  catch (error) { result[name] = "blocked:" + (error && error.code ? error.code : "error"); }
};
await attempt("readManaged", async () => { await readFile(index, "utf8"); });
await attempt("writeManaged", async () => { await writeFile(index, "changed"); });
await attempt("unlinkManaged", async () => { await unlink(index); });
await attempt("renameManaged", async () => { await rename(index, markdowns + "/renamed.md"); });
await attempt("symlinkManaged", async () => { await symlink(index, workspace + "/alias.md"); });
await attempt("writeThroughAlias", async () => { await writeFile(workspace + "/alias.md", "changed"); });
await attempt("hardlinkManaged", async () => { await link(index, workspace + "/hard.md"); });
await attempt("writeWorkspace", async () => { await writeFile(workspace + "/ok.txt", "workspace write"); });
await attempt("readState", async () => { await readFile(state + "/secret-marker.txt", "utf8"); });
await attempt("writeState", async () => { await writeFile(state + "/new.txt", "tmpfs write"); });
console.log(JSON.stringify(result));
`;
			const args = [
				"--die-with-parent",
				"--unshare-pid",
				"--unshare-ipc",
				"--unshare-uts",
				"--cap-drop",
				"ALL",
				"--ro-bind",
				"/",
				"/",
				"--dev",
				"/dev",
				"--proc",
				"/proc",
				"--tmpfs",
				"/tmp",
				"--tmpfs",
				fixture.stateDir,
				"--bind",
				workspace,
				workspace,
				"--bind",
				paths.piAgentDir,
				paths.piAgentDir,
				"--bind",
				paths.piSessionDir,
				paths.piSessionDir,
				"--bind",
				paths.workerHomeDir,
				paths.workerHomeDir,
				"--ro-bind",
				paths.runDir,
				paths.runDir,
				"--ro-bind",
				fixture.markdownsDir,
				fixture.markdownsDir,
				"--chdir",
				workspace,
				"--",
				process.execPath,
				"--input-type=module",
				"-e",
				script,
			];
			const run = spawnSync((bwrap as string), args, {
				encoding: "utf8",
				timeout: 20_000,
				env: { ...process.env, HOME: workspace, TMPDIR: "/tmp" },
			});
			const stdoutLines = (run.stdout ?? "").trim().split(/\r?\n/u).filter(Boolean);
			const lastLine = stdoutLines[stdoutLines.length - 1] ?? "";
			let result: Record<string, string> | undefined;
			try {
				result = JSON.parse(lastLine) as Record<string, string>;
			} catch {
				const stderr = run.stderr ?? "";
				if (/Operation not permitted|Permission denied|No permissions to create new namespace|setting up uid map/iu.test(stderr)) {
					t.skip(`bwrap cannot create a user namespace on this host: ${stderr.split(/\r?\n/u)[0] ?? ""}`);
					return;
				}
				assert.fail(`bwrap fixture did not produce a result: ${stderr || run.error?.message || lastLine}`);
			}
			assert.equal(result.readManaged, "allowed");
			assert.match(result.writeManaged ?? "", /^blocked:/u);
			assert.match(result.unlinkManaged ?? "", /^blocked:/u);
			assert.match(result.renameManaged ?? "", /^blocked:/u);
			assert.match(result.writeThroughAlias ?? "", /^blocked:/u);
			if (protectedHardlinks) {
				assert.match(result.hardlinkManaged ?? "", /^blocked:/u);
			} else {
				t.diagnostic(
					"fs.protected_hardlinks is not 1 on this host; hardlink escape was not counted as verified.",
				);
			}
			assert.equal(result.writeWorkspace, "allowed");
			assert.match(result.readState ?? "", /^blocked:/u);
			assert.equal(await readFile(marker, "utf8"), "external state");
			assert.deepEqual(await readFile(join(fixture.markdownsDir, "index.md")), indexBefore);
			assert.equal((await stat(join(fixture.markdownsDir, "index.md"))).mtimeMs, indexStatBefore.mtimeMs);
		} finally {
			await fixture.cleanup();
		}
	},
);
