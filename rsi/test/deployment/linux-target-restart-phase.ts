#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SystemClock } from "../../src/shared/time.ts";
import { RecoveryNoticeStore } from "../../src/watchdog/notifications.ts";
import {
	detectTargetPrerequisites,
	readJson,
	startTargetHarness,
	waitFor,
} from "./linux-target-harness.ts";

const phase = process.argv[2];
if (phase !== "prepare" && phase !== "verify") {
	throw new Error("Usage: linux-target-restart-phase.ts prepare|verify");
}
const dataBase = process.env.RSI_TARGET_DATA_ROOT ?? "/data";
const stateBase = process.env.RSI_TARGET_STATE_ROOT ?? "/state";
const promptFile = process.env.RSI_TARGET_PROMPT_FILE;
const restartId = process.env.RSI_TARGET_RESTART_ID ?? "";
if (promptFile === undefined || !/^[a-z0-9-]{1,64}$/.test(restartId)) {
	throw new Error("RSI_TARGET_PROMPT_FILE and a safe RSI_TARGET_RESTART_ID are required.");
}
const prerequisites = await detectTargetPrerequisites();
if (prerequisites.skipReason !== undefined) {
	throw new Error(`Restart phase prerequisites failed: ${prerequisites.skipReason}`);
}
const root = join(dataBase, `restart-${restartId}`);
const stateDir = join(stateBase, `restart-${restartId}`);
const markerPath = join(root, "restart-prepare.json");

if (phase === "prepare") {
	const harness = await startTargetHarness({
		root,
		stateDir,
		promptFile,
		preserveOnCleanup: true,
	});
	try {
		const state = await waitFor(async () => {
			const current = await harness.runtime.coordinator.currentState();
			return current.active?.generation === 1 && current.lkg?.generation === 1 ? current : undefined;
		}, "restart prepare baseline LKG");
		const lkg = state.lkg;
		if (lkg === null || lkg === undefined) throw new Error("restart prepare has no LKG");
		const reads = await harness.runtime.knowledgeService.recordRead("index.md", new Date());
		const counts = await harness.runtime.knowledgeService.readStatsCounts(new Date());
		// Stop the first container's runtime before creating the notice so the
		// first runtime cannot consume/acknowledge it before the container exits.
		await harness.stop();
		const notices = new RecoveryNoticeStore({
			path: join(harness.paths.controlDir, "recovery-notices.json"),
			clock: new SystemClock(),
		});
		await notices.enqueueCrash({
			incident: {
				incidentId: `target-container-restart-${restartId}`,
				reason: `TARGET-CONTAINER-RESTART-NOTICE-${restartId}`,
				atMs: Date.now(),
				generation: 1,
				candidateId: lkg.candidateId,
				exitCode: null,
				signal: "SIGKILL",
				stderrTail: "fixture notice created before the container is stopped",
			},
			lkg,
			kind: "crash-rollback",
		});
		await writeFile(
			markerPath,
			`${JSON.stringify({
				version: 1,
				restartId,
				indexReads: reads,
				indexCount: counts.get("index.md") ?? 0,
				noticeReason: `TARGET-CONTAINER-RESTART-NOTICE-${restartId}`,
				preparedAt: new Date().toISOString(),
			}, null, 2)}\n`,
			{ mode: 0o644 },
		);
		console.log(`RESTART_PHASE=prepare OK id=${restartId} indexReads=${reads}`);
	} finally {
		// Keep /data and /state for the second, separate container run.
		await harness.stop();
	}
} else {
	const prepared = await readJson<Record<string, unknown>>(markerPath);
	if (prepared.restartId !== restartId) throw new Error("restart marker does not match this restart id");
	const harness = await startTargetHarness({ root, stateDir, promptFile });
	try {
		const counts = await harness.runtime.knowledgeService.readStatsCounts(new Date());
		const indexCount = counts.get("index.md") ?? 0;
		if (indexCount !== prepared.indexCount) {
			throw new Error(`read statistics did not survive container restart: ${indexCount} !== ${String(prepared.indexCount)}`);
		}
		await harness.setScript([
			{ text: "target container restart online" },
			{ text: "target container restart idle", stopReason: "error", errorMessage: "stop target restart loop" },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			const text = current.map((entry) => JSON.stringify(entry)).join("\n");
			return text.includes(String(prepared.noticeReason)) ? current : undefined;
		}, "recovery notice after a real container restart", 120_000);
		if (!captures.map((entry) => JSON.stringify(entry)).join("\n").includes(String(prepared.noticeReason))) {
			throw new Error("recovery notice was not delivered after the container restart");
		}
		const current = await harness.runtime.coordinator.currentState();
		if (current.lkg?.generation !== 1) throw new Error("LKG did not survive the container restart");
		console.log(`RESTART_PHASE=verify OK id=${restartId} indexReads=${indexCount}`);
	} finally {
		await harness.cleanup();
	}
}
