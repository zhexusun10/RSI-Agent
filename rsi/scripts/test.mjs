import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testDir = join(root, "test");

async function collect(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await collect(path)));
		else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
	}
	return files;
}

const files = (await collect(testDir)).sort((left, right) => left.localeCompare(right, "en"));
if (files.length === 0) {
	console.error("No .test.ts files found.");
	process.exit(1);
}
const display = files.map((file) => relative(root, file));
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
	cwd: root,
	stdio: "inherit",
	env: process.env,
});
child.on("error", (error) => {
	console.error(error);
	process.exitCode = 1;
});
child.on("exit", (code, signal) => {
	if (signal) {
		console.error(`Node test runner terminated by ${signal}`);
		process.exitCode = 1;
		return;
	}
	process.exitCode = code ?? 1;
});
console.error(`Running ${display.length} test file(s): ${display.join(", ")}`);
