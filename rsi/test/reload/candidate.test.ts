import assert from "node:assert/strict";
import test from "node:test";
import { chmod, link, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ImmutableCandidateStore } from "../../src/reload/candidate-store.ts";
import { FakeClock, cleanupRoot, makeTempRoot, simplePackage, writeFiles } from "./helpers.ts";

async function withFixture(
	label: string,
	files: Record<string, string>,
	run: (context: {
		readonly root: string;
		readonly source: string;
		readonly store: ImmutableCandidateStore;
		readonly clock: FakeClock;
	}) => Promise<void>,
): Promise<void> {
	const root = await makeTempRoot(label);
	try {
		const source = join(root, "workspace", ".pi", "extensions", "demo");
		await writeFiles(source, files);
		const stateDir = join(root, "state");
		const dataDir = join(root, "data");
		await mkdir(stateDir, { recursive: true });
		await mkdir(dataDir, { recursive: true });
		const store = new ImmutableCandidateStore({
			snapshotDir: join(stateDir, "snapshots"),
			forbiddenRoots: [stateDir, dataDir, join(root, "workspace", "markdowns")],
		});
		await run({ root, source, store, clock: new FakeClock() });
	} finally {
		await cleanupRoot(root);
	}
}

test("candidate is content-addressed, read-only, and captures local imports", async () => {
	await withFixture(
		"candidate",
		{
			...simplePackage(),
			"lib/helper.ts": "export const value = 41;\n",
		},
		async ({ root, source, store, clock }) => {
			const candidate = await store.prepareCandidate({
				generation: 1,
				sourceRoots: [{ id: "demo", path: source, discovery: "extension" }],
				now: clock.now(),
			});
			assert.match(candidate.candidateId, /^gen-000001-[0-9a-f]{12}$/);
			assert.equal(candidate.readOnly, true);
			assert.equal(candidate.manifest.entries.length, 1);
			assert.match(candidate.manifest.entries[0] ?? "", /payload\/sources\/demo\/index\.ts$/);
			const entryBytes = await readFile(
				join(candidate.path, ...(candidate.manifest.entries[0] ?? "").split("/")),
				"utf8",
			);
			assert.match(entryBytes, /registerFlag/);
			const verified = await store.verifyCandidate(candidate.path);
			assert.equal(verified.digest, candidate.digest);

			// Source edits after preparation cannot alter the candidate.
			await writeFile(join(source, "index.ts"), "export default function () { throw new Error('new'); }\n");
			const still = await readFile(
				join(candidate.path, ...(candidate.manifest.entries[0] ?? "").split("/")),
				"utf8",
			);
			assert.match(still, /registerFlag/);

			// Tampering breaks digest/read-only checks.
			const payloadFile = join(candidate.path, ...(candidate.manifest.entries[0] ?? "").split("/"));
			await chmod(payloadFile, 0o644);
			await writeFile(payloadFile, "tampered\n");
			await assert.rejects(store.verifyCandidate(candidate.path), /writable|digest|mismatch/i);
			assert.ok(root.length > 0);
		},
	);
});

test("concurrent source edits fail the snapshot instead of mixing bytes", async () => {
	const root = await makeTempRoot("candidate-race");
	try {
		const source = join(root, "plugins", "demo");
		await writeFiles(source, simplePackage());
		const clock = new FakeClock();
		const store = new ImmutableCandidateStore({
			snapshotDir: join(root, "state", "snapshots"),
			forbiddenRoots: [join(root, "state")],
		});
		await assert.rejects(
			store.prepareCandidate({
				generation: 1,
				sourceRoots: [{ id: "demo", path: source, discovery: "extension" }],
				now: clock.now(),
				hooks: {
					beforeSourceRecheck: async () => {
						await writeFile(join(source, "index.ts"), "export default function () { return; } // changed\n");
					},
				},
			}),
			(error: unknown) => (error as { code?: string }).code === "CANDIDATE_CHANGED",
		);
	} finally {
		await cleanupRoot(root);
	}
});

test("symlinks, hardlinks, and pi.extensions escapes are rejected", async () => {
	const root = await makeTempRoot("candidate-unsafe");
	try {
		const source = join(root, "plugins", "demo");
		await writeFiles(source, {
			"package.json": JSON.stringify({ name: "unsafe", version: "1.0.0", pi: { extensions: ["../../outside.ts"] } }),
			"index.ts": "export default function () {}\n",
		});
		await writeFile(join(root, "outside.ts"), "export default function () {}\n");
		const clock = new FakeClock();
		const store = new ImmutableCandidateStore({
			snapshotDir: join(root, "state", "snapshots"),
			forbiddenRoots: [join(root, "state")],
		});
		await assert.rejects(
			store.prepareCandidate({
				generation: 1,
				sourceRoots: [{ id: "demo", path: source, discovery: "extension" }],
				now: clock.now(),
			}),
			/PATH_OUTSIDE_ROOT|escapes|relative/i,
		);

		await writeFiles(source, simplePackage());
		let hardlinked = true;
		try {
			await link(join(source, "index.ts"), join(source, "index-hardlink.ts"));
		} catch {
			hardlinked = false;
		}
		if (hardlinked) {
			await assert.rejects(
				store.prepareCandidate({
					generation: 2,
					sourceRoots: [{ id: "demo", path: source, discovery: "extension" }],
					now: clock.now(),
				}),
				/PATH_HARDLINK_FORBIDDEN|hard link|multiple links/i,
			);
		}
	} finally {
		await cleanupRoot(root);
	}
});

