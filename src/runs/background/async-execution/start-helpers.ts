import type { SubagentRunMode } from "../../../shared/types.ts";
import type { AsyncExecutionResult } from "./types.ts";

export const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: pi-subagents";

export class UnavailableSubagentSkillError extends Error {}

export class AsyncStartValidationError extends Error {}

export function formatAsyncStartedMessage(headline: string): string {
	return [
		headline,
		"",
		"The async run is detached. Do not run sleep timers or polling loops just to wait for it.",
		"If you have independent work, continue that work. When you have nothing left to do until the async result arrives, call wait() — it blocks until the run finishes and delivers the completion here. Only if you are certain you will get another turn (an interactive session where the user will prompt you again) can you instead stop and let Pi wake you; inside a skill that must run to completion, or in a non-interactive run, there is no next turn, so use wait().",
		"Use subagent({ action: \"status\", id: \"...\" }) when you need a one-shot status/result or to inspect a blocked/stale run. To block until completion, prefer wait(). Do not poll in a loop just to wait.",
	].join("\n");
}

export function formatAsyncStartError(mode: SubagentRunMode, message: string): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}
