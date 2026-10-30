import { createHash } from "node:crypto";

/** Content revisions are algorithm-tagged lowercase SHA-256 digests. */
export type ContentRevision = `sha256:${string}`;

export function sha256Bytes(bytes: Uint8Array | string): ContentRevision {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function sha256Text(text: string): ContentRevision {
	return sha256Bytes(Buffer.from(text, "utf8"));
}

/** Revision of the empty file. Memory may start empty. */
export const EMPTY_CONTENT_REVISION: ContentRevision = sha256Text("");
