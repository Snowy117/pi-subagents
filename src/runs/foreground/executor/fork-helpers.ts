/** fork-helpers (split from subagent-executor.ts; internal-only). */

import { type AgentConfig } from "../../../agents/agents.ts";
import { type ChainStep, type SequentialStep, isDynamicParallelStep, isParallelStep } from "../../../shared/settings.ts";
import { type Details, wrapForkTask } from "../../../shared/types.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { getRequestedModeLabel, shouldForkAgent } from "./budget-resolution.ts";
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
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}


export function collectChainSessionFiles(
	chain: ChainStep[],
	sessionFileForTask: (agentName: string, idx?: number) => string | undefined,
	dynamicFanoutMaxItems?: number,
): (string | undefined)[] {
	const sessionFiles: (string | undefined)[] = [];
	let flatIndex = 0;
	for (const step of chain) {
		if (isParallelStep(step)) {
			for (const task of step.parallel) {
				sessionFiles.push(sessionFileForTask(task.agent, flatIndex));
				flatIndex++;
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			const maxItems = step.expand.maxItems ?? dynamicFanoutMaxItems ?? 0;
			for (let itemIndex = 0; itemIndex < maxItems; itemIndex++) {
				sessionFiles.push(sessionFileForTask(step.parallel.agent, flatIndex));
				flatIndex++;
			}
			continue;
		}
		sessionFiles.push(sessionFileForTask((step as SequentialStep).agent, flatIndex));
		flatIndex++;
	}
	return sessionFiles;
}


export function collectChainThinkingOverrides(
	chain: ChainStep[],
	thinkingOverrideForTask: (agentName: string, idx?: number) => AgentConfig["thinking"] | undefined,
	dynamicFanoutMaxItems?: number,
): (AgentConfig["thinking"] | undefined)[] {
	const thinkingOverrides: (AgentConfig["thinking"] | undefined)[] = [];
	let flatIndex = 0;
	for (const step of chain) {
		if (isParallelStep(step)) {
			for (const task of step.parallel) {
				thinkingOverrides.push(thinkingOverrideForTask(task.agent, flatIndex));
				flatIndex++;
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			const maxItems = step.expand.maxItems ?? dynamicFanoutMaxItems ?? 0;
			for (let itemIndex = 0; itemIndex < maxItems; itemIndex++) {
				thinkingOverrides.push(thinkingOverrideForTask(step.parallel.agent, flatIndex));
				flatIndex++;
			}
			continue;
		}
		thinkingOverrides.push(thinkingOverrideForTask((step as SequentialStep).agent, flatIndex));
		flatIndex++;
	}
	return thinkingOverrides;
}


export function wrapChainTasksForFork(chain: ChainStep[], contextPolicy: AgentDefaultContextPolicy): ChainStep[] {
	return chain.map((step, stepIndex) => {
		if (isParallelStep(step)) {
			return {
				...step,
				parallel: step.parallel.map((task) => ({
					...task,
					task: shouldForkAgent(contextPolicy, task.agent)
						? wrapForkTask(task.task ?? "{previous}")
						: task.task,
				})),
			};
		}
		if (isDynamicParallelStep(step)) {
			return {
				...step,
				parallel: {
					...step.parallel,
					task: shouldForkAgent(contextPolicy, step.parallel.agent)
						? wrapForkTask(step.parallel.task ?? "{previous}")
						: step.parallel.task,
				},
			};
		}
		const sequential = step as SequentialStep;
		return {
			...sequential,
			task: shouldForkAgent(contextPolicy, sequential.agent)
				? wrapForkTask(sequential.task ?? (stepIndex === 0 ? "{task}" : "{previous}"))
				: sequential.task,
		};
	});
}


export function preflightForkSessionsForStaticTasks(
	params: SubagentParamsLike,
	contextPolicy: AgentDefaultContextPolicy,
	sessionFileForTask: (agentName: string, idx?: number) => string | undefined,
	dynamicFanoutMaxItems?: number,
): void {
	if (!contextPolicy.usesFork) return;
	if (params.agent) {
		if (shouldForkAgent(contextPolicy, params.agent)) sessionFileForTask(params.agent, 0);
		return;
	}
	if (params.tasks) {
		params.tasks.forEach((task, index) => {
			if (shouldForkAgent(contextPolicy, task.agent)) sessionFileForTask(task.agent, index);
		});
		return;
	}
	if (!params.chain?.length) return;
	let flatIndex = 0;
	for (const step of params.chain) {
		if (isParallelStep(step)) {
			for (const task of step.parallel) {
				if (shouldForkAgent(contextPolicy, task.agent)) sessionFileForTask(task.agent, flatIndex);
				flatIndex++;
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			const maxItems = step.expand.maxItems ?? dynamicFanoutMaxItems ?? 0;
			if (shouldForkAgent(contextPolicy, step.parallel.agent)) {
				for (let itemIndex = 0; itemIndex < maxItems; itemIndex++) sessionFileForTask(step.parallel.agent, flatIndex + itemIndex);
			}
			flatIndex += maxItems;
			continue;
		}
		const sequential = step as SequentialStep;
		if (shouldForkAgent(contextPolicy, sequential.agent)) sessionFileForTask(sequential.agent, flatIndex);
		flatIndex++;
	}
}
