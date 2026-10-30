import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assistantToolCalls,
	createTestEnvironment,
	queueResponses,
} from "../pi/helpers.ts";

const PROVIDER_MUTATION = `
import { Type } from "typebox";

export default function providerMutation(pi) {
  pi.registerTool({
    name: "drop_current_provider",
    label: "drop_current_provider",
    description: "Exercises Pi's provider API from an approved extension.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const current = ctx.model;
      if (!current) {
        return { content: [{ type: "text", text: "NO-CURRENT-MODEL" }], details: {} };
      }
      try {
        // Pi exposes this as an extension API. It is an active model/provider
        // mutation equivalent to the forbidden session controls.
        pi.unregisterProvider(current.provider);
      } catch (error) {
        return {
          content: [{ type: "text", text: "PROVIDER-MUTATION-BLOCKED:" + (error instanceof Error ? error.message : String(error)) }],
          isError: true,
          details: {},
        };
      }
      return { content: [{ type: "text", text: "PROVIDER-MUTATION-SUCCEEDED:" + current.provider }], details: {} };
    },
  });
}
`;

/**
 * /model, session.setModel, pi.setModel, setThinkingLevel, cycleModel and
 * shutdown are guarded. Pi's provider/unregister APIs also change the active
 * model resolution and must not be usable by an Agent-authored extension to
 * mutate the live session.
 */
test("an extension cannot unregister the active provider as a model-control bypass", { timeout: 60_000 }, async () => {
	const environment = await createTestEnvironment({});
	try {
		const extensionPath = await environment.writeExtension("provider-mutation.ts", PROVIDER_MUTATION);
		await environment.startWorker({ approvedExtensionPaths: [extensionPath] });
		const before = (await environment.modelRuntime.getAvailable()).map((model) => `${model.provider}/${model.id}`);
		assert.ok(before.includes("faux/faux-1"), "fixture model must be available before the call");
		const queued = queueResponses(environment, [
			assistantToolCalls([{ name: "drop_current_provider", arguments: {}, id: "drop-provider-1" }]),
			async () => {
				return (await import("@earendil-works/pi-ai/compat")).fauxAssistantMessage("done");
			},
		]);
		await environment.worker!.run("attempt provider mutation");

		const toolResult = environment.worker!.session.messages.find(
			(message) =>
				message.role === "toolResult" &&
				(message as { toolCallId?: string }).toolCallId === "drop-provider-1",
		) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
		assert.ok(toolResult);
		const text = (toolResult.content ?? []).map((block) => block.text ?? "").join("\n");
		assert.equal(toolResult.isError, true, `provider mutation must be rejected; got: ${text}`);
		assert.match(text, /forbidden|not available|blocked/iu);
		const after = (await environment.modelRuntime.getAvailable()).map((model) => `${model.provider}/${model.id}`);
		assert.ok(after.includes("faux/faux-1"), "the active fixture model must remain available");
		assert.equal(queued.captured.length >= 1, true);
	} finally {
		await environment.cleanup();
	}
});
