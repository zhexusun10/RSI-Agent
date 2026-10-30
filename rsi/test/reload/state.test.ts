import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ImmutableCandidateStore } from "../../src/reload/candidate-store.ts";
import { ReloadSnapshotStore } from "../../src/reload/snapshot-port.ts";
import { ReloadStateStore } from "../../src/reload/state-store.ts";
import {
	initialReloadPersistentState,
	type ReloadHistoryEntry,
	type ReloadPersistentState,
} from "../../src/reload/types.ts";
import { FakeClock, cleanupRoot, makeTempRoot, simplePackage, writeFiles } from "./helpers.ts";

function stateWithHistory(now: Date, count: number): ReloadPersistentState {
	const base = initialReloadPersistentState(now);
	const history: ReloadHistoryEntry[] = Array.from({ length: count }, (_, index) => ({
		attemptId: `attempt-${index}`,
		candidateId: `gen-${String(index + 1).padStart(6, "0")}-abcdefabcdef`,
		generation: index + 1,
		digest: `sha256:${"c".repeat(64)}` as const,
		phase: "prepared",
		atMs: now.getTime() + index,
	}));
	return { ...base, history };
}

test("atomic journal recovers the previous valid state when the main file is corrupt", async () => {
	const root = await makeTempRoot("state-backup");
	try {
		const clock = new FakeClock();
		const stateFile = join(root, "state", "plugins", "state.json");
		const store = new ReloadStateStore({ stateFile, clock });
		const first = { ...initialReloadPersistentState(clock.now()), updatedAtMs: clock.now().getTime() };
		await store.save(first);
		clock.advance(1_000);
		const second = { ...first, updatedAtMs: clock.now().getTime() };
		await store.save(second);
		await writeFile(stateFile, "{ this is not json", "utf8");
		const loaded = await store.load();
		assert.equal(loaded.recovered, true);
		assert.equal(loaded.state.updatedAtMs, first.updatedAtMs);
		assert.ok(loaded.diagnostics.some((line) => /backup/i.test(line)));
		assert.ok((await readFile(`${stateFile}.bak`, "utf8")).includes("\"version\""));
	} finally {
		await cleanupRoot(root);
	}
});

test("journal bounds history and recovers a missing/corrupt main to an empty safe state", async () => {
	const root = await makeTempRoot("state-bounds");
	try {
		const clock = new FakeClock();
		const stateFile = join(root, "state", "plugins", "state.json");
		const store = new ReloadStateStore({ stateFile, clock });
		await store.save(stateWithHistory(clock.now(), 50));
		const loaded = await store.load();
		assert.equal(loaded.state.history.length, 30);
		assert.equal(loaded.state.active, null);
		assert.equal(loaded.state.lkg, null);

		await writeFile(stateFile, "not-json", "utf8");
		await writeFile(`${stateFile}.bak`, "also-not-json", "utf8");
		const recovered = await store.load();
		assert.equal(recovered.state.active, null);
		assert.equal(recovered.state.lkg, null);
		assert.equal(recovered.state.reloading, null);
	} finally {
		await cleanupRoot(root);
	}
});

test("SnapshotStorePort refuses promotion before three healthy turns for the exact candidate", async () => {
	const root = await makeTempRoot("state-promotion-port");
	try {
		const source = join(root, "plugins", "demo");
		await writeFiles(source, simplePackage());
		const clock = new FakeClock();
		const stateDir = join(root, "state");
		const candidateStore = new ImmutableCandidateStore({
			snapshotDir: join(stateDir, "snapshots"),
			forbiddenRoots: [stateDir],
		});
		const candidate = await candidateStore.prepareCandidate({
			generation: 1,
			sourceRoots: [{ id: "demo", path: source, discovery: "extension" }],
			now: clock.now(),
		});
		const stateStore = new ReloadStateStore({ stateFile: join(stateDir, "plugins", "state.json"), clock });
		const base = initialReloadPersistentState(clock.now());
		const active = {
			candidateId: candidate.candidateId,
			generation: candidate.generation,
			digest: candidate.digest,
			path: candidate.path,
			attemptId: "attempt-1",
			phase: "probation" as const,
			loadedAtMs: clock.now().getTime(),
		};
		await stateStore.save({
			...base,
			active,
			health: {
				attemptId: "attempt-1",
				candidateId: candidate.candidateId,
				generation: candidate.generation,
				digest: candidate.digest,
				healthyTurns: 2,
				lastTurnKey: "a:1:1",
				lastTurnIndex: 1,
				startedAtMs: clock.now().getTime(),
			},
		});
		const port = new ReloadSnapshotStore({
			stateStore,
			candidateStore,
			allowlist: { roots: [source], forbiddenRoots: [stateDir] },
			clock,
		});
		await assert.rejects(port.createLkg(candidateStore.toPluginCandidate(candidate), clock.now()), /three healthy/i);

		await stateStore.save({
			...base,
			active,
			health: {
				attemptId: "attempt-1",
				candidateId: candidate.candidateId,
				generation: candidate.generation,
				digest: candidate.digest,
				healthyTurns: 3,
				lastTurnKey: "a:1:2",
				lastTurnIndex: 2,
				startedAtMs: clock.now().getTime(),
			},
		});
		const lkg = await port.createLkg(candidateStore.toPluginCandidate(candidate), clock.now());
		assert.equal(lkg.digest, candidate.digest);
		await candidateStore.verifyLkg(lkg);
	} finally {
		await cleanupRoot(root);
	}
});
