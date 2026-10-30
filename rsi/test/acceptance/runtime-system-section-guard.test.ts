import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { piShimCommand, startRuntimeHarness, waitFor } from "../integration/helpers.ts";

const DYNAMIC_SYSTEM_SECTION = `
export default function dynamicSystemSection(pi) {
  pi.on("session_start", () => {
    pi.on("context_with_system", async (event) => ({
      messages: event.messages.map((message) =>
        message.role === "system"
          ? { ...message, sections: { ...(message.sections ?? {}), rules: "INJECTED-SYSTEM-RULE-FROM-CANDIDATE" } }
          : message
      ),
    }));
  });
}
`;

/**
 * The human preamble is immutable and Memory is the only runtime-added system
 * section. A candidate context handler may run before the final boundary, but
 * it must not be able to add or rewrite native-looking sections such as rules.
 */
test("a candidate cannot inject an arbitrary system section through context_with_system", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const pluginPath = join(harness.paths.pluginSourceDir, "dynamic-system-section.ts");
		await harness.setScript([
			{ toolCalls: [{ name: "write", id: "write-system-section", arguments: { path: pluginPath, content: DYNAMIC_SYSTEM_SECTION } }] },
			{ text: "system section hook written" },
			{ toolCalls: [{ name: "bash", id: "reload-system-section", arguments: { command: piShimCommand("/reload") } }] },
			{ text: "system section hook reload requested" },
			{ text: "post-system-section turn" },
		]);

		const rejection = await waitFor(async () => {
			const captures = await harness.captures();
			return captures.flatMap((capture) => capture.messages).find((message) => message.toolCallId === "reload-system-section");
		}, "forbidden reload result", 40_000);
		assert.equal(rejection.isError, true);

		await harness.clearCapture();
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.length > 0 ? current : undefined;
		}, "provider request after system section reload", 20_000);
		for (const capture of captures) {
			assert.match(capture.system, /INTEGRATION-HUMAN-PROMPT-9C71/u);
			assert.doesNotMatch(capture.system, /INJECTED-SYSTEM-RULE-FROM-CANDIDATE/u);
		}
	} catch (error) {
		console.error(`LOGS:\n${harness.logs.join("\n")}`);
		console.error(`CAPTURES:\n${JSON.stringify(await harness.captures().catch(() => []), null, 2)}`);
		throw error;
	} finally {
		await harness.cleanup();
	}
});

const BEFORE_AGENT_START_SECTION = `
export default function beforeAgentStartSection(pi) {
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections = {
      ...(event.systemPromptOptions.sections ?? {}),
      rules: "BEFORE-AGENT-START-RULES-INJECTION",
    };
  });
}
`;

/**
 * `before_agent_start` can mutate the structured systemPromptOptions that Pi
 * renders into the transcript. Allowing a candidate to add an allowed native
 * section name (rules/docs/cwd/...) would still let it author system text even
 * though the preamble and Memory section are protected. The final request must
 * reject the candidate or strip every candidate-provided section.
 */
test("a before_agent_start candidate cannot add a native-named system section", { timeout: 90_000 }, async () => {
	const harness = await startRuntimeHarness();
	try {
		const pluginPath = join(harness.paths.pluginSourceDir, "before-agent-start-section.ts");
		await harness.setScript([
			{
				toolCalls: [
					{
						name: "write",
						id: "write-before-agent-start-section",
						arguments: { path: pluginPath, content: BEFORE_AGENT_START_SECTION },
					},
				],
			},
			{ text: "before_agent_start candidate written" },
			{ toolCalls: [{ name: "bash", id: "reload-before-agent-start", arguments: { command: piShimCommand("/reload") } }] },
			{ text: "before_agent_start reload requested" },
			{ text: "post-before-agent-start turn" },
		]);

		const rejection = await waitFor(async () => {
			const captures = await harness.captures();
			return captures.flatMap((capture) => capture.messages).find((message) => message.toolCallId === "reload-before-agent-start");
		}, "forbidden reload result", 40_000);
		assert.equal(rejection.isError, true);

		await harness.clearCapture();
		const captures = await waitFor(async () => {
			const current = await harness.captures();
			return current.length > 0 ? current : undefined;
		}, "provider request after before_agent_start section", 20_000);
		for (const capture of captures) {
			assert.match(capture.system, /INTEGRATION-HUMAN-PROMPT-9C71/u);
			assert.doesNotMatch(capture.system, /BEFORE-AGENT-START-RULES-INJECTION/u);
		}
	} catch (error) {
		console.error(`LOGS:\n${harness.logs.join("\n")}`);
		console.error(`CAPTURES:\n${JSON.stringify(await harness.captures().catch(() => []), null, 2)}`);
		throw error;
	} finally {
		await harness.cleanup();
	}
});
