/** chain-path (split from subagent-executor.ts; internal-only). */

import { normalizeSkillInput } from "../../../agents/skills.ts";
import { resolveSubagentIntercomTarget } from "../../../intercom/intercom-bridge.ts";
import { getProjectChainRunsDir } from "../../../shared/artifacts.ts";
import { toModelInfo } from "../../../shared/model-info.ts";
import { type ChainStep } from "../../../shared/settings.ts";
import { type Details, resolveCurrentMaxSubagentDepth } from "../../../shared/types.ts";
import { compactForegroundDetails, sumResultsCost } from "../../../shared/utils.ts";
import { executeAsyncChain, isAsyncAvailable } from "../../background/async-execution.ts";
import { attachRootChildrenToSteps, updateForegroundNestedProjection } from "../../shared/nested-events.ts";
import { executeChain } from ".././chain-execution.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { notifyForegroundDetachedCompletion } from "./foreground-notify.ts";
import { rememberForegroundRun, updateRememberedForegroundChild } from "./foreground-state.ts";
import { collectChainSessionFiles, collectChainThinkingOverrides, wrapChainTasksForFork } from "./fork-helpers.ts";
import { createForegroundControlNotifier, maybeBuildForegroundIntercomReceipt } from "./intercom-result.ts";
import { type ExecutionContextData, type ExecutorDeps } from "./types.ts";


export async function runChainPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		artifactsDir,
		artifactConfig,
		onUpdate,
		sessionRoot,
		controlConfig,
		contextPolicy,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const normalized = normalizeSkillInput(params.skill);
	const chainSkills = normalized === false ? [] : (normalized ?? []);
	const chain = wrapChainTasksForFork(params.chain as ChainStep[], contextPolicy);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const chainResult = await executeChain({
		chain,
		task: params.task,
		agents,
		ctx,
		modelScope: data.modelScope,
		intercomEvents: deps.pi.events,
		signal,
		runId,
		cwd: effectiveCwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		artifactsDir,
		artifactConfig,
		includeProgress: params.includeProgress,
		clarify: params.clarify,
		onUpdate,
		onControlEvent,
		controlConfig,
		childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
		orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
		foregroundControl,
		nestedRoute: foregroundControl?.nestedRoute,
		chainSkills,
		chainDir: params.chainDir ?? getProjectChainRunsDir(effectiveCwd),
		dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
		maxSubagentDepth: currentMaxSubagentDepth,
		worktreeSetupHook: deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
		worktreeBaseDir: deps.config.worktreeBaseDir,
		timeoutMs: data.timeoutMs,
		deadlineAt: data.deadlineAt,
		turnBudget: data.turnBudget,
		onDetachedExit: (index, result) => {
			updateRememberedForegroundChild(deps.state, { runId, mode: "chain", cwd: effectiveCwd, index, result });
			notifyForegroundDetachedCompletion({ events: deps.pi.events, state: deps.state, runId, mode: "chain", index, result, orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined });
		},
		toolBudget: data.toolBudget,
		configToolBudget: data.configToolBudget,
		globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
	});

	if (chainResult.requestedAsync) {
		if (!isAsyncAvailable()) {
			return {
				content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
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
		const asyncChain = wrapChainTasksForFork(chainResult.requestedAsync.chain, contextPolicy);
		return executeAsyncChain(id, {
			chain: asyncChain,
			task: params.task,
			agents,
			ctx: asyncCtx,
			availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: chainResult.requestedAsync.chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(asyncChain, sessionFileForTask, deps.config.chain?.dynamicFanout?.maxItems),
			thinkingOverridesByFlatIndex: collectChainThinkingOverrides(asyncChain, thinkingOverrideForTask, deps.config.chain?.dynamicFanout?.maxItems),
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
			nestedRoute: data.nestedRoute,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
			configToolBudget: data.configToolBudget,
			globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
		});
	}

	const rawChainDetails = chainResult.details ? { ...chainResult.details, runId } : undefined;
	if (foregroundControl && rawChainDetails) {
		updateForegroundNestedProjection(foregroundControl);
		attachRootChildrenToSteps(runId, rawChainDetails.results, foregroundControl.nestedChildren);
		rawChainDetails.totalCost = sumResultsCost(rawChainDetails.results);
	}
	const chainDetails = rawChainDetails ? compactForegroundDetails(rawChainDetails) : undefined;
	if (chainDetails) rememberForegroundRun(deps.state, { runId, mode: "chain", cwd: effectiveCwd, results: chainDetails.results });
	const intercomReceipt = chainDetails && !chainDetails.results.some((result) => result.interrupted || result.detached)
		? await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "chain",
			details: chainDetails,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		})
		: null;
	if (intercomReceipt) {
		return {
			...chainResult,
			content: [{ type: "text", text: intercomReceipt.text }],
			details: intercomReceipt.details,
		};
	}

	return chainDetails ? { ...chainResult, details: chainDetails } : chainResult;
}
