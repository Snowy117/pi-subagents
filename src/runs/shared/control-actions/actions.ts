export const CONTROL_ACTION_VERSION = 1 as const;

export interface ChildControlActionRequest {
	version: typeof CONTROL_ACTION_VERSION;
	type: "action";
	id: string;
	ts: number;
	action: string;
	payload?: unknown;
	source?: string;
}

export interface ChildControlActionResponse {
	version: typeof CONTROL_ACTION_VERSION;
	type: "action_response";
	requestId: string;
	ts: number;
	status: "applied" | "rejected";
	action: string;
	result?: unknown;
	error?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonRecord, allowed: readonly string[]): boolean {
	const keys = new Set(allowed);
	return Object.keys(value).every((key) => keys.has(key));
}

function validText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseControlActionRequest(value: unknown): ChildControlActionRequest | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["version", "type", "id", "ts", "action", "payload", "source"])) return undefined;
	if (value.version !== CONTROL_ACTION_VERSION || value.type !== "action") return undefined;
	if (!validText(value.id) || !validTimestamp(value.ts) || !validText(value.action)) return undefined;
	if (value.source !== undefined && !validText(value.source)) return undefined;
	return {
		version: CONTROL_ACTION_VERSION,
		type: "action",
		id: value.id.trim(),
		ts: value.ts,
		action: value.action.trim(),
		...(Object.hasOwn(value, "payload") ? { payload: value.payload } : {}),
		...(value.source !== undefined ? { source: value.source.trim() } : {}),
	};
}

export function parseControlActionResponse(value: unknown): ChildControlActionResponse | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["version", "type", "requestId", "ts", "status", "action", "result", "error"])) return undefined;
	if (value.version !== CONTROL_ACTION_VERSION || value.type !== "action_response") return undefined;
	if (!validText(value.requestId) || !validTimestamp(value.ts) || !validText(value.action)) return undefined;
	if (value.status !== "applied" && value.status !== "rejected") return undefined;
	if (value.error !== undefined && !validText(value.error)) return undefined;
	if (value.status === "applied" && value.error !== undefined) return undefined;
	if (value.status === "rejected" && (value.result !== undefined || !validText(value.error))) return undefined;
	return {
		version: CONTROL_ACTION_VERSION,
		type: "action_response",
		requestId: value.requestId.trim(),
		ts: value.ts,
		status: value.status,
		action: value.action.trim(),
		...(Object.hasOwn(value, "result") ? { result: value.result } : {}),
		...(value.error !== undefined ? { error: value.error.trim() } : {}),
	};
}
