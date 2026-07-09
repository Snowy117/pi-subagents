/** executeChain — orchestrates a chain of subagent steps. Step branches
 * (parallel / dynamic / sequential) are extracted into sibling modules; this
 * core owns setup, the optional clarify phase, and the step loop. */

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
import type { ChainExecutionDetailsInput, ChainExecutionParams, ChainExecutionResult } from "./types.ts";
import { buildChainExecutionDetails } from "./helpers.ts";
import type { ChainStepEnv, ChainLoopState } from "./step-context.ts";
import { executeParallelStep } from "./parallel-step.ts";
import { executeDynamicStep } from "./dynamic-step.ts";
import { executeSequentialStep } from "./sequential-step.ts";

export async function executeChain(params: ChainExecutionParams): Promise<ChainExecutionResult> {
	const {
		chain: chainSteps,
		agents,
		ctx,
		signal,
		runId,
		cwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		artifactsDir,
		artifactConfig,
		includeProgress,
		clarify,
		onUpdate,
		onControlEvent,
		controlConfig,
		onDetachedExit,
		childIntercomTarget,
		orchestratorIntercomTarget,
		foregroundControl,
		intercomEvents,
		chainSkills: chainSkillsParam,
		chainDir: chainDirBase,
		modelScope,
	} = params;
	const chainSkills = chainSkillsParam ?? [];

	const results: SingleResult[] = [];
	const outputs: ChainOutputMap = {};
	const dynamicChildren: ChainExecutionDetailsInput["dynamicChildren"] = {};
	const dynamicGroupStatuses: ChainExecutionDetailsInput["dynamicGroupStatuses"] = {};
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];

	const chainAgents: string[] = chainSteps.map((step) =>
		isParallelStep(step)
			? `[${step.parallel.map((t) => t.agent).join("+")}]`
			: isDynamicParallelStep(step)
				? `expand:${step.parallel.agent}`
			: (step as SequentialStep).agent,
	);
	const totalSteps = chainSteps.length;

	const makeDetailsInput = (overrides: Pick<Partial<ChainExecutionDetailsInput>, "currentStepIndex" | "currentFlatIndex"> = {}): ChainExecutionDetailsInput => ({
		results,
		...(includeProgress !== undefined ? { includeProgress } : {}),
		allProgress,
		allArtifactPaths,
		artifactsDir,
		chainAgents,
		chainSteps,
		totalSteps,
		runId,
		outputs,
		dynamicChildren,
		dynamicGroupStatuses,
		...overrides,
	});

	const firstStep = chainSteps[0]!;
	const originalTask = params.task
		?? (isParallelStep(firstStep)
			? firstStep.parallel[0]!.task!
			: isDynamicParallelStep(firstStep)
				? firstStep.parallel.task!
				: (firstStep as SequentialStep).task!);
	try {
		validateChainOutputBindings(chainSteps, { maxItems: params.dynamicFanoutMaxItems });
	} catch (error) {
		if (error instanceof ChainOutputValidationError) {
			return {
				content: [{ type: "text", text: error.message }],
				isError: true,
				details: buildChainExecutionDetails(makeDetailsInput()),
			};
		}
		throw error;
	}

	const chainDir = createChainDir(runId, chainDirBase);
	const hasParallelSteps = chainSteps.some((step) => isParallelStep(step) || isDynamicParallelStep(step));
	let templates: ResolvedTemplates = resolveChainTemplates(chainSteps);
	const shouldClarify = clarify === true && ctx.hasUI && !hasParallelSteps;
	let tuiBehaviorOverrides: (BehaviorOverride | undefined)[] | undefined;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const availableSkills = discoverAvailableSkills(cwd ?? ctx.cwd);

	if (shouldClarify) {
		const seqSteps = chainSteps as SequentialStep[];
		const agentConfigs: AgentConfig[] = [];
		for (const step of seqSteps) {
			const config = agents.find((a) => a.name === step.agent);
			if (!config) {
				removeChainDir(chainDir);
				return {
					content: [{ type: "text", text: `Unknown agent: ${step.agent}` }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: seqSteps.indexOf(step) })),
				};
			}
			agentConfigs.push(config);
		}

		const stepOverrides: StepOverrides[] = seqSteps.map((step) => ({
			output: step.output,
			outputMode: step.outputMode,
			reads: step.reads,
			progress: step.progress,
			skills: normalizeSkillInput(step.skill),
			model: step.model,
		}));

		const resolvedBehaviors = agentConfigs.map((config, i) =>
			resolveStepBehavior(config, stepOverrides[i]!, chainSkills),
		);
		const flatTemplates = templates as string[];

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui,
					theme,
					agentConfigs,
					flatTemplates,
					originalTask,
					chainDir,
					resolvedBehaviors,
					availableModels,
					ctx.model?.provider,
					availableSkills,
					done,
				),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" },
			},
		);

		if (!result || !result.confirmed) {
			removeChainDir(chainDir);
			return {
				content: [{ type: "text", text: "Chain cancelled" }],
				details: buildChainExecutionDetails(makeDetailsInput()),
			};
		}

		if (result.runInBackground) {
			removeChainDir(chainDir);
			const updatedChain: ChainStep[] = chainSteps.map((step, i) => {
				if (isParallelStep(step)) return step;
				const override = result.behaviorOverrides[i];
				return {
					...step,
					task: result.templates[i]!,
					...(override?.model ? { model: override.model } : {}),
					...(override?.output !== undefined ? { output: override.output } : {}),
					...("outputMode" in step && step.outputMode !== undefined ? { outputMode: step.outputMode } : {}),
					...(override?.reads !== undefined ? { reads: override.reads } : {}),
					...(override?.progress !== undefined ? { progress: override.progress } : {}),
					...(override?.skills !== undefined ? { skill: override.skills } : {}),
				};
			});
			return {
				content: [{ type: "text", text: "Launching in background..." }],
				details: buildChainExecutionDetails(makeDetailsInput()),
				requestedAsync: { chain: updatedChain, chainSkills },
			};
		}

		templates = result.templates;
		tuiBehaviorOverrides = result.behaviorOverrides;
	}

	const deadlineAt = params.deadlineAt ?? (params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined);
	const globalSemaphore = new Semaphore(params.globalConcurrencyLimit ?? DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
	const loop: ChainLoopState = { prev: "", globalTaskIndex: 0, progressCreated: false };
	const c: ChainStepEnv = { params, chainSteps, agents, ctx, intercomEvents, signal, runId, cwd, shareEnabled, sessionDirForIndex, sessionFileForIndex, sessionFileForTask, thinkingOverrideForTask, artifactsDir, artifactConfig, includeProgress, onUpdate, onControlEvent, controlConfig, onDetachedExit, childIntercomTarget, orchestratorIntercomTarget, foregroundControl, modelScope, chainSkills, results, outputs, dynamicChildren, dynamicGroupStatuses, allProgress, allArtifactPaths, chainAgents, totalSteps, makeDetailsInput, originalTask, chainDir, templates, tuiBehaviorOverrides, availableModels, deadlineAt, globalSemaphore };

	for (let stepIndex = 0; stepIndex < chainSteps.length; stepIndex++) {
		const step = chainSteps[stepIndex]!;
		const stepTemplates = templates[stepIndex]!;

		let early: ChainExecutionResult | undefined;
		if (isParallelStep(step)) {
			early = await executeParallelStep(c, loop, step, stepIndex, stepTemplates);
		} else if (isDynamicParallelStep(step)) {
			early = await executeDynamicStep(c, loop, step, stepIndex, stepTemplates);
		} else {
			early = await executeSequentialStep(c, loop, step, stepIndex, stepTemplates);
		}
		if (early) return early;
	}

	const summary = buildChainSummary(chainSteps, results, chainDir, "completed");

	return {
		content: [{ type: "text", text: summary }],
		details: buildChainExecutionDetails(makeDetailsInput()),
	};
}
