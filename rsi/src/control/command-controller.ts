import { randomUUID } from "node:crypto";
import { RsiError } from "../shared/errors.ts";
import type {
	CommandControlPort,
	ControlCommand,
	ControlCommandResult,
	SleepGatePort,
} from "../shared/ports.ts";
import type { Clock } from "../shared/time.ts";
import { assertControlCommand } from "./protocol.ts";
import type { ReloadCoordinator } from "./reload.ts";

export interface CommandControllerOptions {
	readonly clock: Clock;
	readonly reload: ReloadCoordinator;
	readonly sleep: SleepGatePort;
	readonly stopRuntime: (reason: string, atMs: number) => Promise<void> | void;
}

function errorText(error: unknown): string {
	if (error instanceof RsiError) {
		const details = error.details === undefined ? "" : `\n${JSON.stringify(error.details)}`;
		return `${error.message}${details}\n${error.stack ?? ""}`.trim();
	}
	if (error instanceof Error) {
		return `${error.message}\n${error.stack ?? ""}`.trim();
	}
	return String(error);
}

/**
 * Trusted Supervisor command surface. It accepts only the shared finite
 * ControlCommand union, never arbitrary file or shell requests. The Agent
 * slash tool and the CLI shim have a narrower reload-only surface.
 */
export class CommandController implements CommandControlPort {
	private readonly clock: Clock;
	private readonly reload: ReloadCoordinator;
	private readonly sleep: SleepGatePort;
	private readonly stopRuntime: (reason: string, atMs: number) => Promise<void> | void;

	constructor(options: CommandControllerOptions) {
		this.clock = options.clock;
		this.reload = options.reload;
		this.sleep = options.sleep;
		this.stopRuntime = options.stopRuntime;
	}

	async dispatch(
		command: ControlCommand,
		context: { readonly source: "supervisor"; readonly atMs: number },
	): Promise<ControlCommandResult> {
		try {
			if (context.source !== "supervisor") {
				throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Only the trusted Supervisor may dispatch control commands.");
			}
			if (!Number.isSafeInteger(context.atMs) || context.atMs < 0) {
				throw new RsiError("AGENT_COMMAND_FORBIDDEN", "Control dispatch time is invalid.");
			}
			const validated = assertControlCommand(command);
			switch (validated.kind) {
				case "reload": {
					const outcome = await this.reload.request({
						requestId: randomUUID(),
						reason: validated.reason,
						...(validated.candidateId === undefined ? {} : { candidateId: validated.candidateId }),
						source: "supervisor",
						generation: this.reload.generation(),
						sessionId: null,
					});
					return { ok: true, detail: outcome.detail };
				}
				case "shutdown":
					await this.stopRuntime(validated.reason, context.atMs);
					return { ok: true, detail: "Shutdown accepted by the trusted Supervisor." };
				case "cancelSleep": {
					const cancelled = await this.sleep.cancel(validated.reason, this.clock.now());
					return {
						ok: true,
						detail: cancelled ? "Active explicit sleep cancelled." : "No active explicit sleep to cancel.",
					};
				}
			}
		} catch (error) {
			return { ok: false, error: errorText(error) };
		}
	}
}
