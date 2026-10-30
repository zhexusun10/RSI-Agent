import assert from "node:assert/strict";
import test from "node:test";
import {
	assertAllowedControlOperationName,
	classifyPiInvocation,
	piCommandInputToArgv,
} from "../../src/control/command-policy.ts";

test("only native Pi MCP invocations are forwarded", () => {
	for (const argv of [["mcp"], ["mcp", "list"], ["mcp", "add", "s", "--", "node", "server.mjs"]]) {
		assert.deepEqual(classifyPiInvocation(argv), { kind: "forward", argv });
	}
	for (const argv of [
		[], ["/reload"], ["/quit"], ["/model"], ["reload"], ["install", "npm:pi-test"],
		["remove", "foo"], ["update", "--all"], ["list"], ["--version"], ["-p", "hello"],
		["--mode", "rpc"], ["--model", "other/model"], ["/unknown"],
	]) {
		assert.equal(classifyPiInvocation(argv).kind, "forbidden", JSON.stringify(argv));
	}
});

test("structured arguments remain bounded and no model control operation is exposed", () => {
	assert.deepEqual(piCommandInputToArgv({ command: "mcp", args: ["list"] }), ["mcp", "list"]);
	assert.throws(() => piCommandInputToArgv({ command: "mcp list" }), /whitespace/);
	assert.throws(() => piCommandInputToArgv({ command: "mcp", args: [], extra: true } as never), /Unknown Pi command field/);
	assert.throws(() => classifyPiInvocation(["mcp", "\u0000"]), /NUL/);
	for (const command of ["reload", "/reload", "shutdown", "status", "/model"]) {
		assert.throws(() => assertAllowedControlOperationName(command), /not exposed/);
	}
});
