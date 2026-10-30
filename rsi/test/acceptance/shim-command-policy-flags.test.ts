import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPiInvocation } from "../../src/control/command-policy.ts";

test("the shim permits only the native MCP command, not Pi flags, reload, package or prompt commands", () => {
	for (const argv of [
		["-p", "--model", "other/model"], ["--verbose", "--model", "other/model"],
		["-p", "--thinking", "high"], ["-p", "--system-prompt", "untrusted"],
		["--mode", "json", "--mode", "rpc"], ["install", "npm:pi-test"],
		["--version"], ["reload"], ["/reload"], ["/quit"], ["--", "--model", "prompt"],
	]) assert.equal(classifyPiInvocation(argv).kind, "forbidden", JSON.stringify(argv));
	assert.equal(classifyPiInvocation(["mcp", "list"]).kind, "forward");
});
