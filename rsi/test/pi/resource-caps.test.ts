import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	assistantText,
	assistantToolCalls,
	createTestEnvironment,
	queueResponses,
	systemTextOf,
	toolResultMessages,
	writeSkillFixture,
} from "./helpers.ts";

function resourcesDiscoverExtension(skillPath: string): string {
	return `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function discoverFixture(pi: ExtensionAPI): void {
	pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(skillPath)}] }));
}
`;
}

function mcpConfig(names: readonly string[]): string {
	return JSON.stringify({
		mcpServers: Object.fromEntries(
			names.map((name) => [name, { type: "http", url: `http://127.0.0.1:9/${name}`, enabled: false }]),
		),
	});
}

test("five Skills are discovered from global, project, npm-package, and resources_discover sources", async () => {
	const environment = await createTestEnvironment({ projectTrusted: true });
	try {
		await environment.seedSkill("global-one", "Global one.", "global");
		await environment.seedSkill("global-two", "Global two.", "global");
		await environment.seedSkill("project-one", "Project one.", "project");

		const packageDir = join(environment.root, "skill-package");
		await mkdir(join(packageDir, "skills", "package-one"), { recursive: true });
		await writeFile(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "rsi-skill-fixture",
				version: "1.0.0",
				pi: { skills: ["./skills"] },
			}),
		);
		await writeFile(
			join(packageDir, "skills", "package-one", "SKILL.md"),
			"---\nname: package-one\ndescription: Package one.\n---\n\npackage-one fixture body.\n",
		);
		environment.settingsManager.setPackages([packageDir]);

		const discoveredFile = await writeSkillFixture(
			join(environment.root, "discovered"),
			"discovered-one",
			"Discovered one.",
		);
		const extensionPath = await environment.writeExtension(
			"discover.ts",
			resourcesDiscoverExtension(discoveredFile),
		);

		await environment.startWorker({ approvedExtensionPaths: [extensionPath] });
		const skills = environment.worker!.resourceLoader.getSkills().skills;
		assert.deepEqual(
			skills.map((skill) => skill.name).sort(),
			["discovered-one", "global-one", "global-two", "package-one", "project-one"],
		);
		assert.equal(new Set(skills.map((skill) => skill.filePath)).size, 5);

		const queued = queueResponses(environment, [assistantText("skills loaded")]);
		await environment.worker!.run("inspect skills");
		const system = systemTextOf(queued.captured[0]!);
		for (const name of ["global-one", "global-two", "project-one", "package-one", "discovered-one"]) {
			assert.match(system, new RegExp(name));
		}
	} finally {
		await environment.cleanup();
	}
});

test("a sixth discovered Skill is rejected, not sliced", async () => {
	const environment = await createTestEnvironment({ projectTrusted: true });
	try {
		for (let index = 1; index <= 5; index++) {
			await environment.seedSkill(`global-${index}`, `Global ${index}.`, "global");
		}
		const sixth = await writeSkillFixture(join(environment.root, "discovered"), "sixth-skill", "Sixth.");
		const extensionPath = await environment.writeExtension("discover-sixth.ts", resourcesDiscoverExtension(sixth));
		await assert.rejects(
			environment.startWorker({ approvedExtensionPaths: [extensionPath] }),
			(error: unknown) =>
				error instanceof Error &&
				/Skills may be discovered|RESOURCE_CAP_EXCEEDED/.test(error.message),
		);
	} finally {
		await environment.cleanup();
	}
});

test("five MCP servers from global and project config start; six fail before activation", async () => {
	const passing = await createTestEnvironment({ projectTrusted: true });
	try {
		await writeFile(join(passing.agentDir, "mcp.json"), mcpConfig(["g1", "g2"]));
		await mkdir(join(passing.cwd, ".pi"), { recursive: true });
		await writeFile(join(passing.cwd, ".pi", "mcp.json"), mcpConfig(["p1", "p2", "p3"]));
		await passing.startWorker();
		assert.equal(
			passing.worker!.resourceLoader
				.getExtensions()
				.extensions.some((extension) => extension.path === "<inline:mcp>"),
			true,
		);
	} finally {
		await passing.cleanup();
	}

	const failing = await createTestEnvironment({ projectTrusted: true });
	try {
		await writeFile(join(failing.agentDir, "mcp.json"), mcpConfig(["g1", "g2", "g3"]));
		await mkdir(join(failing.cwd, ".pi"), { recursive: true });
		await writeFile(join(failing.cwd, ".pi", "mcp.json"), mcpConfig(["p1", "p2", "p3"]));
		await assert.rejects(
			failing.startWorker(),
			(error: unknown) =>
				error instanceof Error &&
				/MCP servers|RESOURCE_CAP_EXCEEDED/.test(error.message),
		);
	} finally {
		await failing.cleanup();
	}
});

test("dynamic registerMcpServer is capped before the sixth registration mutates or connects", async () => {
	const names = ["dyn1", "dyn2", "dyn3", "dyn4", "dyn5"];
	const source = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const configs = ${JSON.stringify(names)}.map((name) => ({
	type: "http" as const,
	url: "http://127.0.0.1:9/" + name,
	enabled: false,
}));

export default function dynamicMcpFixture(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		for (let index = 0; index < ${names.length}; index++) {
			pi.registerMcpServer(${JSON.stringify(names)}[index]!, configs[index]!);
		}
	});
	pi.registerTool({
		name: "register_sixth_mcp",
		label: "register_sixth_mcp",
		description: "Attempt an over-limit dynamic MCP registration.",
		parameters: Type.Object({}),
		async execute() {
			try {
				pi.registerMcpServer("dyn6", {
					type: "http",
					url: "http://127.0.0.1:9/dyn6",
					enabled: false,
				});
				return { content: [{ type: "text", text: "UNEXPECTED-SUCCESS" }], details: {} };
			} catch (error) {
				return {
					content: [{ type: "text", text: "REGISTRATION-REJECTED:" + (error instanceof Error ? error.message : String(error)) }],
					details: {},
					isError: true,
				};
			}
		},
	});
}
`;
	const environment = await createTestEnvironment({});
	try {
		const extensionPath = await environment.writeExtension("dynamic-mcp.ts", source);
		await environment.startWorker({ approvedExtensionPaths: [extensionPath] });
		const registry = environment.worker!.resourceLoader.getExtensions().runtime.mcpServers;
		assert.equal(registry.list().length, 5);

		const queued = queueResponses(environment, [
			assistantToolCalls([{ name: "register_sixth_mcp", arguments: {}, id: "mcp-sixth" }]),
			assistantText("still capped"),
		]);
		await environment.worker!.run("try sixth MCP");
		const result = toolResultMessages(queued.captured[1]!).find(
			(entry) => entry.toolName === "register_sixth_mcp",
		);
		assert.ok(result);
		assert.equal(result.isError, true);
		assert.match(
			result.content.map((block) => block.text ?? "").join("\n"),
			/RESOURCE_CAP_EXCEEDED|At most 5 MCP servers/,
		);
		assert.equal(registry.list().length, 5);
	} finally {
		await environment.cleanup();
	}
});
