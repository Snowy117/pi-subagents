/** Chain-execution helper functions (details builders + parallel task runner). */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../../agents/agents.ts";
import { ChainClarifyComponent, type ChainClarifyResult, type BehaviorOverride } from "../chain-clarify.ts";
import { toModelInfo, type ModelInfo } from "../../../shared/model-info.ts";
import { resolveChainTemplates, createChainDir, removeChainDir, resolveStepBehavior, resolveParallelBehaviors, buildChainInstructions, writeInitialProgressFile, createParallelDirs, suppressProgressForReadOnlyTask, aggregateParallelOutputs, isDynamicParallelStep, isParallelStep, type StepOverrides, type ChainStep, type ParallelStep, type SequentialStep, type ParallelTaskResult, type ResolvedStepBehavior, type ResolvedTemplates, } from "../../../shared/settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../../agents/skills.ts";
import { INTERCOM_BRIDGE_MARKER } from "../../../intercom/intercom-bridge.ts";
import { runSync } from "../execution.ts";
import { buildChainSummary } from "../../../shared/formatters.ts";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, resolveChildCwd, sumResultsCost, sumResultsUsage } from "../../../shared/utils.ts";
import { DEFAULT_GLOBAL_CONCURRENCY_LIMIT, Semaphore } from "../../shared/parallel-utils.ts";
import { recordRun } from "../../shared/run-history.ts";
import { cleanupWorktrees, createWorktrees, diffWorktrees, findWorktreeTaskCwdConflict, formatWorktreeDiffSummary, formatWorktreeTaskCwdConflict, type WorktreeSetup, } from "../../shared/worktree.ts";
import { type ActivityState, type AgentProgress, type ArtifactConfig, type ArtifactPaths, type ControlEvent, type Details, type IntercomEventBus, type NestedRouteInfo, type ResolvedControlConfig, type ResolvedTurnBudget, type ResolvedToolBudget, type SingleResult, type ToolBudgetConfig, MAX_CONCURRENCY, resolveChildMaxSubagentDepth, } from "../../../shared/types.ts";
import { resolveSubagentModelOverride } from "../../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../../shared/model-scope.ts";
import { validateFileOnlyOutputMode } from "../../shared/single-output.ts";
import { buildWorkflowGraphSnapshot } from "../../shared/workflow-graph.ts";
import { ChainOutputValidationError, outputEntryFromResult, resolveOutputReferences, validateChainOutputBindings } from "../../shared/chain-outputs.ts";
import { createStructuredOutputRuntime } from "../../shared/structured-output.ts";
import { collectDynamicResults, DynamicFanoutError, materializeDynamicParallelStep, validateDynamicCollection, type DynamicCollectedResult } from "../../shared/dynamic-fanout.ts";
import { acceptanceFailureMessage, aggregateAcceptanceReport, evaluateAcceptance, resolveEffectiveAcceptance } from "../../shared/acceptance.ts";
import type { ChainOutputMap } from "../../../shared/types.ts";
import { validateToolBudgetConfig } from "../../shared/tool-budget.ts";
import type { ChainExecutionDetailsInput, ChainExecutionResult, ParallelChainRunInput } from "./types.ts";

export function buildChainExecutionDetails(input: ChainExecutionDetailsInput): Details {
	return compactForegroundDetails({
		mode: "chain",
		results: input.results,
		progress: input.includeProgress ? input.allProgress : undefined,
		artifacts: input.allArtifactPaths.length ? { dir: input.artifactsDir, files: input.allArtifactPaths } : undefined,
		chainAgents: input.chainAgents,
		totalSteps: input.totalSteps,
		currentStepIndex: input.currentStepIndex,
		outputs: input.outputs,
		totalChildUsage: sumResultsUsage(input.results),
		totalCost: sumResultsCost(input.results),
		workflowGraph: buildWorkflowGraphSnapshot({
			runId: input.runId,
			mode: "chain",
			steps: input.chainSteps,
			results: input.results,
			currentStepIndex: input.currentStepIndex,
			currentFlatIndex: input.currentFlatIndex,
			dynamicChildren: input.dynamicChildren,
			dynamicGroupStatuses: input.dynamicGroupStatuses,
		}),
	});
}

export function buildChainExecutionErrorResult(message: string, input: ChainExecutionDetailsInput): ChainExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: buildChainExecutionDetails(input),
	};
}

export function ensureParallelProgressFile(
	chainDir: string,
	progressCreated: boolean,
	parallelBehaviors: ResolvedStepBehavior[],
): boolean {
	if (progressCreated || !parallelBehaviors.some((behavior) => behavior.progress)) {
		return progressCreated;
	}
	writeInitialProgressFile(chainDir);
	return true;
}

