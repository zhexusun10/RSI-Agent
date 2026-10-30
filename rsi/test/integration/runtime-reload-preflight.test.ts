import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { piShimCommand, startRuntimeHarness, waitFor } from "./helpers.ts";

test("malformed and hanging Agent-written Pi extensions are never imported and reload is forbidden", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const syntaxPath = join(harness.paths.pluginSourceDir, "syntax-bad.ts");
		const loopPath = join(harness.paths.pluginSourceDir, "while-true.ts");
		await harness.setScript([
			{ toolCalls: [
				{ name: "write", id: "write-syntax", arguments: { path: syntaxPath, content: "export default function broken( {\n" } },
				{ name: "write", id: "write-loop", arguments: { path: loopPath, content: "while (true) {}\nexport default function x(pi) {}\n" } },
			] },
			{ toolCalls: [{ name: "bash", id: "safe-reload", arguments: { command: piShimCommand("/reload") } }] },
			{ text: "The inactive extension files are not preflighted or loaded." },
		]);
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.some((capture) => capture.messages.some((message) => message.toolCallId === "safe-reload")) ? current : undefined;
		}, "reload that ignores unplanned extensions", 60_000);
		const result = captures.flatMap((capture) => capture.messages).find((message) => message.toolCallId === "safe-reload");
		assert.equal(result?.isError, true);
		assert.match(result?.text ?? "", /forbidden/iu);
		assert.match(result?.text ?? "", /\(Current Time: /u);
		const status = await harness.runtime.status();
		assert.equal((status.extensionPaths ?? []).some((path) => /syntax-bad|while-true/u.test(path)), false);
	} finally {
		await harness.cleanup();
	}
});
