/** validation (split from subagent-executor.ts; internal-only). */

import { type AgentConfig } from "../../../agents/agents.ts";
import { type Details } from "../../../shared/types.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type SubagentParamsLike } from "./types.ts";


export function validateExecutionInput(
	params: SubagentParamsLike,
	agents: AgentConfig[],
): AgentToolResult<Details> | null {
	if (!params.tasks || params.tasks.length === 0) {
		return {
			content: [{ type: "text", text: "tasks is required with at least one entry." }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}
	for (let i = 0; i < params.tasks.length; i++) {
		const task = params.tasks[i]!;
		if (!task.agent) {
			return {
				content: [{ type: "text", text: `tasks[${i}].agent is required.` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}
		if (!task.task && task.task !== "") {
			return {
				content: [{ type: "text", text: `tasks[${i}].task is required.` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}
		if (!agents.find((agent) => agent.name === task.agent)) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${task.agent} (task ${i + 1})` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}
	}
	return null;
}