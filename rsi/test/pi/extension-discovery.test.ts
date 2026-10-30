import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createTestEnvironment,
} from "./helpers.ts";

const INERT_EXTENSION = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function inert(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "unapproved_extension_tool",
		label: "unapproved",
		description: "Must never load without approval.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "UNAPPROVED" }], details: {} };
		},
	});
}
`;

test("project Skills obey native project-trust discovery", async () => {
	const environment = await createTestEnvironment({ projectTrusted: false });
	try {
		await environment.seedSkill("trusted-global", "Global.", "global");
		await environment.seedSkill("untrusted-project", "Project.", "project");
		await environment.startWorker();
		assert.deepEqual(
			environment.worker!.resourceLoader.getSkills().skills.map((skill) => skill.name),
			["trusted-global"],
		);
	} finally {
		await environment.cleanup();
	}
});

test("writable global, project, and package extension directories cannot bypass the approved set", async () => {
	const environment = await createTestEnvironment({ projectTrusted: true });
	try {
		await mkdir(join(environment.agentDir, "extensions"), { recursive: true });
		await writeFile(join(environment.agentDir, "extensions", "evil.ts"), INERT_EXTENSION);
		await mkdir(join(environment.cwd, ".pi", "extensions"), { recursive: true });
		await writeFile(join(environment.cwd, ".pi", "extensions", "evil.ts"), INERT_EXTENSION);

		const packageDir = join(environment.root, "extension-package");
		await mkdir(join(packageDir, "extensions"), { recursive: true });
		await writeFile(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "rsi-extension-fixture",
				version: "1.0.0",
				pi: { extensions: ["./extensions/index.ts"] },
			}),
		);
		await writeFile(join(packageDir, "extensions", "index.ts"), INERT_EXTENSION);
		environment.settingsManager.setPackages([packageDir]);

		await environment.startWorker({ approvedExtensionPaths: [] });
		const extensions = environment.worker!.resourceLoader.getExtensions().extensions;
		assert.equal(
			extensions.some(
				(extension) =>
					extension.path.includes("evil.ts") || extension.path.includes("extension-package"),
			),
			false,
		);
		assert.equal(
			environment.worker!.session.getAllTools().some((tool) => tool.name === "unapproved_extension_tool"),
			false,
		);
	} finally {
		await environment.cleanup();
	}
});

test("an approved extension load error fails closed with an explicit diagnostic", async () => {
	const environment = await createTestEnvironment({});
	try {
		const broken = await environment.writeExtension(
			"broken.ts",
			"export default function broken(): void { throw new Error('fixture-load-failure'); }\n",
		);
		await assert.rejects(
			environment.startWorker({ approvedExtensionPaths: [broken] }),
			(error: unknown) =>
				error instanceof Error &&
				/Extension load failed|RELOAD_FAILED|fixture-load-failure/.test(error.message),
		);
	} finally {
		await environment.cleanup();
	}
});
