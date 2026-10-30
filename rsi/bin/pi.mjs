#!/usr/bin/env node
import { runPiShim } from "../src/control/pi-shim.ts";

const code = await runPiShim(process.argv.slice(2), {
	env: process.env,
	cwd: process.cwd(),
	shimPath: process.argv[1],
});
process.exitCode = code;
