/** Parallel step — extracted step branch of executeChain (chain cluster split).
 * Behavior is identical to the original inline branch; only the loop-carried
 * primitives (prev/globalTaskIndex/progressCreated) are threaded via `loop`. */

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
import type { ChainExecutionResult } from "./types.ts";
import type { ChainStepEnv, ChainLoopState } from "./step-context.ts";
import { buildChainExecutionDetails, buildChainExecutionErrorResult, ensureParallelProgressFile, appendParallelWorktreeSummary, resolveChainToolBudget, runParallelChainTasks } from "./helpers.ts";

export async function executeParallelStep(c: ChainStepEnv, loop: ChainLoopState, step: ChainStep, stepIndex: number, stepTemplates: string | string[]): Promise<ChainExecutionResult | undefined> {
	if (!isParallelStep(step)) return undefined;
	const { params, chainSteps, agents, ctx, intercomEvents, signal, runId, cwd, shareEnabled, sessionDirForIndex, sessionFileForIndex, sessionFileForTask, thinkingOverrideForTask, artifactsDir, artifactConfig, includeProgress, onUpdate, onControlEvent, controlConfig, onDetachedExit, childIntercomTarget, orchestratorIntercomTarget, foregroundControl, modelScope, chainSkills, results, outputs, dynamicChildren, dynamicGroupStatuses, allProgress, allArtifactPaths, chainAgents, totalSteps, makeDetailsInput, originalTask, chainDir, templates, tuiBehaviorOverrides, availableModels, deadlineAt, globalSemaphore } = c;

			const parallelTemplates = stepTemplates as string[];
			const parallelCwd = resolveChildCwd(cwd ?? ctx.cwd, step.cwd);
			let worktreeSetup: WorktreeSetup | undefined;
			if (step.worktree) {
				const worktreeTaskCwdConflict = findWorktreeTaskCwdConflict(step.parallel, parallelCwd);
				if (worktreeTaskCwdConflict) {
					return buildChainExecutionErrorResult(
						`parallel chain step ${stepIndex + 1}: ${formatWorktreeTaskCwdConflict(worktreeTaskCwdConflict, parallelCwd)}`,
						makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: loop.globalTaskIndex }),
					);
				}
				try {
					worktreeSetup = createWorktrees(parallelCwd, `${runId}-s${stepIndex}`, step.parallel.length, {
						agents: step.parallel.map((task) => task.agent),
						setupHook: params.worktreeSetupHook
							? { hookPath: params.worktreeSetupHook, timeoutMs: params.worktreeSetupHookTimeoutMs }
							: undefined,
						baseDir: params.worktreeBaseDir,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: loop.globalTaskIndex }));
				}
			}

			try {
				const agentNames = step.parallel.map((task) => task.agent);
				const parallelBehaviors = resolveParallelBehaviors(step.parallel, agents, stepIndex, chainSkills)
					.map((behavior, taskIndex) => suppressProgressForReadOnlyTask(behavior, parallelTemplates[taskIndex] ?? step.parallel[taskIndex]?.task, originalTask));
				for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
					const behavior = parallelBehaviors[taskIndex]!;
					const outputPath = typeof behavior.output === "string"
						? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output))
						: undefined;
					const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Parallel chain step ${stepIndex + 1} task ${taskIndex + 1} (${step.parallel[taskIndex]!.agent})`);
					if (validationError) return buildChainExecutionErrorResult(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: loop.globalTaskIndex + taskIndex }));
				}
				loop.progressCreated = ensureParallelProgressFile(chainDir, loop.progressCreated, parallelBehaviors);
				createParallelDirs(chainDir, stepIndex, step.parallel.length, agentNames);

				const parallelResults = await runParallelChainTasks({
					step,
					parallelTemplates,
					parallelBehaviors,
					agents,
					stepIndex,
					availableModels,
					modelScope,
					chainDir,
					prev: loop.prev,
					originalTask,
					ctx,
					intercomEvents,
					cwd,
					runId,
					globalTaskIndex: loop.globalTaskIndex,
					sessionDirForIndex,
					sessionFileForIndex,
					sessionFileForTask,
					thinkingOverrideForTask,
					shareEnabled,
					artifactConfig,
					artifactsDir,
					signal,
					onUpdate,
					results,
					allProgress,
					outputs,
					chainAgents,
					chainSteps,
					totalSteps,
					dynamicChildren,
					dynamicGroupStatuses,
					controlConfig,
					onControlEvent,
					childIntercomTarget,
					orchestratorIntercomTarget,
					foregroundControl,
					nestedRoute: params.nestedRoute,
					worktreeSetup,
					maxSubagentDepth: params.maxSubagentDepth,
					timeoutMs: params.timeoutMs,
					deadlineAt,
					turnBudget: params.turnBudget,
					onDetachedExit,
					toolBudget: params.toolBudget,
					configToolBudget: params.configToolBudget,
					globalSemaphore,
				});
				loop.globalTaskIndex += step.parallel.length;

				for (const result of parallelResults) {
					results.push(result);
					if (result.progress) allProgress.push(result.progress);
					if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
				}
				const interruptedIndexInStep = parallelResults.findIndex((result) => result.interrupted);
				const interrupted = interruptedIndexInStep >= 0 ? parallelResults[interruptedIndexInStep] : undefined;
				if (interrupted) {
					return {
						content: [{ type: "text", text: `Chain paused after interrupt at step ${stepIndex + 1} (${interrupted.agent}). Waiting for explicit next action.` }],
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: loop.globalTaskIndex - step.parallel.length + interruptedIndexInStep,
						})),
					};
				}
				const detachedIndexInStep = parallelResults.findIndex((result) => result.detached);
				const detached = detachedIndexInStep >= 0 ? parallelResults[detachedIndexInStep] : undefined;
				if (detached) {
					return {
						content: [{ type: "text", text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${detached.agent}). Reply to the supervisor request first. Status: subagent({ action: "status", id: "${runId}" }). After the child exits, start a fresh follow-up if needed.` }],
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: loop.globalTaskIndex - step.parallel.length + detachedIndexInStep,
						})),
					};
				}

				const failures = parallelResults
					.map((result, originalIndex) => ({ ...result, originalIndex }))
					.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
				if (failures.length > 0) {
					const failureSummary = failures
						.map((failure) => `- Task ${failure.originalIndex + 1} (${failure.agent}): ${failure.error || "failed"}`)
						.join("\n");
					const errorMsg = `Parallel step ${stepIndex + 1} failed:\n${failureSummary}`;
					const summary = buildChainSummary(chainSteps, results, chainDir, "failed", {
						index: stepIndex,
						error: errorMsg,
					});
					return {
						content: [{ type: "text", text: summary }],
						isError: true,
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: loop.globalTaskIndex - step.parallel.length + failures[0]!.originalIndex,
						})),
					};
				}

				for (let taskIndex = 0; taskIndex < parallelResults.length; taskIndex++) {
					const outputName = step.parallel[taskIndex]?.as;
					if (outputName) outputs[outputName] = outputEntryFromResult(parallelResults[taskIndex]!, stepIndex);
				}

				const taskResults: ParallelTaskResult[] = parallelResults.map((result, i) => {
					const outputTarget = parallelBehaviors[i]?.output;
					const outputTargetPath = typeof outputTarget === "string"
						? (path.isAbsolute(outputTarget) ? outputTarget : path.join(chainDir, outputTarget))
						: undefined;
					return {
						agent: result.agent,
						taskIndex: i,
						output: getSingleResultOutput(result),
						exitCode: result.exitCode,
						error: result.error,
						timedOut: result.timedOut,
						outputTargetPath,
						outputTargetExists: outputTargetPath ? fs.existsSync(outputTargetPath) : undefined,
					};
				});
				loop.prev = aggregateParallelOutputs(taskResults);
				loop.prev = appendParallelWorktreeSummary(
				loop.prev,
					worktreeSetup,
					path.join(chainDir, "worktree-diffs", `step-${stepIndex}`),
					agentNames,
				);
			} finally {
				if (worktreeSetup) cleanupWorktrees(worktreeSetup);
			}
}
