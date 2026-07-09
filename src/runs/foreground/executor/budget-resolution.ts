/** budget-resolution (split from subagent-executor.ts; internal-only). */

import { type AgentConfig } from "../../../agents/agents.ts";
import { type ChainStep, getStepAgents, isParallelStep } from "../../../shared/settings.ts";
import { type Details, type ExtensionConfig, type ResolvedToolBudget, type ResolvedTurnBudget, type ToolBudgetConfig } from "../../../shared/types.ts";
import { validateToolBudgetConfig } from "../../shared/tool-budget.ts";
import { DEFAULT_TURN_BUDGET_GRACE_TURNS } from "../../shared/turn-budget.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { withForkContext } from "./fork-helpers.ts";
import { type AgentDefaultContextPolicy, type SubagentParamsLike, type TaskParam } from "./types.ts";


export function getRequestedModeLabel(params: SubagentParamsLike): Details["mode"] {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	if (params.agent) return "single";
	return "single";
}


export function resolveAgentDefaultContextPolicy(params: SubagentParamsLike, agents: AgentConfig[]): AgentDefaultContextPolicy {
	if (params.context !== undefined) {
		return resolveExplicitContextPolicy(params);
	}
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const contextForAgent = (agentName: string): "fresh" | "fork" =>
		byName.get(agentName)?.defaultContext === "fork" ? "fork" : "fresh";
	const usesFork = collectRequestedAgentNames(params).some((name) => contextForAgent(name) === "fork");
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


export function collectRequestedAgentNames(params: SubagentParamsLike): string[] {
	const names: string[] = [];
	if (params.agent) names.push(params.agent);
	for (const task of params.tasks ?? []) names.push(task.agent);
	for (const step of params.chain ?? []) names.push(...getStepAgents(step));
	return names;
}


export function shouldForkAgent(contextPolicy: AgentDefaultContextPolicy, agentName: string): boolean {
	return contextPolicy.contextForAgent(agentName) === "fork";
}


export function buildRequestedModeError(params: SubagentParamsLike, message: string): AgentToolResult<Details> {
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}


export function resolveForegroundTimeout(params: SubagentParamsLike): { timeoutMs?: number; error?: string } {
	const rawTimeout = params.timeoutMs;
	const rawMaxRuntime = params.maxRuntimeMs;
	if (rawTimeout === undefined && rawMaxRuntime === undefined) return {};
	for (const [name, value] of [["timeoutMs", rawTimeout], ["maxRuntimeMs", rawMaxRuntime]] as const) {
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
			return { error: `${name} must be a positive integer.` };
		}
	}
	if (rawTimeout !== undefined && rawMaxRuntime !== undefined && rawTimeout !== rawMaxRuntime) {
		return { error: "timeoutMs and maxRuntimeMs are aliases; provide only one value or use the same value for both." };
	}
	return { timeoutMs: rawTimeout ?? rawMaxRuntime };
}


export function resolveTurnBudget(params: SubagentParamsLike, config: ExtensionConfig): { turnBudget?: ResolvedTurnBudget; error?: string } {
	const raw = params.turnBudget ?? config.turnBudget;
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "turnBudget must be an object with maxTurns and optional graceTurns." };
	if (typeof raw.maxTurns !== "number" || !Number.isInteger(raw.maxTurns) || raw.maxTurns < 1) {
		return { error: "turnBudget.maxTurns must be an integer >= 1." };
	}
	const graceTurns = raw.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS;
	if (typeof graceTurns !== "number" || !Number.isInteger(graceTurns) || graceTurns < 0) {
		return { error: "turnBudget.graceTurns must be an integer >= 0." };
	}
	return { turnBudget: { maxTurns: raw.maxTurns, graceTurns } };
}


export function resolveToolBudget(raw: unknown, label = "toolBudget"): { toolBudget?: ResolvedToolBudget; error?: string } {
	const resolved = validateToolBudgetConfig(raw, label);
	return { toolBudget: resolved.budget, error: resolved.error };
}


export function resolveEffectiveToolBudget(input: { stepBudget?: ToolBudgetConfig; runBudget?: ResolvedToolBudget; agentBudget?: ToolBudgetConfig; configBudget?: ToolBudgetConfig }): { toolBudget?: ResolvedToolBudget; error?: string } {
	if (input.stepBudget !== undefined) return resolveToolBudget(input.stepBudget, "toolBudget");
	if (input.runBudget !== undefined) return { toolBudget: input.runBudget };
	if (input.agentBudget !== undefined) return resolveToolBudget(input.agentBudget, "agent.toolBudget");
	return resolveToolBudget(input.configBudget, "config.toolBudget");
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


export function expandChainParallelCounts(chain: ChainStep[]): { chain?: ChainStep[]; error?: string } {
	const expandedChain: ChainStep[] = [];
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step)) {
			expandedChain.push(step);
			continue;
		}
		const expandedParallel = [];
		for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
			const task = step.parallel[taskIndex]!;
			const rawCount = (task as typeof task & { count?: unknown }).count;
			if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
				return { error: `chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1` };
			}
			const { count, ...concreteTask } = task;
			for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
				expandedParallel.push({ ...concreteTask });
			}
		}
		expandedChain.push({ ...step, parallel: expandedParallel });
	}
	return { chain: expandedChain };
}


export function normalizeRepeatedParallelCounts(params: SubagentParamsLike): { params?: SubagentParamsLike; error?: AgentToolResult<Details> } {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) {
			return { error: buildRequestedModeError(params, expandedTasks.error) };
		}
		return { params: { ...params, tasks: expandedTasks.tasks } };
	}
	if (params.chain) {
		const expandedChain = expandChainParallelCounts(params.chain);
		if (expandedChain.error) {
			return { error: buildRequestedModeError(params, expandedChain.error) };
		}
		return { params: { ...params, chain: expandedChain.chain } };
	}
	return { params };
}
