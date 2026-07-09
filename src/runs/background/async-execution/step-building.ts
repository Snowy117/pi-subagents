import * as path from "node:path";
import type { AgentConfig } from "../../../agents/agents.ts";
import { applyThinkingSuffix } from "../../shared/pi-args.ts";
import { injectOutputPathSystemPrompt, injectSingleOutputInstruction, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../../shared/single-output.ts";
import { buildChainInstructions, isDynamicParallelStep, isParallelStep, resolveStepBehavior, suppressProgressForReadOnlyTask, writeInitialProgressFile, type ChainStep, type ResolvedStepBehavior, type SequentialStep, type StepOverrides } from "../../../shared/settings.ts";
import { buildSkillInjection, normalizeSkillInput, resolveSkillsWithFallback } from "../../../agents/skills.ts";
import { buildAgentMemoryInjection } from "../../../agents/agent-memory.ts";
import { resolveChildCwd } from "../../../shared/utils.ts";
import { buildModelCandidates, resolveSubagentModelOverride } from "../../shared/model-fallback.ts";
import { resolveEffectiveThinking } from "../../../shared/model-info.ts";
import { resolveExpectedWorktreeAgentCwd } from "../../shared/worktree.ts";
import { buildWorkflowGraphSnapshot } from "../../shared/workflow-graph.ts";
import { ChainOutputValidationError, validateChainOutputBindings } from "../../shared/chain-outputs.ts";
import { createStructuredOutputRuntime } from "../../shared/structured-output.ts";
import { resolveEffectiveAcceptance } from "../../shared/acceptance.ts";
import { resolveChildMaxSubagentDepth } from "../../../shared/types.ts";
import { validateToolBudgetConfig } from "../../shared/tool-budget.ts";
import type { AsyncRunnerStepBuildParams, AsyncRunnerStepBuildResult } from "./types.ts";
import { AsyncStartValidationError, UNAVAILABLE_SUBAGENT_SKILL_ERROR, UnavailableSubagentSkillError } from "./start-helpers.ts";

export function buildAsyncRunnerSteps(id: string, params: AsyncRunnerStepBuildParams): AsyncRunnerStepBuildResult {
	const {
		chain,
		agents,
		ctx,
		cwd,
		sessionFilesByFlatIndex,
		thinkingOverridesByFlatIndex,
		maxSubagentDepth,
		worktreeBaseDir,
		asyncDir,
	} = params;
	const outputBaseDir = params.outputBaseDir;
	const resultMode = params.resultMode ?? "chain";
	const chainSkills = params.chainSkills ?? [];
	const availableModels = params.availableModels;
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const progressDir = params.progressDir ?? runnerCwd;
	const graphChain: ChainStep[] = params.attachRoot
		? [{
				agent: params.attachRoot.agent,
				task: `Attach async root ${params.attachRoot.runId}`,
				label: params.attachRoot.label ?? `Attached root ${params.attachRoot.runId}`,
				...(params.attachRoot.outputName ? { as: params.attachRoot.outputName } : {}),
			}, ...chain]
		: chain;
	const firstStep = chain[0];
	const originalTask = params.task ?? (firstStep
		? (isParallelStep(firstStep)
			? firstStep.parallel[0]?.task
			: isDynamicParallelStep(firstStep)
				? firstStep.parallel.task
				: (firstStep as SequentialStep).task)
		: undefined);
	try {
		if (params.validateOutputBindings !== false) {
			validateChainOutputBindings(chain, { maxItems: params.dynamicFanoutMaxItems });
		}
	} catch (error) {
		if (error instanceof ChainOutputValidationError) return { error: error.message };
		throw error;
	}
	const workflowGraph = buildWorkflowGraphSnapshot({ runId: id, mode: resultMode, steps: graphChain });

	for (const s of chain) {
		const stepAgents = isParallelStep(s)
			? s.parallel.map((t) => t.agent)
			: isDynamicParallelStep(s)
				? [s.parallel.agent]
				: [(s as SequentialStep).agent];
		for (const agentName of stepAgents) {
			if (!agents.find((x) => x.name === agentName)) {
				return { error: `Unknown agent: ${agentName}` };
			}
		}
	}

	let progressInstructionCreated = false;
	const buildStepOverrides = (s: SequentialStep): StepOverrides => {
		const stepSkillInput = normalizeSkillInput(s.skill);
		return {
			...(s.output !== undefined ? { output: s.output } : {}),
			...(s.outputMode !== undefined ? { outputMode: s.outputMode } : {}),
			...(s.reads !== undefined ? { reads: s.reads } : {}),
			...(s.progress !== undefined ? { progress: s.progress } : {}),
			...(stepSkillInput !== undefined ? { skills: stepSkillInput } : {}),
			...(s.model ? { model: s.model } : {}),
		};
	};
	const buildSeqStep = (s: SequentialStep, sessionFile?: string, behaviorCwd?: string, progressPrecreated = false, resolvedBehavior?: ResolvedStepBehavior, flatIndex?: number) => {
		const a = agents.find((x) => x.name === s.agent)!;
		const toolBudgetInput = s.toolBudget ?? params.toolBudget ?? a.toolBudget ?? params.configToolBudget;
		const resolvedToolBudget = validateToolBudgetConfig(toolBudgetInput, s.toolBudget ? "toolBudget" : a.toolBudget ? "agent.toolBudget" : "config.toolBudget");
		if (resolvedToolBudget.error) throw new AsyncStartValidationError(resolvedToolBudget.error);
		const stepCwd = resolveChildCwd(runnerCwd, s.cwd);
		const instructionCwd = behaviorCwd ?? stepCwd;
		const behavior = suppressProgressForReadOnlyTask(resolvedBehavior ?? resolveStepBehavior(a, buildStepOverrides(s), chainSkills), s.task, originalTask);
		const skillNames = behavior.skills === false ? [] : behavior.skills;
		const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, stepCwd, ctx.cwd);
		if (missingSkills.includes("pi-subagents")) throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);

		let systemPrompt = a.systemPrompt?.trim() ?? "";
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}
		const memoryInjection = buildAgentMemoryInjection(a, stepCwd);
		if (memoryInjection) {
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryInjection}` : memoryInjection;
		}

		const readInstructions = buildChainInstructions({ ...behavior, output: false, progress: false }, instructionCwd, false);
		const isFirstProgressAgent = behavior.progress && !progressPrecreated && !progressInstructionCreated;
		if (behavior.progress) progressInstructionCreated = true;
		const progressInstructions = buildChainInstructions({ ...behavior, output: false, reads: false }, progressDir, isFirstProgressAgent);
		const outputPath = resolveSingleOutputPath(behavior.output, ctx.cwd, instructionCwd, outputBaseDir);
		systemPrompt = injectOutputPathSystemPrompt(systemPrompt, outputPath);
		const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Async step (${s.agent})`);
		if (validationError) throw new AsyncStartValidationError(validationError);
		let taskTemplate = s.task ?? "{previous}";
		taskTemplate = taskTemplate.replace(/\{task\}/g, originalTask ?? "");
		taskTemplate = taskTemplate.replace(/\{chain_dir\}/g, runnerCwd);
		const task = injectSingleOutputInstruction(`${readInstructions.prefix}${taskTemplate}${progressInstructions.suffix}`, outputPath);

		const requestedModel = behavior.model ?? a.model;
		const primaryModel = resolveSubagentModelOverride(requestedModel, ctx.currentModel, availableModels, ctx.currentModelProvider, { scope: ctx.modelScope, source: behavior.model ? "explicit" : "inherited" });
		const thinkingOverride = flatIndex === undefined ? undefined : thinkingOverridesByFlatIndex?.[flatIndex];
		const effectiveThinking = thinkingOverride ?? a.thinking;
		const model = applyThinkingSuffix(primaryModel, effectiveThinking, thinkingOverride !== undefined);
		return {
			parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
			agent: s.agent,
			task,
			phase: s.phase,
			label: s.label,
			outputName: s.as,
			structured: Boolean(s.outputSchema),
			cwd: stepCwd,
			model,
			thinking: resolveEffectiveThinking(model, effectiveThinking),
			modelCandidates: buildModelCandidates(primaryModel, a.fallbackModels, availableModels, ctx.currentModelProvider, { scope: ctx.modelScope }).map((candidate) =>
				applyThinkingSuffix(candidate, effectiveThinking, thinkingOverride !== undefined),
			),
			tools: a.tools,
			extensions: a.extensions,
			subagentOnlyExtensions: a.subagentOnlyExtensions,
			mcpDirectTools: a.mcpDirectTools,
			completionGuard: a.completionGuard,
			systemPrompt,
			systemPromptMode: a.systemPromptMode,
			inheritProjectContext: a.inheritProjectContext,
			inheritSkills: a.inheritSkills,
			skills: resolvedSkills.map((r) => r.name),
			outputPath,
			outputMode: behavior.outputMode,
			sessionFile,
			maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, a.maxSubagentDepth),
			effectiveAcceptance: resolveEffectiveAcceptance({
				explicit: s.acceptance,
				agentName: s.agent,
				task: s.task,
				mode: resultMode,
				async: true,
				dynamic: false,
			}),
			...(s.outputSchema ? { structuredOutputSchema: s.outputSchema } : {}),
			...(s.outputSchema ? { structuredOutput: createStructuredOutputRuntime(s.outputSchema, path.join(asyncDir, "structured-output")) } : {}),
			...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
		};
	};

	let flatStepIndex = 0;
	const nextFlatStep = (): { index: number; sessionFile?: string; thinkingOverride?: AgentConfig["thinking"] } => {
		const index = flatStepIndex;
		const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex];
		const thinkingOverride = thinkingOverridesByFlatIndex?.[flatStepIndex];
		flatStepIndex++;
		return {
			index,
			...(sessionFile ? { sessionFile } : {}),
			...(thinkingOverride ? { thinkingOverride } : {}),
		};
	};

	try {
		const builtSteps = chain.map((s, stepIndex) => {
			if (isParallelStep(s)) {
				const parallelBehaviors = s.parallel.map((task) => {
					const agent = agents.find((candidate) => candidate.name === task.agent)!;
					return suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(task), chainSkills), task.task, originalTask);
				});
				const progressPrecreated = parallelBehaviors.some((behavior) => behavior.progress);
				if (progressPrecreated) {
					if (!s.worktree || params.progressDir) writeInitialProgressFile(progressDir);
					progressInstructionCreated = true;
				}
				return {
					parallel: s.parallel.map((t, taskIndex) => {
						let behaviorCwd: string | undefined;
						if (s.worktree) {
							try {
								behaviorCwd = resolveExpectedWorktreeAgentCwd(runnerCwd, `${id}-s${stepIndex}`, taskIndex, worktreeBaseDir);
							} catch {
								behaviorCwd = undefined;
							}
						}
						const staticStep = nextFlatStep();
						return buildSeqStep(t, staticStep.sessionFile, behaviorCwd, progressPrecreated, parallelBehaviors[taskIndex], staticStep.index);
					}),
					concurrency: s.concurrency,
					failFast: s.failFast,
					worktree: s.worktree,
				};
			}
			if (isDynamicParallelStep(s)) {
				const agent = agents.find((candidate) => candidate.name === s.parallel.agent)!;
				const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(s.parallel), chainSkills), s.parallel.task, originalTask);
				const progressPrecreated = behavior.progress;
				if (progressPrecreated) {
					writeInitialProgressFile(progressDir);
					progressInstructionCreated = true;
				}
				const maxItems = s.expand.maxItems ?? params.dynamicFanoutMaxItems ?? 0;
				const dynamicFlatSteps = Array.from({ length: maxItems }, () => nextFlatStep());
				return {
					expand: s.expand,
					parallel: buildSeqStep(s.parallel as SequentialStep, undefined, undefined, progressPrecreated, behavior),
					collect: s.collect,
					concurrency: s.concurrency,
					failFast: s.failFast,
					phase: s.phase,
					label: s.label,
					sessionFiles: dynamicFlatSteps.map((step) => step.sessionFile),
					thinkingOverrides: dynamicFlatSteps.map((step) => step.thinkingOverride),
					effectiveAcceptance: resolveEffectiveAcceptance({
						explicit: s.acceptance,
						agentName: s.parallel.agent,
						task: s.parallel.task,
						mode: resultMode,
						async: true,
						dynamicGroup: true,
					}),
				};
			}
			const staticStep = nextFlatStep();
			return buildSeqStep(s as SequentialStep, staticStep.sessionFile, undefined, false, undefined, staticStep.index);
		});
		const steps = params.attachRoot
			? [{
					agent: params.attachRoot.agent,
					task: "",
					label: params.attachRoot.label ?? `Attached root ${params.attachRoot.runId}`,
					outputName: params.attachRoot.outputName,
					importAsyncRoot: {
						runId: params.attachRoot.runId,
						asyncDir: params.attachRoot.asyncDir,
						resultPath: params.attachRoot.resultPath,
						index: params.attachRoot.index,
					},
					inheritProjectContext: false,
					inheritSkills: false,
				}, ...builtSteps]
			: builtSteps;
		return { steps, runnerCwd, workflowGraph, eventChain: graphChain, ...(originalTask !== undefined ? { originalTask } : {}) };
	} catch (error) {
		if (error instanceof UnavailableSubagentSkillError || error instanceof AsyncStartValidationError) return { error: error.message };
		throw error;
	}
}
