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
		"If you have independent work, continue it. When this turn must block for the result, call subagent({ action: \"wait\", id: \"...\" }); it waits without an orchestration timeout and leaves the detached runner alive if the turn is cancelled or the run needs attention.",
		"Use subagent({ action: \"status\", id: \"...\" }) for a one-shot inspection. Do not poll status in a loop just to wait; ordinary detached work can instead finish through its completion notification.",
	].join("\n");
}

export function formatAsyncStartError(mode: SubagentRunMode, message: string): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}
