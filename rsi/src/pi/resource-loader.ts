import { resolve } from "node:path";
import {
	DefaultResourceLoader,
	type InlineExtension,
	type LoadExtensionsResult,
	type ResourceDiagnostic,
	type SessionStartEvent,
	type SettingsManager,
	type Skill,
	type SourceInfo,
} from "@earendil-works/pi-coding-agent";
import { RsiError } from "../shared/errors.ts";
import { MAX_SKILLS } from "../shared/policy.ts";
import { assertNoPendingProviderMutations } from "./control-guard.ts";

export interface RestrictedExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: unknown }>;
	promptPaths?: Array<{ path: string; metadata: unknown }>;
	themePaths?: Array<{ path: string; metadata: unknown }>;
}

interface InternalResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: never }>;
	promptPaths?: Array<{ path: string; metadata: never }>;
	themePaths?: Array<{ path: string; metadata: never }>;
}

export interface RestrictedResourceLoaderOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsManager: SettingsManager;
	/** Immutable, externally preflight-approved extension entry points. */
	readonly approvedExtensionPaths: readonly string[];
	readonly manualSystemPrompt: string;
	readonly extensionFactories?: readonly InlineExtension[];
	readonly onApprovedExtensionsChanged?: (paths: readonly string[]) => void;
}

export interface DispatchedExtension {
	readonly path: string;
	readonly resolvedPath: string;
	readonly sourceInfo: SourceInfo;
}

/**
 * A native DefaultResourceLoader with two hard constraints:
 *
 * 1. Only the externally approved extension paths are loaded. `noExtensions`
 *    prevents global/project/package settings from introducing another
 *    writable extension directory; skills, prompts, themes, and context files
 *    still use Pi's normal global/project/package/discovered discovery.
 * 2. The final discovered Skill set is checked as independent resources, not
 *    as a settings array. Over-limit sets fail closed instead of being sliced.
 */
export class RestrictedResourceLoader {
	private readonly options: RestrictedResourceLoaderOptions;
	private approvedExtensionPaths: string[];
	private loader: DefaultResourceLoader;

	constructor(options: RestrictedResourceLoaderOptions) {
		this.options = options;
		this.approvedExtensionPaths = [...options.approvedExtensionPaths];
		this.loader = this.createLoader();
	}

	private createLoader(): DefaultResourceLoader {
		const factories = this.options.extensionFactories ?? [];
		return new DefaultResourceLoader({
			cwd: this.options.cwd,
			agentDir: this.options.agentDir,
			settingsManager: this.options.settingsManager,
			// Extensions are an approved immutable set; the human prompt is the
			// only system text. Native Skill/MCP discovery remains active, while
			// project context files and prompt templates are not injected.
			noExtensions: true,
			noContextFiles: true,
			noPromptTemplates: true,
			additionalExtensionPaths: [...this.approvedExtensionPaths],
			extensionFactories: [...factories],
			// The human-provided prompt is replayed verbatim. No discovered or
			// appended prompt may replace or extend it; Memory is the only runtime
			// section the Worker adds.
			systemPromptOverride: () => this.options.manualSystemPrompt,
			appendSystemPrompt: [],
		});
	}

	setApprovedExtensionPaths(paths: readonly string[]): void {
		const next = [...new Set(paths.map((path) => resolve(path)))];
		this.approvedExtensionPaths = next;
		this.options.onApprovedExtensionsChanged?.(next);
	}

	getApprovedExtensionPaths(): readonly string[] {
		return [...this.approvedExtensionPaths];
	}

