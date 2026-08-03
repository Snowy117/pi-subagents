/** mode-helpers (split from subagent-executor.ts; internal-only). */

import { type Details, type SubagentRunMode } from "../../../shared/types.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type SubagentParamsLike } from "./types.ts";


export function inferExecutionMode(params: SubagentParamsLike): SubagentRunMode {
	if ((params.tasks?.length ?? 0) > 1) return "parallel";
	return "single";
}

export function modeForConcreteInvocationCount(count: number): "single" | "parallel" {
	return count > 1 ? "parallel" : "single";
}


export function duplicateSubagentCallResult(params: SubagentParamsLike): AgentToolResult<Details> {
	return {
		content: [{
			type: "text",
			text: "Rejected: a subagent call is already in progress. Issue exactly ONE subagent call per turn.",
		}],
		isError: true,
		details: { mode: inferExecutionMode(params), results: [] },
	};
}
