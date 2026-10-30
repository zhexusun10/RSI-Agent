import { appendFile, readFile } from "node:fs/promises";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxContentBlock,
} from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface TestResponseStep {
	readonly text?: string;
	readonly toolCalls?: ReadonlyArray<{
		readonly name: string;
		readonly arguments: Readonly<Record<string, unknown>>;
		readonly id?: string;
	}>;
	readonly stopReason?: "stop" | "length" | "error";
	readonly errorMessage?: string;
}

function assistantFromStep(step: TestResponseStep) {
	const content: FauxContentBlock[] = [];
	if (step.text !== undefined && step.text.length > 0) content.push({ type: "text", text: step.text });
	for (const call of step.toolCalls ?? []) {
		content.push(fauxToolCall(call.name, call.arguments as never, {
			...(call.id === undefined ? {} : { id: call.id }),
		}));
	}
	return fauxAssistantMessage(content.length === 0 ? "" : content, {
		stopReason: step.stopReason ?? "stop",
		...(step.errorMessage === undefined ? {} : { errorMessage: step.errorMessage }),
	});
}

function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const record = message as Record<string, unknown>;
	const sections = record.sections;
	const sectionText =
		typeof sections === "object" && sections !== null
			? Object.values(sections).filter((value): value is string => typeof value === "string").join("\n\n")
			: "";
	if (typeof record.content === "string") return [record.content, sectionText].filter(Boolean).join("\n\n");
	if (!Array.isArray(record.content)) return sectionText;
	return record.content
		.map((block) => {
			if (typeof block !== "object" || block === null) return "";
			const value = block as Record<string, unknown>;
			if (value.type === "text" && typeof value.text === "string") return value.text;
			return "";
		})
		.join("\n");
}

export async function createWorkerModel(input: {
	readonly cwd: string;
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
}): Promise<{
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<any>;
	readonly settingsManager: SettingsManager;
}> {
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{
				id: "faux-1",
				name: "Faux integration model",
				input: ["text", "image"],
				contextWindow: 128_000,
				maxTokens: 16_384,
			},
		],
	});
	const modelRuntime = await ModelRuntime.create({
		refreshOnCreate: false,
		allowModelNetwork: false,
		modelsPath: null,
	});
	// Exercise Pi's real onPayload boundary as an HTTP provider would. The
	// pinned faux provider intentionally ignores onPayload, so integration
	// captures would otherwise miss a candidate's before_provider_request hook.
	const payloadCapturePath = input.env.RSI_TEST_PAYLOAD_FILE;
	const payloadProvider = createProvider({
		id: faux.provider.id,
		name: faux.provider.name,
		auth: faux.provider.auth,
		models: faux.models,
		api: {
			stream: faux.provider.stream,
			streamSimple: (model, context, options) => {
				const payload = { provider: model.provider, model: model.id, messages: context.messages };
				const transformed = options?.onPayload?.(payload, model);
				if (payloadCapturePath !== undefined && payloadCapturePath.length > 0) {
					void Promise.resolve(transformed)
						.then((value) => appendFile(payloadCapturePath, `${JSON.stringify(value ?? payload)}
`, "utf8"))
						.catch(() => undefined);
				}
				return faux.provider.streamSimple(model, context, options);
			},
		},
	});
	modelRuntime.registerNativeProvider(payloadProvider);
	await modelRuntime.setRuntimeApiKey("faux", "faux-test-key");

	const webBaseUrl = input.env.RSI_TEST_OPENAI_BASE_URL;
	if (webBaseUrl !== undefined && webBaseUrl.length > 0) {
		modelRuntime.registerProvider("openai", {
			baseUrl: `${webBaseUrl.replace(/\/$/u, "")}/v1`,
			apiKey: "fake-openai-key",
			api: "openai-responses",
			models: [
				{
					id: "gpt-5-web-test",
					name: "Fake web model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 16_384,
				},
			],
		});
		await modelRuntime.setRuntimeApiKey("openai", "fake-openai-key");
		await modelRuntime.getAvailable().catch(() => []);
	}

	const scriptPath = input.env.RSI_TEST_SCRIPT_FILE;
	const capturePath = input.env.RSI_TEST_CAPTURE_FILE;
	if (scriptPath === undefined || scriptPath.length === 0) {
		throw new Error("RSI_TEST_SCRIPT_FILE is required for the integration fake provider.");
	}
	const factory = async (context: { readonly messages: readonly unknown[] }, _options: unknown, state: { callCount: number }) => {
		let steps: TestResponseStep[] = [];
		let postRecovery: TestResponseStep[] | undefined;
		try {
			const parsed: unknown = JSON.parse(await readFile(scriptPath, "utf8"));
			if (Array.isArray(parsed)) steps = parsed as TestResponseStep[];
			else if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { steps?: unknown }).steps)) {
				const record = parsed as { steps: TestResponseStep[]; postRecovery?: TestResponseStep[] };
				steps = record.steps;
				postRecovery = record.postRecovery;
			} else if (typeof parsed === "object" && parsed !== null) {
				steps = [parsed as TestResponseStep];
			}
		} catch (error) {
			return fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: `integration script is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		const index = state.callCount - 1;
		if (capturePath !== undefined && capturePath.length > 0) {
			const capture = {
				index,
				atMs: Date.now(),
				system: context.messages
					.filter((message) => (message as { role?: string }).role === "system")
					.map((message) => messageText(message))
					.join("\n\n"),
				messages: context.messages.map((message) => {
					const record = message as Record<string, unknown>;
					return {
						role: record.role,
						toolCallId: record.toolCallId,
						toolName: record.toolName,
						isError: record.isError,
						text: messageText(message),
					};
				}),
			};
			await appendFile(capturePath, `${JSON.stringify(capture)}\n`, "utf8");
		}
		const transcript = JSON.stringify(context.messages);
		const recovered = transcript.includes("检测到 Pi Worker 崩溃，已回滚");
		const selected = recovered && postRecovery !== undefined ? postRecovery : steps;
		const step = selected[Math.min(index, Math.max(0, selected.length - 1))];
		if (step === undefined) {
			return fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "integration script exhausted",
			});
		}
		return assistantFromStep(step);
	};
	faux.setResponses(Array.from({ length: 1_000 }, () => factory as never));
	return {
		modelRuntime,
		model: faux.getModel() as Model<any>,
		settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
	};
}
