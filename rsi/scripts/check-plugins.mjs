import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const pins = [
	{ name: "pi-continuity", version: "0.3.1", extension: "extensions/index.ts" },
	{ name: "pi-better-web-search", version: "0.1.7", extension: "extensions/index.ts" },
];

const agentDir = await mkdtemp(join(tmpdir(), "rsi-plugin-check-"));
const entries = [];
try {
	for (const pin of pins) {
		const manifestPath = require.resolve(`${pin.name}/package.json`);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		if (manifest.name !== pin.name || manifest.version !== pin.version) {
			throw new Error(`Manifest mismatch for ${pin.name}: ${manifest.name}@${manifest.version}`);
		}
		const declared = manifest.pi?.extensions ?? [];
		if (!declared.includes(`./${pin.extension}`)) {
			throw new Error(`${pin.name}@${pin.version} does not declare ./${pin.extension}`);
		}
		entries.push(require.resolve(`${pin.name}/${pin.extension}`));
	}
	const loaded = await discoverAndLoadExtensions(entries, process.cwd(), agentDir);
	if (loaded.errors.length > 0) {
		throw new Error(`Extension load errors:\n${loaded.errors.map((entry) => `${entry.path}: ${entry.error}`).join("\n")}`);
	}
	if (loaded.extensions.length !== pins.length) {
		throw new Error(`Expected ${pins.length} loaded extensions, got ${loaded.extensions.length}`);
	}
	const loadedNames = loaded.extensions.map((extension) => extension.path.split(/[\/]/).slice(-3).join("/"));
	console.log(`Loaded ${loaded.extensions.length} pinned Pi extensions: ${loadedNames.join(", ")}`);
} finally {
	await rm(agentDir, { recursive: true, force: true });
}
