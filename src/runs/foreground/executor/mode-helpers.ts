/** mode-helpers (split from subagent-executor.ts; internal-only). */

import { type Details, type SubagentRunMode } from "../../../shared/types.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type SubagentParamsLike } from "./types.ts";


export function inferExecutionMode(params: SubagentParamsLike): SubagentRunMode {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	return "single";
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


export function omitExecutionModeActionAlias(params: SubagentParamsLike): SubagentParamsLike {
	const action = params.action?.toLowerCase();
	if (action === "single" && (params.agent !== undefined || params.task !== undefined)) {
		const rest = { ...params };
		delete rest.action;
		return rest;
	}
	if ((action === "parallel" || action === "tasks") && (params.tasks?.length ?? 0) > 0) {
		const rest = { ...params };
		delete rest.action;
		return rest;
	}
	return params;
}
