/** fork-helpers (split from subagent-executor.ts; internal-only). */

import { type Details, wrapForkTask } from "../../../shared/types.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { shouldForkAgent } from "./budget-resolution.ts";
import { type AgentDefaultContextPolicy, type SubagentParamsLike } from "./types.ts";


export function withForkContext(
	result: AgentToolResult<Details>,
	context: SubagentParamsLike["context"],
): AgentToolResult<Details> {
	if (context !== "fork" || !result.details) return result;
	return {
		...result,
		details: {
			...result.details,
			context: "fork",
		},
	};
}


export function toExecutionErrorResult(params: SubagentParamsLike, error: unknown): AgentToolResult<Details> {
	const message = error instanceof Error ? error.message : String(error);
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: "single", results: [] },
		},
		params.context,
	);
}


export function preflightForkSessionsForStaticTasks(
	params: SubagentParamsLike,
	contextPolicy: AgentDefaultContextPolicy,
	sessionFileForTask: (agentName: string, idx?: number) => string | undefined,
): void {
	if (!contextPolicy.usesFork) return;
	if (params.tasks) {
		params.tasks.forEach((task, index) => {
			if (shouldForkAgent(contextPolicy, task.agent)) sessionFileForTask(task.agent, index);
		});
		return;
	}
}
