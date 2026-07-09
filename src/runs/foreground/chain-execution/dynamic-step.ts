/** Dynamic fanout step — extracted step branch of executeChain (chain cluster split).
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

export async function executeDynamicStep(c: ChainStepEnv, loop: ChainLoopState, step: ChainStep, stepIndex: number, stepTemplates: string | string[]): Promise<ChainExecutionResult | undefined> {
	if (!isDynamicParallelStep(step)) return undefined;
	const { params, chainSteps, agents, ctx, intercomEvents, signal, runId, cwd, shareEnabled, sessionDirForIndex, sessionFileForIndex, sessionFileForTask, thinkingOverrideForTask, artifactsDir, artifactConfig, includeProgress, onUpdate, onControlEvent, controlConfig, onDetachedExit, childIntercomTarget, orchestratorIntercomTarget, foregroundControl, modelScope, chainSkills, results, outputs, dynamicChildren, dynamicGroupStatuses, allProgress, allArtifactPaths, chainAgents, totalSteps, makeDetailsInput, originalTask, chainDir, templates, tuiBehaviorOverrides, availableModels, deadlineAt, globalSemaphore } = c;

			const dynamicStartIndex = loop.globalTaskIndex;
			const reservedDynamicItems = step.expand.maxItems ?? params.dynamicFanoutMaxItems ?? 0;
			let materialized: ReturnType<typeof materializeDynamicParallelStep>;
			try {
				materialized = materializeDynamicParallelStep(step, outputs, stepIndex, { maxItems: params.dynamicFanoutMaxItems });
			} catch (error) {
				const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
				return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: loop.globalTaskIndex }));
			}

			dynamicChildren[stepIndex] = materialized.items.map((item, itemIndex) => ({
				agent: step.parallel.agent,
				label: materialized.parallel[itemIndex]?.label,
				flatIndex: loop.globalTaskIndex + itemIndex,
				itemKey: item.key,
				structured: Boolean(step.parallel.outputSchema),
			}));

			if (materialized.parallel.length === 0) {
				const collection: DynamicCollectedResult[] = [];
				try {
					validateDynamicCollection(step.collect.outputSchema, collection);
				} catch (error) {
					const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
					dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
					return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: loop.globalTaskIndex }));
				}
				outputs[step.collect.as] = {
					text: JSON.stringify(collection),
					structured: collection,
					agent: step.parallel.agent,
					stepIndex,
				};
				dynamicGroupStatuses[stepIndex] = { status: "completed" };
				if (step.acceptance !== undefined) {
					const effectiveGroupAcceptance = resolveEffectiveAcceptance({
						explicit: step.acceptance,
						agentName: step.parallel.agent,
						task: step.parallel.task ?? originalTask,
						mode: "chain",
						dynamicGroup: true,
					});
					const groupAcceptance = await evaluateAcceptance({
						acceptance: effectiveGroupAcceptance,
						output: "",
						report: aggregateAcceptanceReport({
							results: [],
							notes: "Dynamic fanout produced 0 results.",
						}),
						cwd: cwd ?? ctx.cwd,
					});
					dynamicGroupStatuses[stepIndex].acceptance = groupAcceptance;
					const groupAcceptanceFailure = acceptanceFailureMessage(groupAcceptance);
					if (groupAcceptanceFailure) {
						dynamicGroupStatuses[stepIndex] = { status: "failed", error: groupAcceptanceFailure, acceptance: groupAcceptance };
						return buildChainExecutionErrorResult(groupAcceptanceFailure, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: loop.globalTaskIndex }));
					}
				}
				loop.prev = "Dynamic fanout produced 0 results.";
				loop.globalTaskIndex = dynamicStartIndex + reservedDynamicItems;
				return undefined;
			}

			const dynamicParallelStep: ParallelStep = {
				parallel: materialized.parallel,
				concurrency: step.concurrency,
				failFast: step.failFast,
			};
			const parallelTemplates = materialized.parallel.map((task) => task.task ?? "{previous}");
			const parallelBehaviors = resolveParallelBehaviors(dynamicParallelStep.parallel, agents, stepIndex, chainSkills)
				.map((behavior, taskIndex) => suppressProgressForReadOnlyTask(behavior, parallelTemplates[taskIndex] ?? dynamicParallelStep.parallel[taskIndex]?.task, originalTask));

			for (let taskIndex = 0; taskIndex < dynamicParallelStep.parallel.length; taskIndex++) {
				const behavior = parallelBehaviors[taskIndex]!;
				const outputPath = typeof behavior.output === "string"
					? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output))
					: undefined;
				const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Dynamic chain step ${stepIndex + 1} item ${taskIndex + 1} (${dynamicParallelStep.parallel[taskIndex]!.agent})`);
				if (validationError) {
					dynamicGroupStatuses[stepIndex] = { status: "failed", error: validationError };
					return buildChainExecutionErrorResult(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: loop.globalTaskIndex + taskIndex }));
				}
			}

			loop.progressCreated = ensureParallelProgressFile(chainDir, loop.progressCreated, parallelBehaviors);
			createParallelDirs(chainDir, stepIndex, dynamicParallelStep.parallel.length, dynamicParallelStep.parallel.map((task) => task.agent));
			const parallelResults = await runParallelChainTasks({
				step: dynamicParallelStep,
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
				maxSubagentDepth: params.maxSubagentDepth,
				timeoutMs: params.timeoutMs,
				deadlineAt,
				turnBudget: params.turnBudget,
				onDetachedExit,
				toolBudget: params.toolBudget,
				configToolBudget: params.configToolBudget,
				globalSemaphore,
			});
			loop.globalTaskIndex = dynamicStartIndex + reservedDynamicItems;

			for (const result of parallelResults) {
				results.push(result);
				if (result.progress) allProgress.push(result.progress);
				if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
			}
			const collected = collectDynamicResults(step, materialized.items, parallelResults);
			const interruptedIndexInStep = parallelResults.findIndex((result) => result.interrupted);
			const interrupted = interruptedIndexInStep >= 0 ? parallelResults[interruptedIndexInStep] : undefined;
			if (interrupted) {
				return {
					content: [{ type: "text", text: `Chain paused after interrupt at step ${stepIndex + 1} (${interrupted.agent}). Waiting for explicit next action.` }],
					details: buildChainExecutionDetails(makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: dynamicStartIndex + interruptedIndexInStep,
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
						currentFlatIndex: dynamicStartIndex + detachedIndexInStep,
					})),
				};
			}
			const failures = parallelResults
				.map((result, originalIndex) => ({ ...result, originalIndex }))
				.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
			if (failures.length > 0) {
				const failureSummary = failures
					.map((failure) => `- Item ${failure.originalIndex + 1} (${failure.agent}, key ${materialized.items[failure.originalIndex]?.key ?? failure.originalIndex}): ${failure.error || "failed"}`)
					.join("\n");
				const errorMsg = `Dynamic step ${stepIndex + 1} failed:\n${failureSummary}`;
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: errorMsg };
				const summary = buildChainSummary(chainSteps, results, chainDir, "failed", {
					index: stepIndex,
					error: errorMsg,
				});
				return {
					content: [{ type: "text", text: summary }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: dynamicStartIndex + failures[0]!.originalIndex,
					})),
				};
			}
			try {
				validateDynamicCollection(step.collect.outputSchema, collected);
			} catch (error) {
				const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
				return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: dynamicStartIndex }));
			}
			outputs[step.collect.as] = {
				text: JSON.stringify(collected),
				structured: collected,
				agent: step.parallel.agent,
				stepIndex,
			};
			dynamicGroupStatuses[stepIndex] = { status: "completed" };
			const effectiveGroupAcceptance = resolveEffectiveAcceptance({
				explicit: step.acceptance,
				agentName: step.parallel.agent,
				task: step.parallel.task ?? originalTask,
				mode: "chain",
				dynamicGroup: true,
			});
			const groupAcceptance = await evaluateAcceptance({
				acceptance: effectiveGroupAcceptance,
				output: "",
				report: aggregateAcceptanceReport({
					results: parallelResults,
					notes: `Dynamic fanout collected ${collected.length} result(s) into ${step.collect.as}.`,
				}),
				cwd: cwd ?? ctx.cwd,
			});
			dynamicGroupStatuses[stepIndex].acceptance = groupAcceptance;
			const groupAcceptanceFailure = acceptanceFailureMessage(groupAcceptance);
			if (groupAcceptanceFailure) {
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: groupAcceptanceFailure, acceptance: groupAcceptance };
				return buildChainExecutionErrorResult(groupAcceptanceFailure, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: loop.globalTaskIndex - dynamicParallelStep.parallel.length }));
			}
			const taskResults: ParallelTaskResult[] = parallelResults.map((result, i) => ({
				agent: result.agent,
				taskIndex: i,
				output: getSingleResultOutput(result),
				exitCode: result.exitCode,
				error: result.error,
				timedOut: result.timedOut,
			}));
			loop.prev = aggregateParallelOutputs(taskResults, (i, agent) => `=== Dynamic Item ${i + 1} (${agent}, key ${materialized.items[i]?.key ?? i}) ===`);
}
