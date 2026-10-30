import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const child = spawn(process.execPath, [tsc, "-p", join(root, "tsconfig.json"), "--noEmit"], {
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
		console.error(`tsc terminated by ${signal}`);
		process.exitCode = 1;
		return;
	}
	process.exitCode = code ?? 1;
});
