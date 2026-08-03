/** async-path (split from subagent-executor.ts; internal-only). */

import { normalizeSkillInput } from "../../../agents/skills.ts";
import { resolveSubagentIntercomTarget } from "../../../intercom/intercom-bridge.ts";
import { type ModelInfo, toModelInfo } from "../../../shared/model-info.ts";
import { type Details, resolveChildMaxSubagentDepth, resolveCurrentMaxSubagentDepth, resolveTopLevelParallelConcurrency, resolveTopLevelParallelMaxTasks, wrapForkTask } from "../../../shared/types.ts";
import { executeAsyncChain, executeAsyncSingle, isAsyncAvailable } from "../../background/async-execution.ts";
import { completionToToolResult } from "../../background/completion-result.ts";
import { activeRunsForSession, type WaitDeps, waitForSubagents, waitForWake } from "../../background/wait.ts";
import { resolveSubagentModelOverride } from "../../shared/model-fallback.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { shouldForkAgent } from "./budget-resolution.ts";
import { buildParallelModeError, buildParallelWorktreeTaskCwdError, resolveSingleRunOutputBaseDir } from "./parallel-helpers.ts";
import { type ExecutionContextData, type ExecutorDeps } from "./types.ts";

export async function waitForLaunchedRunAttention(
	id: string,
	signal: AbortSignal,
	deps: WaitDeps,
): Promise<AgentToolResult<Details> | undefined> {
	while (!signal.aborted) {
		const registered = activeRunsForSession({ id }, deps).some((run) => run.id === id);
		if (!registered) {
			await waitForWake(250, signal, deps);
			continue;
		}
		const observed = await waitForSubagents({ id }, signal, deps);
		if (signal.aborted) return undefined;
		const stillActive = activeRunsForSession({ id }, deps).some((run) => run.id === id);
		if (stillActive) return observed;
		await waitForWake(250, signal, deps);
	}
	return undefined;
}

export async function runAsyncPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		sessionRoot,
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
	const hasTasks = (params.tasks?.length ?? 0) > 0;

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
	const id = data.runId;
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

	if (!hasTasks || !params.tasks) {
		return { content: [{ type: "text", text: "Execution requires at least one task." }], isError: true, details: { mode: "single", results: [] } };
	}
	const taskDescriptors = params.tasks.map((task) => ({ agent: task.agent, task: task.task }));
	if (!effectiveAsync) {
		deps.state.completionBroker!.claim({ runId: id, sessionId: deps.state.currentSessionId!, mode: data.executionMode, tasks: taskDescriptors });
	}

	let launchResult: AgentToolResult<Details>;
	if (params.tasks.length === 1) {
		const task = params.tasks[0]!;
		const agentConfig = agents.find((agent) => agent.name === task.agent)!;
		const normalizedSkills = normalizeSkillInput(task.skill);
		const skills = normalizedSkills === false ? [] : normalizedSkills;
		const modelOverride = resolveSubagentModelOverride(task.model ?? agentConfig.model, ctx.model, availableModels, currentProvider, { scope: data.modelScope, source: task.model ? "explicit" : "inherited" });
		launchResult = executeAsyncSingle(id, {
			agent: task.agent,
			task: shouldForkAgent(contextPolicy, task.agent) ? wrapForkTask(task.task) : task.task,
			agentConfig,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled: false,
			sessionRoot,
			sessionFile: sessionFileForTask(task.agent, 0),
			skills,
			output: agentConfig.output,
			outputMode: "inline",
			outputBaseDir: resolveSingleRunOutputBaseDir(deps, artifactsDir, id),
			modelOverride,
			thinkingOverride: thinkingOverrideForTask(task.agent, 0),
			maxSubagentDepth: resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth),
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(agent, index) : undefined,
			nestedRoute,
		});
	} else {
		const agentConfigs = params.tasks.map((task) => agents.find((agent) => agent.name === task.agent));
		const modelOverrides = params.tasks.map((task, index) =>
			resolveSubagentModelOverride(task.model ?? agentConfigs[index]?.model, ctx.model, availableModels, currentProvider, { scope: data.modelScope, source: task.model ? "explicit" : "inherited" }),
		);
		const skillOverrides = params.tasks.map((task) => normalizeSkillInput(task.skill));
		const parallelTasks = params.tasks.map((task, index) => ({
			agent: task.agent,
			task: shouldForkAgent(contextPolicy, task.agent) ? wrapForkTask(task.task) : task.task,
			...(modelOverrides[index] ? { model: modelOverrides[index] } : {}),
			...(skillOverrides[index] !== undefined ? { skill: skillOverrides[index] } : {}),
			...(task.progress !== undefined ? { progress: task.progress } : {}),
		}));
		launchResult = executeAsyncChain(id, {
			chain: [{
				parallel: parallelTasks,
				concurrency: resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency),
				worktree: params.worktree,
			}],
			resultMode: data.executionMode,
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled: false,
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
			globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
		});
	}
	if (effectiveAsync || launchResult.isError) {
		if (launchResult.isError) deps.state.completionBroker!.release(id);
		return launchResult;
	}
	const waitDeps = {
		state: deps.state,
		events: deps.pi.events,
		...(deps.waitLifecycleRoots ?? {}),
		getActionableSupervisorRequests: deps.getActionableSupervisorRequests,
	};
	const brokerWaitController = new AbortController();
	const waitObservationController = new AbortController();
	const abortBrokerWait = () => {
		brokerWaitController.abort();
		waitObservationController.abort();
	};
	data.signal.addEventListener("abort", abortBrokerWait, { once: true });
	const completionPromise = deps.state.completionBroker!.wait(id, brokerWaitController.signal);
	const waitPromise = waitForLaunchedRunAttention(id, waitObservationController.signal, waitDeps);
	try {
		const first = await Promise.race([
			completionPromise.then((completion) => ({ kind: "completion" as const, completion })),
			waitPromise.then((result) => ({ kind: "wait" as const, result })),
		]);
		const cached = first.kind === "completion" ? first.completion : deps.state.completionBroker!.get(id);
		if (cached) return completionToToolResult(cached, taskDescriptors);
		if (data.signal.aborted) {
			return { content: [{ type: "text", text: `Wait aborted for detached run ${id}; the subagent is still running.` }], isError: true, details: { mode: data.executionMode, runId: id, asyncId: id, results: [] } };
		}
		if (first.kind === "wait" && first.result) {
			brokerWaitController.abort();
			return { ...first.result, details: { ...first.result.details, mode: data.executionMode, runId: id, asyncId: id } };
		}
		const completion = await completionPromise;
		if (completion) return completionToToolResult(completion, taskDescriptors);
		return { content: [{ type: "text", text: `Completion data for detached run ${id} became unavailable.` }], isError: true, details: { mode: data.executionMode, runId: id, asyncId: id, results: [] } };
	} finally {
		data.signal.removeEventListener("abort", abortBrokerWait);
		waitObservationController.abort();
		const terminalCompletionIsCached = deps.state.completionBroker!.get(id) !== undefined;
		if (!terminalCompletionIsCached) deps.state.completionBroker!.release(id);
	}
}
