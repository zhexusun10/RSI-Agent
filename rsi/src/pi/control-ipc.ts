import { RsiError } from "../shared/errors.ts";
import type { IpcRequestContext, WorkerIpcServer } from "../shared/ipc/port.ts";
import type { PiWorker } from "./worker.ts";

/**
 * Bind the trusted Supervisor's control methods to one Worker.
 *
 * Every reload path reaches `worker.requestReload`, which asks the external
 * preflight service before the real session.reload. The Supervisor's own
 * `control.reload` is therefore preflighted here as well rather than being a
 * second unguarded entry point.
 */
export function bindWorkerControlIpc(
	worker: PiWorker,
	server: Pick<WorkerIpcServer, "handle">,
): () => void {
	const unsubscribers: Array<() => void> = [];

	unsubscribers.push(
		server.handle("control.reload", async (payload, _context: IpcRequestContext) => {
			const entryPaths = payload.candidate.entryPaths;
			const result = await worker.requestReload({
				candidateId: payload.candidate.candidateId,
				...(entryPaths === undefined ? {} : { approvedExtensionPaths: entryPaths }),
			});
			if (entryPaths !== undefined) {
				const loaded = new Set(
					worker.resourceLoader
						.getExtensions()
						.extensions.map((extension) => extension.resolvedPath),
				);
				const missing = entryPaths.filter((path) => !loaded.has(path));
				if (missing.length > 0) {
					throw new RsiError(
						"RELOAD_FAILED",
						`Reload completed without loading candidate entries: ${missing.join(", ")}`,
						{ details: { missing } },
					);
				}
			}
			return result.started;
		}),
	);
	unsubscribers.push(
		server.handle("control.shutdown", async (payload) => {
			await worker.stop(payload.reason);
			return { accepted: true };
		}),
	);
	unsubscribers.push(
		server.handle("control.cancelSleep", async (payload) => {
			return { cancelled: await worker.cancelSleep(payload.reason) };
		}),
	);
	unsubscribers.push(
		server.handle("worker.status", async () => worker.status()),
	);
	unsubscribers.push(
		server.handle("worker.previewResources", async () => await worker.previewResources()),
	);
	unsubscribers.push(
		server.handle("worker.ping", async (payload) => ({
			nonce: payload.nonce,
			serverTimeMs: Date.now(),
		})),
	);

	return () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
}
