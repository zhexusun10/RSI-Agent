import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RsiError } from "../shared/errors.ts";
import {
	classifyPiInvocation,
	MAX_SHIM_ARG_LENGTH,
	MAX_SHIM_ARGS,
	piCommandInputToArgv,
	type PiCommandInput,
} from "./command-policy.ts";
import type { ReloadCoordinator } from "./reload.ts";

export interface PiCommandForwardResult {
	readonly detail: string;
	readonly exitCode?: number;
}

export interface PiCommandBridgeOptions {
	readonly reload: ReloadCoordinator;
	readonly currentGeneration: () => number | null;
	readonly currentSessionId: () => string | null;
	/** Optional Worker adapter for native Pi CLI/package commands. */
	readonly forward?: (argv: readonly string[]) => Promise<PiCommandForwardResult>;
}

export interface PiCommandSuccessDetails {
	readonly kind: "control-reload" | "forward";
	readonly generation?: number | null;
	readonly exitCode?: number;
}

export interface PiCommandErrorDetails {
	readonly error: true;
	readonly code: string;
	readonly message: string;
	readonly stack: string;
}

export type PiCommandToolDetails = PiCommandSuccessDetails | PiCommandErrorDetails;

export const PI_COMMAND_TOOL_NAME = "pi_command";

export const PI_COMMAND_TOOL_PARAMETERS = Type.Object(
	{
		command: Type.String({
			description: "Native Pi MCP command name.",
			maxLength: MAX_SHIM_ARG_LENGTH,
			minLength: 1,
		}),
		args: Type.Optional(
			Type.Array(Type.String({ maxLength: MAX_SHIM_ARG_LENGTH }), {
				maxItems: MAX_SHIM_ARGS - 1,
				description: "Structured arguments passed to the command without shell interpolation.",
			}),
		),
	},
	{ additionalProperties: false },
);

function errorWithStack(error: unknown): { readonly message: string; readonly stack: string } {
	if (error instanceof Error) {
		return { message: error.message, stack: error.stack ?? error.message };
	}
	return { message: String(error), stack: String(error) };
}

/**
 * Legacy bridge retained for internal tests. It is not registered in the
 * model-facing Worker, and the shared policy permits only MCP forwarding.
 */
export function createPiCommandTool(
	options: PiCommandBridgeOptions,
): ToolDefinition<typeof PI_COMMAND_TOOL_PARAMETERS, PiCommandToolDetails> {
	return {
		name: PI_COMMAND_TOOL_NAME,
		label: "Pi command",
		description: "Forward a native Pi MCP command without shell expansion.",
		parameters: PI_COMMAND_TOOL_PARAMETERS,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			try {
				if (signal?.aborted) {
					throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Pi command was aborted.");
				}
				const argv = piCommandInputToArgv(params as PiCommandInput);
				const invocation = classifyPiInvocation(argv);
				switch (invocation.kind) {
					case "control-reload":
						throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Agent reload is forbidden.");
					case "forward": {
						if (!options.forward) {
							throw new RsiError(
								"AGENT_COMMAND_FORBIDDEN",
								"Forwarded Pi CLI commands are unavailable in this Worker binding; use the read-only pi shim.",
							);
						}
						const result = await options.forward(invocation.argv);
						return {
							content: [{ type: "text", text: result.detail }],
							details: {
								kind: "forward",
								...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
							},
						};
					}
					case "forbidden":
						throw new RsiError("AGENT_COMMAND_FORBIDDEN", `${invocation.command}: ${invocation.reason}`);
					case "unsupported":
						throw new RsiError(
							"AGENT_COMMAND_FORBIDDEN",
							`${invocation.command} is not available in headless mode: ${invocation.reason}`,
						);
					case "invalid":
						throw new RsiError("AGENT_COMMAND_FORBIDDEN", invocation.reason);
				}
			} catch (error) {
				const failure = errorWithStack(error);
				return {
					content: [{ type: "text", text: `${failure.message}\n${failure.stack}` }],
					details: {
						error: true,
						code: error instanceof RsiError ? error.code : "INTERNAL",
						message: failure.message,
						stack: failure.stack,
					},
					isError: true,
				};
			}
		},
	};
}