	/** Discover and validate Skills without replacing the active loader/session. */
	async previewSkillChanges(): Promise<boolean> {
		const next = this.createLoader();
		await next.reload();
		this.validate(next);
		const signature = (skills: Skill[]) => JSON.stringify(skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			disableModelInvocation: skill.disableModelInvocation,
		})).sort((left, right) => left.filePath.localeCompare(right.filePath)));
		return signature(next.getSkills().skills) !== signature(this.loader.getSkills().skills);
	}

	async reload(options?: {
		resolveProjectTrust?: (input: { extensionsResult: LoadExtensionsResult }) => Promise<boolean>;
	}): Promise<void> {
		const next = this.createLoader();
		await next.reload(options as never);
		this.validate(next);
		this.loader = next;
	}

	extendResources(paths: RestrictedExtensionPaths): void {
		const internal = paths as unknown as InternalResourceExtensionPaths;
		this.loader.extendResources(internal as never);
		this.assertSkillCap(this.loader, "resources_discover");
	}

	getExtensions(): LoadExtensionsResult {
		return this.loader.getExtensions();
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return this.loader.getSkills();
	}

	getPrompts(): { prompts: import("@earendil-works/pi-coding-agent").PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return this.loader.getPrompts();
	}

	getThemes(): { themes: import("@earendil-works/pi-coding-agent").Theme[]; diagnostics: ResourceDiagnostic[] } {
		return this.loader.getThemes();
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return this.loader.getAgentsFiles();
	}

	getSystemPrompt(): string | undefined {
		return this.loader.getSystemPrompt();
	}

	getSystemPromptSource(): { path: string } | undefined {
		return this.loader.getSystemPromptSource();
	}

	getAppendSystemPrompt(): string[] {
		return this.loader.getAppendSystemPrompt();
	}

	getAppendSystemPromptSources(): Array<{ path: string }> {
		return this.loader.getAppendSystemPromptSources();
	}

	/** Extensions currently loaded from disk, excluding synthesized inline/builtin paths. */
	dispatchedExtensions(): DispatchedExtension[] {
		return this.loader
			.getExtensions()
			.extensions.filter((extension) => !extension.path.startsWith("<") && !extension.path.startsWith("builtin:"))
			.map((extension) => ({
				path: extension.path,
				resolvedPath: extension.resolvedPath,
				sourceInfo: extension.sourceInfo,
			}));
	}

	assertApprovedExtensionsLoaded(): void {
		const approved = new Set(this.approvedExtensionPaths.map((path) => resolve(path)));
		for (const extension of this.dispatchedExtensions()) {
			if (!approved.has(resolve(extension.resolvedPath))) {
				throw new RsiError(
					"RELOAD_FAILED",
					`An extension outside the externally approved immutable set was discovered: ${extension.path}`,
				);
			}
		}
		const extensions = this.loader.getExtensions();
		if (extensions.errors.length > 0) {
			throw new RsiError(
				"RELOAD_FAILED",
				`Extension load failed: ${extensions.errors.map((entry) => `${entry.path}: ${entry.error}`).join("; ")}`,
				{
					details: {
						errors: extensions.errors.map((entry) => ({ path: entry.path, error: entry.error })),
					},
				},
			);
		}
	}

	assertSkillCap(loader: Pick<DefaultResourceLoader, "getSkills">, source: string): void {
		const skills = loader.getSkills().skills;
		if (skills.length > MAX_SKILLS) {
			throw new RsiError(
				"RESOURCE_CAP_EXCEEDED",
				`At most ${MAX_SKILLS} Skills may be discovered (${source} found ${skills.length}).`,
				{
					details: {
						count: skills.length,
						max: MAX_SKILLS,
						skills: skills.map((skill) => ({ name: skill.name, path: skill.filePath })),
					},
				},
			);
		}
	}

	validate(loader: DefaultResourceLoader): void {
		assertNoPendingProviderMutations(loader.getExtensions());
		this.assertSkillCap(loader, "resource discovery");
		const approved = new Set(this.approvedExtensionPaths.map((path) => resolve(path)));
		const extensions = loader.getExtensions();
		for (const extension of extensions.extensions) {
			if (extension.path.startsWith("<") || extension.path.startsWith("builtin:")) continue;
			if (!approved.has(resolve(extension.resolvedPath))) {
				throw new RsiError(
					"RELOAD_FAILED",
					`An extension outside the externally approved immutable set was discovered: ${extension.path}`,
				);
			}
		}
		if (extensions.errors.length > 0) {
			throw new RsiError(
				"RELOAD_FAILED",
				`Extension load failed: ${extensions.errors.map((entry) => `${entry.path}: ${entry.error}`).join("; ")}`,
				{
					details: {
						errors: extensions.errors.map((entry) => ({ path: entry.path, error: entry.error })),
					},
				},
			);
		}
	}
}

export type { SessionStartEvent };
