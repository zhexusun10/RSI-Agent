import { RsiError } from "../shared/errors.ts";

export const MAX_SHIM_ARGS = 256;
export const MAX_SHIM_ARG_LENGTH = 16_384;

export type PiInvocation =
	| { readonly kind: "control-reload" }
	| { readonly kind: "forward"; readonly argv: readonly string[] }
	| { readonly kind: "forbidden"; readonly command: string; readonly reason: string }
	| { readonly kind: "unsupported"; readonly command: string; readonly reason: string }
	| { readonly kind: "invalid"; readonly reason: string };

function assertArgumentShape(argv: readonly string[]): void {
	if (!Array.isArray(argv)) throw new RsiError("AGENT_COMMAND_FORBIDDEN", "argv must be an array.");
	if (argv.length > MAX_SHIM_ARGS) {
		throw new RsiError("AGENT_COMMAND_FORBIDDEN", `At most ${MAX_SHIM_ARGS} arguments are allowed.`);
	}
	for (const arg of argv) {
		if (typeof arg !== "string" || arg.length > MAX_SHIM_ARG_LENGTH || arg.includes("\u0000")) {
			throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Each argument must be a bounded string without NUL.");
		}
	}
}

/** Only Pi's native MCP command is exposed. Skills use Pi's normal filesystem discovery. */
export function classifyPiInvocation(argv: readonly string[]): PiInvocation {
	assertArgumentShape(argv);
	const first = argv[0];
	if (first === undefined) {
		return { kind: "forbidden", command: "pi", reason: "Only pi mcp is exposed to the Agent." };
	}
	if (first === "mcp") return { kind: "forward", argv: [...argv] };
	return {
		kind: "forbidden",
		command: first,
		reason: "This Pi command is forbidden; only pi mcp is exposed. Skill and MCP changes are activated by the runtime.",
	};
}

export interface PiCommandInput {
	readonly command: string;
	readonly args?: readonly string[];
}

export function piCommandInputToArgv(input: PiCommandInput): string[] {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Pi command must be an object.");
	}
	for (const key of Object.keys(input)) {
		if (key !== "command" && key !== "args") {
			throw new RsiError("AGENT_COMMAND_FORBIDDEN", `Unknown Pi command field: ${key}`);
		}
	}
	if (typeof input.command !== "string" || input.command.length === 0 || input.command.length > MAX_SHIM_ARG_LENGTH) {
		throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Pi command must be a bounded non-empty string.");
	}
	if (/\s/.test(input.command)) {
		throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Pi command must not contain whitespace; pass args separately.");
	}
	const args = input.args ?? [];
	assertArgumentShape(args);
	return [input.command, ...args];
}

/** No active-session control operation is exposed to the Agent. */
export function assertAllowedControlOperationName(value: unknown): string {
	throw new RsiError("AGENT_COMMAND_FORBIDDEN", `Control operation is not exposed: ${String(value)}`);
}
