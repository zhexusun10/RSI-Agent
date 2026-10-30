import assert from "node:assert/strict";
import test from "node:test";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	appendToolResultText,
	composeToolResultSuffix,
	decorateToolResultContent,
	hasCurrentTimeSuffix,
	stripTrailingCurrentTime,
} from "../src/shared/index.ts";

const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
const timeLine = "(Current Time: 2026/01/02 03:04:05)";

test("tool result decoration orders report, memory meta, warnings, then time", () => {
	const suffix = composeToolResultSuffix({
		indexReport: "REPORT",
		memoryUsage: "[System Meta: Current Memory Usage: 1 / 500 words]",
		warnings: ["WARN"],
		now,
		timeZone: "UTC",
	});
	assert.equal(
		suffix,
		`REPORT\n\n[System Meta: Current Memory Usage: 1 / 500 words]\n\nWARN\n\n${timeLine}`,
	);
	const content: TextContent[] = [{ type: "text", text: "Successfully wrote." }];
	const decorated = decorateToolResultContent(content, suffix);
	assert.equal(decorated.length, 1);
	assert.equal((decorated[0] as TextContent).text, `Successfully wrote.\n\n${suffix}`);
	assert.equal(hasCurrentTimeSuffix(decorated), true);
});

test("a time-looking string in the middle does not suppress the required final suffix", () => {
	const content: TextContent[] = [
		{ type: "text", text: `${timeLine} is documentation, not the final timestamp` },
	];
	assert.equal(hasCurrentTimeSuffix(content), false);
	const decorated = decorateToolResultContent(content, "(Current Time: 2027/01/01 00:00:00)");
	assert.equal(hasCurrentTimeSuffix(decorated), true);
	assert.match((decorated[0] as TextContent).text, /\(Current Time: 2027\/01\/01 00:00:00\)$/);
});

test("decorating an image-only result adds a text block", () => {
	const image: ImageContent = { type: "image", data: "AA==", mimeType: "image/png" };
	const decorated = decorateToolResultContent([image], timeLine);
	assert.equal(decorated.length, 2);
	assert.equal(decorated[0], image);
	assert.deepEqual(decorated[1], { type: "text", text: timeLine });
});

test("a previous trailing time line is replaced rather than duplicated", () => {
	const text = `result\n\n${timeLine}`;
	assert.equal(stripTrailingCurrentTime(text), "result");
	const appended = appendToolResultText([{ type: "text", text }], "(Current Time: 2027/01/01 00:00:00)");
	assert.equal((appended[0] as TextContent).text, "result\n\n(Current Time: 2027/01/01 00:00:00)");
});
