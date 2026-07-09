/** async-path (split from subagent-executor.ts; internal-only). */

import { normalizeSkillInput } from "../../../agents/skills.ts";
import { resolveSubagentIntercomTarget } from "../../../intercom/intercom-bridge.ts";
import { type ModelInfo, toModelInfo } from "../../../shared/model-info.ts";
import { type ChainStep } from "../../../shared/settings.ts";
import { type Details, resolveChildMaxSubagentDepth, resolveCurrentMaxSubagentDepth, resolveTopLevelParallelConcurrency, resolveTopLevelParallelMaxTasks, wrapForkTask } from "../../../shared/types.ts";
import { executeAsyncChain, executeAsyncSingle, isAsyncAvailable } from "../../background/async-execution.ts";
import { resolveSubagentModelOverride } from "../../shared/model-fallback.ts";
import { normalizeSingleOutputOverride } from "../../shared/single-output.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { shouldForkAgent } from "./budget-resolution.ts";
import { collectChainSessionFiles, collectChainThinkingOverrides, wrapChainTasksForFork } from "./fork-helpers.ts";
import { buildChainWorktreeTaskCwdError, buildParallelModeError, buildParallelWorktreeTaskCwdError, resolveSingleRunOutputBaseDir } from "./parallel-helpers.ts";
import { type ExecutionContextData, type ExecutorDeps } from "./types.ts";


export function runAsyncPath(data: ExecutionContextData, deps: ExecutorDeps): AgentToolResult<Details> | null {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		shareEnabled,
		sessionRoot,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		artifactConfig,
		artifactsDir,
		effectiveAsync,
		controlConfig,
		intercomBridge,
		nestedRoute,
		contextPolicy,
	} = data;
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
	if (!effectiveAsync) return null;

	if (hasChain && params.chain) {
		const chainWorktreeTaskCwdError = buildChainWorktreeTaskCwdError(params.chain as ChainStep[], effectiveCwd);
		if (chainWorktreeTaskCwdError) {
			return {
				content: [{ type: "text", text: chainWorktreeTaskCwdError }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
	}

	if (hasTasks && params.tasks) {
		const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
		if (params.tasks.length > maxParallelTasks) {
			return buildParallelModeError(`Max ${maxParallelTasks} tasks`);
		}
		if (params.worktree) {
			const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(params.tasks, effectiveCwd);
			if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
		}
	}

	if (!isAsyncAvailable()) {
		return {
			content: [{ type: "text", text: "Async mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}
	const id = randomUUID();
	const asyncCtx = {
		pi: deps.pi,
		cwd: ctx.cwd,
		currentSessionId: deps.state.currentSessionId!,
		parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
		currentModelProvider: ctx.model?.provider,
		currentModel: ctx.model,
		modelScope: data.modelScope,
	};
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const currentProvider = ctx.model?.provider;
	const controlIntercomTarget = intercomBridge.active ? intercomBridge.orchestratorTarget : undefined;
	const childIntercomTarget = intercomBridge.active ? (agent: string, index: number) => resolveSubagentIntercomTarget(id, agent, index) : undefined;

	if (hasTasks && params.tasks) {
		const agentConfigs = params.tasks.map((task) => agents.find((agent) => agent.name === task.agent));
		const modelOverrides = params.tasks.map((task, index) =>
			resolveSubagentModelOverride(task.model ?? agentConfigs[index]?.model, ctx.model, availableModels, currentProvider, { scope: data.modelScope, source: task.model ? "explicit" : "inherited" }),
		);
		const skillOverrides = params.tasks.map((task) => normalizeSkillInput(task.skill));
		const parallelTasks = params.tasks.map((task, index) => ({
			agent: task.agent,
			task: shouldForkAgent(contextPolicy, task.agent) ? wrapForkTask(task.task) : task.task,
			cwd: task.cwd,
			...(modelOverrides[index] ? { model: modelOverrides[index] } : {}),
			...(skillOverrides[index] !== undefined ? { skill: skillOverrides[index] } : {}),
			...(task.output === true ? (agentConfigs[index]?.output ? { output: agentConfigs[index]!.output } : {}) : task.output !== undefined ? { output: task.output } : {}),
			...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
			...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
			...(task.progress !== undefined ? { progress: task.progress } : {}),
			...(task.toolBudget !== undefined ? { toolBudget: task.toolBudget } : {}),
			...(task.acceptance !== undefined ? { acceptance: task.acceptance } : {}),
		}));
		return executeAsyncChain(id, {
			chain: [{
				parallel: parallelTasks,
				concurrency: resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency),
				worktree: params.worktree,
			}],
			resultMode: "parallel",
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: [],
			sessionFilesByFlatIndex: params.tasks.map((task, index) => sessionFileForTask(task.agent, index)),
			thinkingOverridesByFlatIndex: params.tasks.map((task, index) => thinkingOverrideForTask(task.agent, index)),
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget,
			nestedRoute,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
			configToolBudget: data.configToolBudget,
			globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
		});
	}

	if (hasChain && params.chain) {
		const normalized = normalizeSkillInput(params.skill);
		const chainSkills = normalized === false ? [] : (normalized ?? []);
		const chain = wrapChainTasksForFork(params.chain as ChainStep[], contextPolicy);
		return executeAsyncChain(id, {
			chain,
			task: params.task,
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(chain, sessionFileForTask, deps.config.chain?.dynamicFanout?.maxItems),
			thinkingOverridesByFlatIndex: collectChainThinkingOverrides(chain, thinkingOverrideForTask, deps.config.chain?.dynamicFanout?.maxItems),
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget,
			nestedRoute,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
			configToolBudget: data.configToolBudget,
			globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
		});
	}

	if (hasSingle) {
		const a = agents.find((x) => x.name === params.agent);
		if (!a) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}
		const rawOutput = params.output !== undefined ? params.output : a.output;
		const effectiveOutput = normalizeSingleOutputOverride(rawOutput, a.output);
		const effectiveOutputMode = params.outputMode ?? "inline";
		const normalizedSkills = normalizeSkillInput(params.skill);
		const skills = normalizedSkills === false ? [] : normalizedSkills;
		const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, a.maxSubagentDepth);
		const modelOverride = resolveSubagentModelOverride((params.model as string | undefined) ?? a.model, ctx.model, availableModels, currentProvider, { scope: data.modelScope, source: (params.model as string | undefined) ? "explicit" : "inherited" });
		return executeAsyncSingle(id, {
			agent: params.agent!,
			task: shouldForkAgent(contextPolicy, params.agent!) ? wrapForkTask(params.task ?? "") : (params.task ?? ""),
			agentConfig: a,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			sessionFile: sessionFileForTask(params.agent!, 0),
			skills,
			output: effectiveOutput,
			outputMode: effectiveOutputMode,
			outputBaseDir: resolveSingleRunOutputBaseDir(deps, artifactsDir, id),
			modelOverride,
			thinkingOverride: thinkingOverrideForTask(params.agent!, 0),
			maxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(agent, index) : undefined,
			nestedRoute,
			acceptance: params.acceptance,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
			configToolBudget: data.configToolBudget,
		});
	}

	return null;
}
