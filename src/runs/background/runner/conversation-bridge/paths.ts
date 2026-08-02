/**
 * Path helpers + the stepKey contract for the conversation bridge.
 * The stepKey rule here is load-bearing: the parent-side bridge (Phase 5)
 * resolves stepKeys with the same function, so both sides must agree exactly.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Directory (under the run asyncDir) holding all bridge files. */
export const CONVERSATION_DIR_NAME = "conversation";

export function conversationDir(asyncDir: string): string {
	return path.join(asyncDir, CONVERSATION_DIR_NAME);
}

export function ensureConversationDir(asyncDir: string): string {
	const dir = conversationDir(asyncDir);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function relayFilePath(dir: string, stepKey: string): string {
	return path.join(dir, `${stepKey}.stdout.jsonl`);
}

export function requestsFilePath(dir: string, stepKey: string): string {
	return path.join(dir, `${stepKey}.requests.jsonl`);
}

export function heartbeatFilePath(dir: string, stepKey: string): string {
	return path.join(dir, `${stepKey}.active`);
}

/** Filesystem-safe stepKey component (same rule as artifact agent sanitization). */
export function sanitizeStepKeyComponent(value: string): string {
	return value.replace(/[^\w.-]/g, "_");
}

/**
 * The exact stepKey rule: `${sanitize(stepIndex)}-${sanitize(agent)}`,
 * flat step index first, then agent, both sanitized with
 * `[^\w.-] -> "_"`. Parsing is unambiguous because the left component is
 * all-digits (agent may contain dashes — the first dash still splits
 * "0-my-agent" as index 0, agent "my-agent").
 */
export function resolveConversationStepKey(stepIndex: number, agent: string): string {
	return `${sanitizeStepKeyComponent(String(stepIndex))}-${sanitizeStepKeyComponent(agent)}`;
}