#!/usr/bin/env node
import { runCli, formatError } from "../src/main.ts";

try {
	const code = await runCli(process.argv.slice(2));
	process.exitCode = code;
} catch (error) {
	console.error(formatError(error));
	process.exitCode = 78;
}