export function appendParallelWorktreeSummary(
	output: string,
	worktreeSetup: WorktreeSetup | undefined,
	diffsDir: string,
	agents: string[],
): string {
	if (!worktreeSetup) return output;
	const diffs = diffWorktrees(worktreeSetup, agents, diffsDir);
	const diffSummary = formatWorktreeDiffSummary(diffs);
	if (!diffSummary) return output;
	return `${output}\n\n${diffSummary}`;
}

export function resolveChainToolBudget(input: { stepBudget?: ToolBudgetConfig; runBudget?: ResolvedToolBudget; agentBudget?: ToolBudgetConfig; configBudget?: ToolBudgetConfig }): { toolBudget?: ResolvedToolBudget; error?: string } {
	if (input.stepBudget !== undefined) {
		const resolved = validateToolBudgetConfig(input.stepBudget, "toolBudget");
		return { toolBudget: resolved.budget, error: resolved.error };
	}
	if (input.runBudget !== undefined) return { toolBudget: input.runBudget };
	if (input.agentBudget !== undefined) {
		const resolved = validateToolBudgetConfig(input.agentBudget, "agent.toolBudget");
		return { toolBudget: resolved.budget, error: resolved.error };
	}
	const resolved = validateToolBudgetConfig(input.configBudget, "config.toolBudget");
	return { toolBudget: resolved.budget, error: resolved.error };
}

