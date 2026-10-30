/** JSON values accepted by the RSI IPC and persisted control state. */
export type RsiJsonValue = null | boolean | number | string | readonly RsiJsonValue[] | RsiJsonObject;

/** JSON object with string keys. */
export interface RsiJsonObject {
	readonly [key: string]: RsiJsonValue;
}

/** Return true when a value can be serialized by JSON.stringify without lossy conversion. */
export function isRsiJsonValue(value: unknown): value is RsiJsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isRsiJsonValue);
	if (typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(value as Record<string, unknown>).every(isRsiJsonValue);
}
