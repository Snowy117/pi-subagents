/** parallel-path (split from subagent-executor.ts; internal-only). */

import { type AgentConfig } from "../../../agents/agents.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../../agents/skills.ts";
import { resolveSubagentIntercomTarget } from "../../../intercom/intercom-bridge.ts";
import { type ModelInfo, toModelInfo } from "../../../shared/model-info.ts";
import { type StepOverrides, resolveStepBehavior, suppressProgressForReadOnlyTask, taskDisallowsFileUpdates, writeInitialProgressFile } from "../../../shared/settings.ts";
import { type AgentProgress, type ArtifactPaths, type Details, type ResolvedToolBudget, type SingleResult, resolveChildMaxSubagentDepth, resolveCurrentMaxSubagentDepth, resolveTopLevelParallelConcurrency, resolveTopLevelParallelMaxTasks, wrapForkTask } from "../../../shared/types.ts";
import { compactForegroundDetails, getSingleResultOutput, sumResultsCost, sumResultsUsage } from "../../../shared/utils.ts";
import { executeAsyncChain, isAsyncAvailable } from "../../background/async-execution.ts";
import { resolveSubagentModelOverride } from "../../shared/model-fallback.ts";
import { attachRootChildrenToSteps, updateForegroundNestedProjection } from "../../shared/nested-events.ts";
import { DEFAULT_GLOBAL_CONCURRENCY_LIMIT, Semaphore, aggregateParallelOutputs } from "../../shared/parallel-utils.ts";
import { recordRun } from "../../shared/run-history.ts";
import { resolveSingleOutputPath, validateFileOnlyOutputMode } from "../../shared/single-output.ts";
import { cleanupWorktrees } from "../../shared/worktree.ts";
import { type ChainClarifyResult, ChainClarifyComponent } from ".././chain-clarify.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { resolveEffectiveToolBudget, shouldForkAgent } from "./budget-resolution.ts";
import { rememberForegroundRun } from "./foreground-state.ts";
import { createForegroundControlNotifier, maybeBuildForegroundIntercomReceipt } from "./intercom-result.ts";
import { buildParallelModeError, buildParallelWorktreeSuffix, buildParallelWorktreeTaskCwdError, createParallelWorktreeSetup, findDuplicateParallelOutputPath, resolveParallelTaskCwd } from "./parallel-helpers.ts";
import { runForegroundParallelTasks } from "./parallel-tasks.ts";
import { type ExecutionContextData, type ExecutorDeps } from "./types.ts";
import * as path from "node:path";