export async function runParallelChainTasks(input: ParallelChainRunInput): Promise<SingleResult[]> {
	const concurrency = input.step.concurrency ?? MAX_CONCURRENCY;
	const failFast = input.step.failFast ?? false;
	let aborted = false;

	const parallelResults = await mapConcurrent(
		input.step.parallel,
		concurrency,
		async (task, taskIndex) => {
			if (aborted && failFast) {
				return {
					agent: task.agent,
					task: "(skipped)",
					exitCode: -1,
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					error: "Skipped due to fail-fast",
				} as SingleResult;
			}

			const taskTemplate = input.parallelTemplates[taskIndex] ?? "{previous}";
			const behavior = suppressProgressForReadOnlyTask(input.parallelBehaviors[taskIndex]!, taskTemplate, input.originalTask);
			const templateHasPrevious = taskTemplate.includes("{previous}");
			const { prefix, suffix } = buildChainInstructions(
				behavior,
				input.chainDir,
				false,
				templateHasPrevious ? undefined : input.prev,
			);

			let taskStr = resolveOutputReferences(taskTemplate, input.outputs);
			taskStr = taskStr.replace(/\{task\}/g, input.originalTask);
			taskStr = taskStr.replace(/\{previous\}/g, input.prev);
			taskStr = taskStr.replace(/\{chain_dir\}/g, input.chainDir);
			const cleanTask = taskStr;
			taskStr = prefix + taskStr + suffix;

			const taskAgentConfig = input.agents.find((agent) => agent.name === task.agent);
			const effectiveModel = resolveSubagentModelOverride(
				task.model ?? taskAgentConfig?.model,
				input.ctx.model,
				input.availableModels,
				input.ctx.model?.provider,
				{ scope: input.modelScope, source: task.model ? "explicit" : "inherited" },
			);
			const maxSubagentDepth = resolveChildMaxSubagentDepth(input.maxSubagentDepth, taskAgentConfig?.maxSubagentDepth);
			const toolBudget = resolveChainToolBudget({ stepBudget: task.toolBudget, runBudget: input.toolBudget, agentBudget: taskAgentConfig?.toolBudget, configBudget: input.configToolBudget });
			if (toolBudget.error) throw new Error(toolBudget.error);

			const taskCwd = input.worktreeSetup
				? input.worktreeSetup.worktrees[taskIndex]!.agentCwd
				: resolveChildCwd(input.cwd ?? input.ctx.cwd, task.cwd);

			const outputPath = typeof behavior.output === "string"
				? (path.isAbsolute(behavior.output) ? behavior.output : path.join(input.chainDir, behavior.output))
				: undefined;
			const interruptController = new AbortController();
			if (input.foregroundControl) {
				input.foregroundControl.currentAgent = task.agent;
				input.foregroundControl.currentIndex = input.globalTaskIndex + taskIndex;
				input.foregroundControl.currentActivityState = undefined;
				input.foregroundControl.updatedAt = Date.now();
				input.foregroundControl.interrupt = () => {
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					input.foregroundControl!.currentActivityState = undefined;
					input.foregroundControl!.updatedAt = Date.now();
					return true;
				};
			}

			const structuredRuntime = task.outputSchema
				? createStructuredOutputRuntime(task.outputSchema, path.join(input.chainDir, "structured-output"))
				: undefined;
			const result = await runSync(input.ctx.cwd, input.agents, task.agent, taskStr, {
				parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
				cwd: taskCwd,
				signal: input.signal,
				interruptSignal: interruptController.signal,
				allowIntercomDetach: taskAgentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
				intercomEvents: input.intercomEvents,
				runId: input.runId,
				index: input.globalTaskIndex + taskIndex,
				sessionDir: input.sessionDirForIndex(input.globalTaskIndex + taskIndex),
				sessionFile: input.sessionFileForTask?.(task.agent, input.globalTaskIndex + taskIndex)
					?? input.sessionFileForIndex?.(input.globalTaskIndex + taskIndex),
				thinkingOverride: input.thinkingOverrideForTask?.(task.agent, input.globalTaskIndex + taskIndex),
				share: input.shareEnabled,
				artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
				artifactConfig: input.artifactConfig,
				outputPath,
				outputMode: behavior.outputMode,
				maxSubagentDepth,
				controlConfig: input.controlConfig,
				onControlEvent: input.onControlEvent,
				intercomSessionName: input.childIntercomTarget?.(task.agent, input.globalTaskIndex + taskIndex),
				orchestratorIntercomTarget: input.orchestratorIntercomTarget,
				nestedRoute: input.nestedRoute,
				modelOverride: effectiveModel,
				availableModels: input.availableModels,
				preferredModelProvider: input.ctx.model?.provider,
				modelScope: input.modelScope,
				skills: behavior.skills === false ? [] : behavior.skills,
				structuredOutput: structuredRuntime,
				acceptance: task.acceptance,
				acceptanceContext: { mode: "chain" },
				timeoutMs: input.timeoutMs,
				deadlineAt: input.deadlineAt,
				turnBudget: input.turnBudget,
				onDetachedExit: input.onDetachedExit
					? (result) => input.onDetachedExit?.(input.globalTaskIndex + taskIndex, result)
					: undefined,
				toolBudget: toolBudget.toolBudget,
				onUpdate: input.onUpdate
					? (progressUpdate) => {
						const stepResults = progressUpdate.details?.results || [];
						const stepProgress = progressUpdate.details?.progress || [];
						if (input.foregroundControl && stepProgress.length > 0) {
							const current = stepProgress[0];
							input.foregroundControl.currentAgent = task.agent;
							input.foregroundControl.currentIndex = input.globalTaskIndex + taskIndex;
							input.foregroundControl.currentActivityState = current?.activityState;
							input.foregroundControl.lastActivityAt = current?.lastActivityAt;
							input.foregroundControl.currentTool = current?.currentTool;
							input.foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
							input.foregroundControl.currentPath = current?.currentPath;
							input.foregroundControl.turnCount = current?.turnCount;
							input.foregroundControl.tokens = current?.tokens;
							input.foregroundControl.toolCount = current?.toolCount;
							input.foregroundControl.updatedAt = Date.now();
						}
						input.onUpdate?.({
							...progressUpdate,
							details: {
								mode: "chain",
								results: input.results.concat(stepResults),
								progress: input.allProgress.concat(stepProgress),
								controlEvents: progressUpdate.details?.controlEvents,
								chainAgents: input.chainAgents,
								totalSteps: input.totalSteps,
								currentStepIndex: input.stepIndex,
								outputs: input.outputs,
								workflowGraph: buildWorkflowGraphSnapshot({
									runId: input.runId,
									mode: "chain",
									steps: input.chainSteps,
									results: input.results.concat(stepResults),
									currentStepIndex: input.stepIndex,
									currentFlatIndex: input.globalTaskIndex + taskIndex,
									dynamicChildren: input.dynamicChildren,
									dynamicGroupStatuses: input.dynamicGroupStatuses,
								}),
							},
						});
					}
					: undefined,
			});
			if (input.foregroundControl?.currentIndex === input.globalTaskIndex + taskIndex) {
				input.foregroundControl.interrupt = undefined;
				input.foregroundControl.updatedAt = Date.now();
			}

			if (result.exitCode !== 0 && failFast) {
				aborted = true;
			}
			recordRun(task.agent, cleanTask, result.exitCode, result.progressSummary?.durationMs ?? 0);
			return result;
		},
		input.globalSemaphore,
	);

	return parallelResults;
}
