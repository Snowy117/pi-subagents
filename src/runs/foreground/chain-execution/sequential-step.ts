/** Sequential step — extracted step branch of executeChain (chain cluster split).
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

export async function executeSequentialStep(c: ChainStepEnv, loop: ChainLoopState, step: ChainStep, stepIndex: number, stepTemplates: string | string[]): Promise<ChainExecutionResult | undefined> {
	const { params, chainSteps, agents, ctx, intercomEvents, signal, runId, cwd, shareEnabled, sessionDirForIndex, sessionFileForIndex, sessionFileForTask, thinkingOverrideForTask, artifactsDir, artifactConfig, includeProgress, onUpdate, onControlEvent, controlConfig, onDetachedExit, childIntercomTarget, orchestratorIntercomTarget, foregroundControl, modelScope, chainSkills, results, outputs, dynamicChildren, dynamicGroupStatuses, allProgress, allArtifactPaths, chainAgents, totalSteps, makeDetailsInput, originalTask, chainDir, templates, tuiBehaviorOverrides, availableModels, deadlineAt, globalSemaphore } = c;

			const seqStep = step as SequentialStep;
			const stepTemplate = stepTemplates as string;

			const agentConfig = agents.find((a) => a.name === seqStep.agent);
			if (!agentConfig) {
				removeChainDir(chainDir);
				return {
					content: [{ type: "text", text: `Unknown agent: ${seqStep.agent}` }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: loop.globalTaskIndex })),
				};
			}

			const tuiOverride = tuiBehaviorOverrides?.[stepIndex];
			const stepOverride: StepOverrides = {
				output: tuiOverride?.output !== undefined ? tuiOverride.output : seqStep.output,
				outputMode: seqStep.outputMode,
				reads: tuiOverride?.reads !== undefined ? tuiOverride.reads : seqStep.reads,
				progress: tuiOverride?.progress !== undefined ? tuiOverride.progress : seqStep.progress,
				skills:
					tuiOverride?.skills !== undefined
						? tuiOverride.skills
						: normalizeSkillInput(seqStep.skill),
			};
			const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agentConfig, stepOverride, chainSkills), stepTemplate, originalTask);

			const isFirstProgress = behavior.progress && !loop.progressCreated;
			if (isFirstProgress) {
				loop.progressCreated = true;
			}

			const templateHasPrevious = stepTemplate.includes("{previous}");
			const { prefix, suffix } = buildChainInstructions(
				behavior,
				chainDir,
				isFirstProgress,
				templateHasPrevious ? undefined : loop.prev,
			);

			let stepTask = resolveOutputReferences(stepTemplate, outputs);
			stepTask = stepTask.replace(/\{task\}/g, originalTask);
			stepTask = stepTask.replace(/\{previous\}/g, loop.prev);
			stepTask = stepTask.replace(/\{chain_dir\}/g, chainDir);
			const cleanTask = stepTask;
			stepTask = prefix + stepTask + suffix;

			const explicitStepModel = tuiOverride?.model ?? seqStep.model;
			const effectiveModel = resolveSubagentModelOverride(
				explicitStepModel ?? agentConfig.model,
				ctx.model,
				availableModels,
				ctx.model?.provider,
				{ scope: modelScope, source: explicitStepModel ? "explicit" : "inherited" },
			);

			const outputPath = typeof behavior.output === "string"
				? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output))
				: undefined;
			const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Chain step ${stepIndex + 1} (${seqStep.agent})`);
			if (validationError) {
				return buildChainExecutionErrorResult(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: loop.globalTaskIndex }));
			}
			const maxSubagentDepth = resolveChildMaxSubagentDepth(params.maxSubagentDepth, agentConfig.maxSubagentDepth);
			const childIndex = loop.globalTaskIndex;
			const interruptController = new AbortController();
			if (foregroundControl) {
				foregroundControl.currentAgent = seqStep.agent;
				foregroundControl.currentIndex = childIndex;
				foregroundControl.currentActivityState = undefined;
				foregroundControl.updatedAt = Date.now();
				foregroundControl.interrupt = () => {
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					foregroundControl.currentActivityState = undefined;
					foregroundControl.updatedAt = Date.now();
					return true;
				};
			}

			const structuredRuntime = seqStep.outputSchema
				? createStructuredOutputRuntime(seqStep.outputSchema, path.join(chainDir, "structured-output"))
				: undefined;
			const toolBudget = resolveChainToolBudget({ stepBudget: seqStep.toolBudget, runBudget: params.toolBudget, agentBudget: agentConfig?.toolBudget, configBudget: params.configToolBudget });
			if (toolBudget.error) return buildChainExecutionErrorResult(toolBudget.error, {
				results,
				includeProgress,
				allProgress,
				allArtifactPaths,
				artifactsDir: params.artifactsDir,
				chainAgents,
				chainSteps,
				totalSteps,
				currentStepIndex: stepIndex,
				runId: params.runId,
				outputs,
				currentFlatIndex: loop.globalTaskIndex,
				dynamicChildren,
				dynamicGroupStatuses,
			});
			const r = await runSync(ctx.cwd, agents, seqStep.agent, stepTask, {
				parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
				cwd: resolveChildCwd(cwd ?? ctx.cwd, seqStep.cwd),
				signal,
				interruptSignal: interruptController.signal,
				allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
				intercomEvents,
				runId,
				index: childIndex,
				sessionDir: sessionDirForIndex(childIndex),
				sessionFile: sessionFileForTask?.(seqStep.agent, childIndex)
					?? sessionFileForIndex?.(childIndex),
				thinkingOverride: thinkingOverrideForTask?.(seqStep.agent, childIndex),
				share: shareEnabled,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				outputPath,
				outputMode: behavior.outputMode,
				maxSubagentDepth,
				controlConfig,
				onControlEvent,
				intercomSessionName: childIntercomTarget?.(seqStep.agent, childIndex),
				orchestratorIntercomTarget,
				nestedRoute: params.nestedRoute,
				modelOverride: effectiveModel,
				availableModels,
				preferredModelProvider: ctx.model?.provider,
				modelScope,
				skills: behavior.skills === false ? [] : behavior.skills,
				structuredOutput: structuredRuntime,
				acceptance: seqStep.acceptance,
				acceptanceContext: { mode: "chain" },
				timeoutMs: params.timeoutMs,
				deadlineAt,
				turnBudget: params.turnBudget,
				onDetachedExit: onDetachedExit
					? (result) => onDetachedExit(childIndex, result)
					: undefined,
				toolBudget: toolBudget.toolBudget,
				onUpdate: onUpdate
					? (p) => {
						const stepResults = p.details?.results || [];
						const stepProgress = p.details?.progress || [];
						if (foregroundControl && stepProgress.length > 0) {
							const current = stepProgress[0];
							foregroundControl.currentAgent = seqStep.agent;
							foregroundControl.currentIndex = childIndex;
							foregroundControl.currentActivityState = current?.activityState;
							foregroundControl.lastActivityAt = current?.lastActivityAt;
							foregroundControl.currentTool = current?.currentTool;
							foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
							foregroundControl.currentPath = current?.currentPath;
							foregroundControl.turnCount = current?.turnCount;
							foregroundControl.tokens = current?.tokens;
							foregroundControl.toolCount = current?.toolCount;
							foregroundControl.updatedAt = Date.now();
						}
						onUpdate({
							...p,
							details: {
								mode: "chain",
								results: results.concat(stepResults),
								progress: allProgress.concat(stepProgress),
								controlEvents: p.details?.controlEvents,
								chainAgents,
								totalSteps,
								currentStepIndex: stepIndex,
								outputs,
								workflowGraph: buildWorkflowGraphSnapshot({
									runId,
									mode: "chain",
									steps: chainSteps,
									results: results.concat(stepResults),
									currentStepIndex: stepIndex,
									currentFlatIndex: childIndex,
									dynamicChildren,
									dynamicGroupStatuses,
								}),
							},
						});
					}
					: undefined,
			});
			if (foregroundControl?.currentIndex === childIndex) {
				foregroundControl.interrupt = undefined;
				foregroundControl.updatedAt = Date.now();
			}
			recordRun(seqStep.agent, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

			loop.globalTaskIndex++;
			results.push(r);
			if (r.progress) allProgress.push(r.progress);
			if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

			if (r.interrupted) {
				return {
					content: [{ type: "text", text: `Chain paused after interrupt at step ${stepIndex + 1} (${r.agent}). Waiting for explicit next action.` }],
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: childIndex })),
				};
			}
			if (r.detached) {
				return {
					content: [{ type: "text", text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${r.agent}). Reply to the supervisor request first. Status: subagent({ action: "status", id: "${runId}" }). After the child exits, start a fresh follow-up if needed.` }],
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: childIndex })),
				};
			}

			if (r.exitCode !== 0) {
				const summary = buildChainSummary(chainSteps, results, chainDir, "failed", {
					index: stepIndex,
					error: r.error || "Chain failed",
				});
				return {
					content: [{ type: "text", text: summary }],
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: childIndex })),
					isError: true,
				};
			}

			if (behavior.output) {
				try {
					const expectedPath = path.isAbsolute(behavior.output)
						? behavior.output
						: path.join(chainDir, behavior.output);
					if (!fs.existsSync(expectedPath)) {
						const dirFiles = fs.readdirSync(chainDir);
						const mdFiles = dirFiles.filter((file) => file.endsWith(".md") && file !== "progress.md");
						const warning = mdFiles.length > 0
							? `Agent wrote to different file(s): ${mdFiles.join(", ")} instead of ${behavior.output}`
							: `Agent did not create expected output file: ${behavior.output}`;
						r.error = r.error ? `${r.error}\n${warning}` : warning;
					}
				} catch {
					// Ignore validation errors; this diagnostic should not mask successful chain output.
				}
			}

			if (seqStep.as) outputs[seqStep.as] = outputEntryFromResult(r, stepIndex);
			loop.prev = getSingleResultOutput(r);
}
