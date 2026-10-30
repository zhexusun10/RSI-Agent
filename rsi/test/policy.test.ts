import assert from "node:assert/strict";
import test from "node:test";
import {
	AGENT_PROMPT_POLICY,
	assertAgentPromptAllowed,
	assertResourceCaps,
	formatCurrentTimeSuffix,
	MAX_MCP_SERVERS,
	MAX_SKILLS,
} from "../src/shared/index.ts";

test("agent loop prompts cannot start with a Pi command", () => {
	assert.equal(AGENT_PROMPT_POLICY.expandPromptTemplates, false);
	for (const prompt of ["/model", "  /thinking high", "/quit", "/reload"]) {
		assert.throws(
			() => assertAgentPromptAllowed(prompt),
			(error: unknown) => (error as { code?: string }).code === "AGENT_COMMAND_FORBIDDEN",
		);
	}
	assert.doesNotThrow(() => assertAgentPromptAllowed("Explain why /model is disabled."));
	assert.doesNotThrow(() => assertAgentPromptAllowed("continue working"));
});

test("MCP and Skill caps match the product contract", () => {
	assert.equal(MAX_MCP_SERVERS, 5);
	assert.equal(MAX_SKILLS, 5);
	assert.doesNotThrow(() => assertResourceCaps({ mcpServerCount: 5, skillCount: 5 }));
	assert.throws(
		() => assertResourceCaps({ mcpServerCount: 6, skillCount: 0 }),
		(error: unknown) => (error as { code?: string }).code === "RESOURCE_CAP_EXCEEDED",
	);
	assert.throws(
		() => assertResourceCaps({ mcpServerCount: 0, skillCount: 6 }),
		(error: unknown) => (error as { code?: string }).code === "RESOURCE_CAP_EXCEEDED",
	);
});

test("current time suffix is exact and second-resolution", () => {
	assert.equal(
		formatCurrentTimeSuffix(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), "UTC"),
		"(Current Time: 2026/01/02 03:04:05)",
	);
});
