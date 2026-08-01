/** budget-resolution (split from subagent-executor.ts; internal-only). */

import { type AgentConfig } from "../../../agents/agents.ts";
import { type Details } from "../../../shared/types.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { withForkContext } from "./fork-helpers.ts";
import { type AgentDefaultContextPolicy, type SubagentParamsLike, type TaskParam } from "./types.ts";


export function resolveAgentDefaultContextPolicy(params: SubagentParamsLike, agents: AgentConfig[]): AgentDefaultContextPolicy {
	if (params.context !== undefined) {
		return resolveExplicitContextPolicy(params);
	}
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const contextForAgent = (agentName: string): "fresh" | "fork" =>
		byName.get(agentName)?.defaultContext === "fork" ? "fork" : "fresh";
	const usesFork = (params.tasks ?? []).some((task) => contextForAgent(task.agent) === "fork");
	return {
		params: usesFork ? { ...params, context: "fork" } : params,
		contextForAgent,
		usesFork,
	};
}


export function resolveExplicitContextPolicy(params: SubagentParamsLike): AgentDefaultContextPolicy {
	const context = params.context === "fork" ? "fork" : "fresh";
	return {
		params,
		contextForAgent: () => context,
		usesFork: context === "fork",
	};
}


export function shouldForkAgent(contextPolicy: AgentDefaultContextPolicy, agentName: string): boolean {
	return contextPolicy.contextForAgent(agentName) === "fork";
}


export function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
	const expanded: TaskParam[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		const rawCount = (task as TaskParam & { count?: unknown }).count;
		if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
			return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
		}
		const { count, ...concreteTask } = task;
		for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
			expanded.push({ ...concreteTask });
		}
	}
	return { tasks: expanded };
}


export function normalizeRepeatedParallelCounts(params: SubagentParamsLike): { params?: SubagentParamsLike; error?: undefined } {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) {
			return { error: undefined, params: undefined };
		}
		return { params: { ...params, tasks: expandedTasks.tasks } };
	}
	return { params };
}