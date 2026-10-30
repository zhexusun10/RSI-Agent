import type { EditOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import { RsiError } from "../shared/errors.ts";
import type { NativeToolOperationsPort } from "../shared/ports.ts";
import type { KnowledgeService } from "./service.ts";

export interface ManagedNativeToolOperationsOptions {
	readonly now?: () => Date;
}

/**
 * Pi native read/write/edit operations for the managed Markdown namespace.
 *
 * The Worker selects these operations only after classifying a path as
 * managed. Every operation rejects unmanaged paths, so this object is not a
 * generic host filesystem or bash bridge.
 */
export function createManagedNativeToolOperations(
	service: KnowledgeService,
	options: ManagedNativeToolOperationsOptions = {},
): NativeToolOperationsPort {
	const now = options.now ?? (() => service.clock.now());

	const read: ReadOperations = {
		async readFile(absolutePath: string): Promise<Buffer> {
			const target = await service.resolveManagedToolPath(absolutePath, service.root.realPath);
			return service.readBytesForNativeRead(target.name, now());
		},
		async access(absolutePath: string): Promise<void> {
			const target = await service.resolveManagedToolPath(absolutePath, service.root.realPath);
			await service.assertManagedExists(target.name);
		},
		async detectImageMimeType(_absolutePath: string): Promise<null> {
			return null;
		},
	};

	const write: WriteOperations = {
		async writeFile(absolutePath: string, content: string): Promise<void> {
			const target = await service.resolveManagedToolPath(absolutePath, service.root.realPath);
			await service.overwriteLatest(target.name, content);
		},
		async mkdir(directory: string): Promise<void> {
			await service.assertManagedDirectoryRoot(directory);
		},
	};

	const pendingEdits = new Map<string, { readonly name: string; readonly revision: string }>();
	const edit: EditOperations = {
		async readFile(absolutePath: string): Promise<Buffer> {
			const target = await service.resolveManagedToolPath(absolutePath, service.root.realPath);
			const snapshot = await service.read(target.name);
			pendingEdits.set(absolutePath, { name: target.name, revision: snapshot.revision });
			return Buffer.from(snapshot.content, "utf8");
		},
		async access(absolutePath: string): Promise<void> {
			const target = await service.resolveManagedToolPath(absolutePath, service.root.realPath);
			await service.assertManagedExists(target.name);
		},
		async writeFile(absolutePath: string, content: string): Promise<void> {
			const target = await service.resolveManagedToolPath(absolutePath, service.root.realPath);
			const pending = pendingEdits.get(absolutePath);
			pendingEdits.delete(absolutePath);
			if (!pending || pending.name !== target.name) {
				throw new RsiError(
					"INTERNAL",
					"A managed edit must read the same document before writing it.",
				);
			}
			await service.commit({
				name: target.name,
				content,
				expectedRevision: pending.revision,
				operation: "edit",
			});
		},
	};

	return { read, write, edit };
}

export function createManagedToolOperations(
	service: KnowledgeService,
	options: ManagedNativeToolOperationsOptions = {},
): NativeToolOperationsPort {
	return createManagedNativeToolOperations(service, options);
}
