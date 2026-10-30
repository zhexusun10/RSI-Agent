import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(script) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [join(root, "scripts", script)], {
			cwd: root,
			stdio: "inherit",
			env: process.env,
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (signal) reject(new Error(`${script} terminated by ${signal}`));
			else if (code !== 0) reject(new Error(`${script} exited with ${code}`));
			else resolve();
		});
	});
}

try {
	await run("check-types.mjs");
	await run("test.mjs");
	await run("check-plugins.mjs");
	console.log("rsi checks passed.");
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
