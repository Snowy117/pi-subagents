import * as fs from "node:fs";
import { conversationDir, heartbeatFilePath } from "./paths.ts";

/** How long a heartbeat stays fresh after its `ts` without refresh. */
export const DEFAULT_HEARTBEAT_TTL_MS = 30_000;

export interface HeartbeatPayload {
	ts: number;
}

export function readHeartbeat(asyncDir: string, stepKey: string): HeartbeatPayload | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(heartbeatFilePath(conversationDir(asyncDir), stepKey), "utf-8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as { ts?: unknown };
		if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) return undefined;
		return { ts: parsed.ts };
	} catch {
		return undefined;
	}
}

/** True while the parent keeps rewriting `<stepKey>.active` within the TTL. */
export function isConversing(
	asyncDir: string,
	stepKey: string,
	now: number = Date.now(),
	ttlMs: number = DEFAULT_HEARTBEAT_TTL_MS,
): boolean {
	const heartbeat = readHeartbeat(asyncDir, stepKey);
	if (!heartbeat) return false;
	return now - heartbeat.ts <= ttlMs;
}

export function listConversationKeys(asyncDir: string): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(conversationDir(asyncDir));
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".active"))
		.map((name) => name.slice(0, -".active".length));
}

/** Remove every `<stepKey>.active` file (viewer close / session shutdown). */
export function clearBridgeHeartbeats(asyncDir: string): void {
	for (const stepKey of listConversationKeys(asyncDir)) {
		try {
			fs.rmSync(heartbeatFilePath(conversationDir(asyncDir), stepKey), { force: true });
		} catch {
			// Best-effort housekeeping; a raced file is fine to leave behind.
		}
	}
}