test("an unsafe file added to a snapshot is rejected by verification", async () => {
	await withFixture("candidate-snapshot-unsafe", simplePackage(), async ({ source, store, clock }) => {
		const candidate = await store.prepareCandidate({
			generation: 1,
			sourceRoots: [{ id: "demo", path: source, discovery: "extension" }],
			now: clock.now(),
		});
		const payload = join(candidate.path, "payload", "sources", "demo");
		await chmod(payload, 0o755);
		try {
			await symlink(join(payload, "index.ts"), join(payload, "link.ts"));
		} catch {
			await writeFile(join(payload, "extra.ts"), "export default 1;\n");
		}
		await assert.rejects(store.verifyCandidate(candidate.path), /symlink|digest|CANDIDATE/i);
	});
});

test("LKG restore replaces exact source bytes and preserves user files outside the plugin root", async () => {
	await withFixture(
		"candidate-restore",
		{
			...simplePackage(),
			"lib/helper.ts": "export const value = 1;\n",
		},
		async ({ root, source, store, clock }) => {
			const userDir = join(root, "workspace", "notes");
			const memoryDir = join(root, "markdowns");
			await mkdir(userDir, { recursive: true });
			await mkdir(memoryDir, { recursive: true });
			await writeFile(join(userDir, "task.md"), "user task\n");
			await writeFile(join(memoryDir, "Memory.md"), "memory\n");
			const candidate = await store.prepareCandidate({
				generation: 1,
				sourceRoots: [{ id: "demo", path: source, discovery: "extension" }],
				now: clock.now(),
			});
			const lkg = await store.createLkg(candidate, clock.now(), 3);
			const expected = await readFile(join(source, "index.ts"), "utf8");
			await writeFile(join(source, "index.ts"), "export default function () { throw new Error('bad'); }\n");
			await writeFile(join(source, "broken-extra.ts"), "export default function ( {\n");
			await writeFile(join(source, "lib", "helper.ts"), "export const value = 99;\n");

			await store.restoreCandidateSources(lkg.path, {
				roots: [source],
				forbiddenRoots: [memoryDir, join(root, "state")],
			});
			assert.equal(await readFile(join(source, "index.ts"), "utf8"), expected);
			assert.equal(await readFile(join(source, "lib", "helper.ts"), "utf8"), "export const value = 1;\n");
			await assert.rejects(readFile(join(source, "broken-extra.ts"), "utf8"), /ENOENT/);
			assert.equal(await readFile(join(userDir, "task.md"), "utf8"), "user task\n");
			assert.equal(await readFile(join(memoryDir, "Memory.md"), "utf8"), "memory\n");
			// Restored source is writable for the next Agent edit.
			await writeFile(join(source, "index.ts"), `${expected}// editable\n`);
			await assert.rejects(
				store.restoreCandidateSources(lkg.path, { roots: [join(root, "elsewhere")] }),
				/allowlist|PATH/i,
			);
		},
	);
});

test("interrupted source swap is recovered without losing the old directory", async () => {
	const root = await makeTempRoot("candidate-interrupt");
	try {
		const source = join(root, "plugins", "demo");
		await writeFiles(source, { "index.ts": "export default function () {} // old\n" });
		const snapshotDir = join(root, "state", "snapshots");
		const clock = new FakeClock();
		const store = new ImmutableCandidateStore({
			snapshotDir,
			forbiddenRoots: [join(root, "state")],
		});
		const candidate = await store.prepareCandidate({
			generation: 1,
			sourceRoots: [{ id: "demo", path: source, discovery: "extension" }],
			now: clock.now(),
		});
		await writeFile(join(source, "index.ts"), "export default function () {} // new\n");
		const transactionId = "interrupted-test";
		const backup = join(root, "plugins", `.rsi-backup-${transactionId}`);
		const staged = join(root, "plugins", `.rsi-restore-${transactionId}`);
		await rename(source, backup);
		await mkdir(staged, { recursive: true });
		await mkdir(store.transactionDir, { recursive: true });
		await writeFile(
			join(store.transactionDir, `.rsi-tx-${transactionId}.json`),
			`${JSON.stringify({
				version: 1,
				transactionId,
				target: source,
				staged,
				backup,
				phase: "backed-up",
				updatedAtMs: clock.now().getTime(),
			})}\n`,
			"utf8",
		);
		const report = await store.recoverInterruptedRestores({
			roots: [source],
			forbiddenRoots: [join(root, "state")],
		});
		assert.equal(report.errors.length, 0, report.errors.join("\n"));
		assert.ok(report.recovered.includes(source));
		assert.equal(await readFile(join(source, "index.ts"), "utf8"), "export default function () {} // new\n");
		await store.restoreCandidateSources(candidate.path, {
			roots: [source],
			forbiddenRoots: [join(root, "state")],
		});
		assert.equal(await readFile(join(source, "index.ts"), "utf8"), "export default function () {} // old\n");
	} finally {
		await cleanupRoot(root);
	}
});
