export type { ControlCommand, ControlCommandResult } from "../shared/ports.ts";

/** Local control frames are small: one finite command plus metadata. */
export const CONTROL_MAX_FRAME_BYTES = 64 * 1024;
export const CONTROL_DEFAULT_TIMEOUT_MS = 15_000;

/** Environment contract used by the read-only `pi` shim. */
export const CONTROL_ENDPOINT_ENV = "RSI_CONTROL_SOCKET";
export const CONTROL_TOKEN_ENV = "RSI_CONTROL_TOKEN";
export const CONTROL_GENERATION_ENV = "RSI_SESSION_GENERATION";
export const CONTROL_SESSION_ENV = "RSI_SESSION_ID";
export const CONTROL_TIMEOUT_ENV = "RSI_CONTROL_TIMEOUT_MS";
export const REAL_PI_CLI_ENV = "RSI_PI_REAL_CLI";
export const SHIM_MARKER_ENV = "RSI_PI_SHIM_ACTIVE";