export async function runParallelPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		backgroundRequestedWhileClarifying,
		onUpdate,
		sessionRoot,
		controlConfig,
		contextPolicy,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const tasks = params.tasks!;
	const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
	const parallelConcurrency = resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency);

	if (tasks.length > maxParallelTasks)
		return {
			content: [{ type: "text", text: `Max ${maxParallelTasks} tasks` }],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};

	const agentConfigs: AgentConfig[] = [];
	for (const t of tasks) {
		const config = agents.find((a) => a.name === t.agent);
		if (!config) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
				isError: true,
				details: { mode: "parallel" as const, results: [] },
			};
		}
		agentConfigs.push(config);
	}

	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepths = agentConfigs.map((config) =>
		resolveChildMaxSubagentDepth(currentMaxSubagentDepth, config.maxSubagentDepth),
	);
	const toolBudgets: (ResolvedToolBudget | undefined)[] = [];
	for (let index = 0; index < tasks.length; index++) {
		const resolved = resolveEffectiveToolBudget({ stepBudget: tasks[index]?.toolBudget, runBudget: data.toolBudget, agentBudget: agentConfigs[index]?.toolBudget, configBudget: data.configToolBudget });
		if (resolved.error) return buildParallelModeError(resolved.error);
		toolBudgets.push(resolved.toolBudget);
	}

	if (params.worktree) {
		const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(tasks, effectiveCwd);
		if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let taskTexts = tasks.map((t) => t.task);
	const skillOverrides: (string[] | false | undefined)[] = tasks.map((t) =>
		normalizeSkillInput(t.skill),
	);
	const behaviorOverrides: StepOverrides[] = tasks.map((task, index) => ({
		...(task.output !== undefined ? { output: task.output === true ? agentConfigs[index]?.output ?? false : task.output } : {}),
		...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
		...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
		...(task.progress !== undefined ? { progress: task.progress } : {}),
		...(skillOverrides[index] !== undefined ? { skills: skillOverrides[index] } : {}),
		...(task.model ? { model: task.model } : {}),
	}));
	const modelOverrides: (string | undefined)[] = tasks.map((_, i) =>
		resolveSubagentModelOverride(behaviorOverrides[i]?.model ?? agentConfigs[i]?.model, ctx.model, availableModels, currentProvider, { scope: data.modelScope, source: behaviorOverrides[i]?.model ? "explicit" : "inherited" }),
	);

	if (params.clarify === true && ctx.hasUI) {
		const behaviors = agentConfigs.map((c, i) =>
			resolveStepBehavior(c, behaviorOverrides[i]!),
		);
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					agentConfigs,
					taskTexts,
					"",
					undefined,
					behaviors,
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"parallel",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "parallel", results: [] } };
		}

		taskTexts = result.templates;
		for (let i = 0; i < result.behaviorOverrides.length; i++) {
			const override = result.behaviorOverrides[i];
			if (override?.model) {
				modelOverrides[i] = resolveSubagentModelOverride(override.model, ctx.model, availableModels, currentProvider, { scope: data.modelScope, source: "explicit" });
				behaviorOverrides[i]!.model = override.model;
			}
			if (override?.output !== undefined) behaviorOverrides[i]!.output = override.output;
			if (override?.reads !== undefined) behaviorOverrides[i]!.reads = override.reads;
			if (override?.progress !== undefined) behaviorOverrides[i]!.progress = override.progress;
			if (override?.skills !== undefined) {
				skillOverrides[i] = override.skills;
				behaviorOverrides[i]!.skills = override.skills;
			}
		}

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
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
			const parallelTasks = tasks.map((t, i) => {
				const taskText = shouldForkAgent(contextPolicy, t.agent) ? wrapForkTask(taskTexts[i]!) : taskTexts[i]!;
				const progress = taskDisallowsFileUpdates(taskText) ? false : behaviorOverrides[i]?.progress;
				return {
					agent: t.agent,
					task: taskText,
					cwd: t.cwd,
					...(modelOverrides[i] ? { model: modelOverrides[i] } : {}),
					...(skillOverrides[i] !== undefined ? { skill: skillOverrides[i] } : {}),
					...(behaviorOverrides[i]?.output !== undefined ? { output: behaviorOverrides[i]!.output } : {}),
					...(behaviorOverrides[i]?.outputMode !== undefined ? { outputMode: behaviorOverrides[i]!.outputMode } : {}),
					...(behaviorOverrides[i]?.reads !== undefined ? { reads: behaviorOverrides[i]!.reads } : {}),
					...(progress !== undefined ? { progress } : {}),
					...(t.toolBudget !== undefined ? { toolBudget: t.toolBudget } : {}),
					...(t.acceptance !== undefined ? { acceptance: t.acceptance } : {}),
				};
			});
			return executeAsyncChain(id, {
				chain: [{ parallel: parallelTasks, concurrency: parallelConcurrency, worktree: params.worktree }],
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
				sessionFilesByFlatIndex: tasks.map((task, index) => sessionFileForTask(task.agent, index)),
				thinkingOverridesByFlatIndex: tasks.map((task, index) => thinkingOverrideForTask(task.agent, index)),
				maxSubagentDepth: currentMaxSubagentDepth,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				worktreeBaseDir: deps.config.worktreeBaseDir,
				controlConfig,
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
				timeoutMs: data.timeoutMs,
				turnBudget: data.turnBudget,
				globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
			});
		}
	}

	const behaviors = agentConfigs.map((config, index) => suppressProgressForReadOnlyTask(resolveStepBehavior(config, behaviorOverrides[index]!), taskTexts[index]));
	const firstProgressIndex = behaviors.findIndex((behavior) => behavior.progress);
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const { setup: worktreeSetup, errorResult } = createParallelWorktreeSetup(
		params.worktree,
		effectiveCwd,
		runId,
		tasks,
		deps.config.worktreeSetupHook,
		deps.config.worktreeSetupHookTimeoutMs,
		deps.config.worktreeBaseDir,
	);
	if (errorResult) return errorResult;

	try {
		const outputBaseDir = path.join(artifactsDir, "outputs", runId);
		const duplicateOutputError = findDuplicateParallelOutputPath({
			tasks,
			behaviors,
			paramsCwd: effectiveCwd,
			ctxCwd: ctx.cwd,
			outputBaseDir,
			worktreeSetup,
		});
		if (duplicateOutputError) return buildParallelModeError(duplicateOutputError);
		for (let index = 0; index < tasks.length; index++) {
			const taskCwd = resolveParallelTaskCwd(tasks[index]!, effectiveCwd, worktreeSetup, index);
			const outputPath = resolveSingleOutputPath(behaviors[index]?.output, ctx.cwd, taskCwd, outputBaseDir);
			const validationError = validateFileOnlyOutputMode(behaviors[index]?.outputMode, outputPath, `Parallel task ${index + 1} (${tasks[index]!.agent})`);
			if (validationError) return buildParallelModeError(validationError);
		}

		const parallelProgressPrecreated = firstProgressIndex !== -1;
		const parallelProgressDir = path.join(artifactsDir, "progress", runId);
		if (parallelProgressPrecreated) writeInitialProgressFile(parallelProgressDir);

		for (let i = 0; i < taskTexts.length; i++) {
			if (shouldForkAgent(contextPolicy, tasks[i]!.agent)) taskTexts[i] = wrapForkTask(taskTexts[i]!);
		}

		const deadlineAt = data.deadlineAt ?? (data.timeoutMs !== undefined ? Date.now() + data.timeoutMs : undefined);
		const results = await runForegroundParallelTasks({
			tasks,
			taskTexts,
			agents,
			ctx,
			state: deps.state,
			intercomEvents: deps.pi.events,
			signal,
			runId,
			sessionDirForIndex,
			sessionFileForIndex,
			sessionFileForTask,
			thinkingOverrideForTask,
			shareEnabled,
			artifactConfig,
			artifactsDir,
			outputBaseDir,
			maxOutput: params.maxOutput,
			paramsCwd: effectiveCwd,
			progressDir: parallelProgressDir,
			availableModels,
			modelScope: data.modelScope,
			modelOverrides,
			behaviors,
			firstProgressIndex: parallelProgressPrecreated ? -1 : firstProgressIndex,
			controlConfig,
			onControlEvent,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
			orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			foregroundControl,
			concurrencyLimit: parallelConcurrency,
			globalSemaphore: new Semaphore(deps.config.globalConcurrencyLimit ?? DEFAULT_GLOBAL_CONCURRENCY_LIMIT),
			maxSubagentDepths,
			liveResults,
			liveProgress,
			onUpdate,
			worktreeSetup,
			timeoutMs: data.timeoutMs,
			deadlineAt,
			turnBudget: data.turnBudget,
			toolBudgets,
		});
		for (let i = 0; i < results.length; i++) {
			const run = results[i]!;
			recordRun(run.agent, taskTexts[i]!, run.exitCode, run.progressSummary?.durationMs ?? 0);
		}

		for (const result of results) {
			if (result.progress) allProgress.push(result.progress);
			if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
		}

		if (foregroundControl) {
			updateForegroundNestedProjection(foregroundControl);
			attachRootChildrenToSteps(runId, results, foregroundControl.nestedChildren);
		}
		const interrupted = results.find((result) => result.interrupted);
		const details = compactForegroundDetails({
			mode: "parallel",
			runId,
			results,
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
			totalChildUsage: sumResultsUsage(results),
			totalCost: sumResultsCost(results),
		});
		rememberForegroundRun(deps.state, { runId, mode: "parallel", cwd: effectiveCwd, results: details.results });
		if (interrupted) {
			return {
				content: [{ type: "text", text: `Parallel run paused after interrupt (${interrupted.agent}). Waiting for explicit next action.` }],
				details,
			};
		}
		const detachedIndex = results.findIndex((result) => result.detached);
		const detached = detachedIndex >= 0 ? results[detachedIndex] : undefined;
		if (detached) {
			return {
				content: [{ type: "text", text: `Parallel run detached for intercom coordination (${detached.agent}). Reply to the supervisor request first. Status: subagent({ action: "status", id: "${runId}" }). After the child exits, start a fresh follow-up if needed.` }],
				details,
			};
		}

		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "parallel",
			details,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
			};
		}

		const worktreeSuffix = buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks);
		const ok = results.filter((result) => result.exitCode === 0).length;
		const downgradeNote = backgroundRequestedWhileClarifying ? " (background requested, but clarify kept this run foreground)" : "";
		const aggregatedOutput = aggregateParallelOutputs(
			results.map((result) => ({
				agent: result.agent,
				output: result.truncation?.text || getSingleResultOutput(result),
				exitCode: result.exitCode,
				error: result.error,
				timedOut: result.timedOut,
			})),
			(i, agent) => `=== Task ${i + 1}: ${agent} ===`,
		);

		const summary = `${ok}/${results.length} succeeded${downgradeNote}`;
		const fullContent = worktreeSuffix
			? `${summary}\n\n${aggregatedOutput}\n\n${worktreeSuffix}`
			: `${summary}\n\n${aggregatedOutput}`;

		return {
			content: [{ type: "text", text: fullContent }],
			details,
		};
	} finally {
		if (worktreeSetup) cleanupWorktrees(worktreeSetup);
	}
}
