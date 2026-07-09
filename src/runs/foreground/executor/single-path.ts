/** single-path (split from subagent-executor.ts; internal-only). */

import { discoverAvailableSkills, normalizeSkillInput } from "../../../agents/skills.ts";
import { INTERCOM_BRIDGE_MARKER, resolveSubagentIntercomTarget } from "../../../intercom/intercom-bridge.ts";
import { type ModelInfo, toModelInfo } from "../../../shared/model-info.ts";
import { resolveStepBehavior } from "../../../shared/settings.ts";
import { type AgentProgress, type ArtifactPaths, type Details, resolveChildMaxSubagentDepth, resolveCurrentMaxSubagentDepth, wrapForkTask } from "../../../shared/types.ts";
import { compactForegroundDetails, getSingleResultOutput, sumResultsCost, sumResultsUsage } from "../../../shared/utils.ts";
import { executeAsyncSingle, isAsyncAvailable } from "../../background/async-execution.ts";
import { resolveSubagentModelOverride } from "../../shared/model-fallback.ts";
import { attachRootChildrenToSteps, updateForegroundNestedProjection } from "../../shared/nested-events.ts";
import { recordRun } from "../../shared/run-history.ts";
import { finalizeSingleOutput, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../../shared/single-output.ts";
import { type ChainClarifyResult, ChainClarifyComponent } from ".././chain-clarify.ts";
import { runSync } from ".././execution.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { resolveEffectiveToolBudget, shouldForkAgent } from "./budget-resolution.ts";
import { notifyForegroundDetachedCompletion } from "./foreground-notify.ts";
import { rememberForegroundRun, updateRememberedForegroundChild } from "./foreground-state.ts";
import { toExecutionErrorResult } from "./fork-helpers.ts";
import { createForegroundControlNotifier, formatFailedSingleRunOutput, maybeBuildForegroundIntercomReceipt } from "./intercom-result.ts";
import { resolveSingleRunOutputBaseDir } from "./parallel-helpers.ts";
import { type ExecutionContextData, type ExecutorDeps } from "./types.ts";


export async function runSinglePath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		onUpdate,
		sessionRoot,
		controlConfig,
		contextPolicy,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget(runId, params.agent!, 0) : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const agentConfig = agents.find((a) => a.name === params.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}
	const effectiveToolBudget = resolveEffectiveToolBudget({ runBudget: data.toolBudget, agentBudget: agentConfig.toolBudget, configBudget: data.configToolBudget });
	if (effectiveToolBudget.error) return toExecutionErrorResult(params, new Error(effectiveToolBudget.error));

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let task = params.task ?? "";
	let modelOverride: string | undefined = resolveSubagentModelOverride(
		(params.model as string | undefined) ?? agentConfig.model,
		ctx.model,
		availableModels,
		currentProvider,
		{ scope: data.modelScope, source: (params.model as string | undefined) ? "explicit" : "inherited" },
	);
	let skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	let effectiveOutput = normalizeSingleOutputOverride(rawOutput, agentConfig.output);
	const effectiveOutputMode = params.outputMode ?? "inline";
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);

	if (params.clarify === true && ctx.hasUI) {
		const behavior = resolveStepBehavior(agentConfig, { output: effectiveOutput, skills: skillOverride });
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					[agentConfig],
					[task],
					task,
					undefined,
					[behavior],
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"single",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "single", results: [] } };
		}

		task = result.templates[0]!;
		const override = result.behaviorOverrides[0];
		if (override?.model) modelOverride = resolveSubagentModelOverride(override.model, ctx.model, availableModels, currentProvider, { scope: data.modelScope, source: "explicit" });
		if (override?.output !== undefined) effectiveOutput = normalizeSingleOutputOverride(override.output, agentConfig.output);
		if (override?.skills !== undefined) skillOverride = override.skills;

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
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
			return executeAsyncSingle(id, {
				agent: params.agent!,
				task: shouldForkAgent(contextPolicy, params.agent!) ? wrapForkTask(task) : task,
				agentConfig,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				sessionFile: sessionFileForTask(params.agent!, 0),
				skills: skillOverride === false ? [] : skillOverride,
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
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
				timeoutMs: data.timeoutMs,
				turnBudget: data.turnBudget,
				toolBudget: effectiveToolBudget.toolBudget,
			});
		}
	}

	if (shouldForkAgent(contextPolicy, params.agent!)) {
		task = wrapForkTask(task);
	}
	const cleanTask = task;
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, effectiveCwd, resolveSingleRunOutputBaseDir(deps, artifactsDir, runId));
	const validationError = validateFileOnlyOutputMode(effectiveOutputMode, outputPath, `Single run (${params.agent})`);
	if (validationError) {
		return { content: [{ type: "text", text: validationError }], isError: true, details: { mode: "single", results: [] } };
	}
	task = injectSingleOutputInstruction(task, outputPath);

	let effectiveSkills: string[] | undefined;
	if (skillOverride === false) {
		effectiveSkills = [];
	} else {
		effectiveSkills = skillOverride;
	}
	const interruptController = new AbortController();
	const foregroundControl = deps.state.foregroundControls.get(runId);
	if (foregroundControl) {
		foregroundControl.currentAgent = params.agent;
		foregroundControl.currentIndex = 0;
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

	const forwardSingleUpdate = onUpdate
		? (update: AgentToolResult<Details>) => {
			if (foregroundControl) {
				const firstProgress = update.details?.progress?.[0];
				foregroundControl.currentAgent = params.agent;
				foregroundControl.currentIndex = firstProgress?.index ?? 0;
				foregroundControl.currentActivityState = firstProgress?.activityState;
				foregroundControl.lastActivityAt = firstProgress?.lastActivityAt;
				foregroundControl.currentTool = firstProgress?.currentTool;
				foregroundControl.currentToolStartedAt = firstProgress?.currentToolStartedAt;
				foregroundControl.currentPath = firstProgress?.currentPath;
				foregroundControl.turnCount = firstProgress?.turnCount;
				foregroundControl.tokens = firstProgress?.tokens;
				foregroundControl.toolCount = firstProgress?.toolCount;
				foregroundControl.updatedAt = Date.now();
			}
			onUpdate(update);
		}
		: undefined;

	const deadlineAt = data.deadlineAt ?? (data.timeoutMs !== undefined ? Date.now() + data.timeoutMs : undefined);
	const r = await runSync(ctx.cwd, agents, params.agent!, task, {
		parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
		cwd: effectiveCwd,
		signal,
		interruptSignal: interruptController.signal,
		allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
		intercomEvents: deps.pi.events,
		runId,
		sessionDir: sessionDirForIndex(0),
		sessionFile: sessionFileForTask(params.agent!, 0),
		share: shareEnabled,
		artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
		artifactConfig,
		maxOutput: params.maxOutput,
		outputPath,
		outputMode: effectiveOutputMode,
		maxSubagentDepth,
		onUpdate: forwardSingleUpdate,
		controlConfig,
		onControlEvent,
		intercomSessionName: childIntercomTarget,
		orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
		nestedRoute: foregroundControl?.nestedRoute,
		index: 0,
		modelOverride,
		thinkingOverride: thinkingOverrideForTask(params.agent!, 0),
		availableModels,
		preferredModelProvider: currentProvider,
		modelScope: data.modelScope,
		skills: effectiveSkills,
		acceptance: params.acceptance,
		acceptanceContext: { mode: "single" },
		onDetachedExit: (result) => {
			updateRememberedForegroundChild(deps.state, { runId, mode: "single", cwd: effectiveCwd, index: 0, result });
			notifyForegroundDetachedCompletion({ events: deps.pi.events, state: deps.state, runId, mode: "single", index: 0, result, orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined });
		},
		timeoutMs: data.timeoutMs,
		deadlineAt,
		turnBudget: data.turnBudget,
		toolBudget: effectiveToolBudget.toolBudget,
	});
	if (foregroundControl?.currentIndex === 0) {
		foregroundControl.interrupt = undefined;
		foregroundControl.currentActivityState = r.progress?.activityState;
		foregroundControl.lastActivityAt = r.progress?.lastActivityAt;
		foregroundControl.currentTool = r.progress?.currentTool;
		foregroundControl.currentToolStartedAt = r.progress?.currentToolStartedAt;
		foregroundControl.currentPath = r.progress?.currentPath;
		foregroundControl.turnCount = r.progress?.turnCount;
		foregroundControl.tokens = r.progress?.tokens;
		foregroundControl.toolCount = r.progress?.toolCount;
		foregroundControl.updatedAt = Date.now();
	}
	recordRun(params.agent!, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getSingleResultOutput(r);
	const finalizedOutput = finalizeSingleOutput({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		outputMode: r.outputMode,
		exitCode: r.exitCode,
		savedPath: r.savedOutputPath,
		outputReference: r.outputReference,
		saveError: r.outputSaveError,
	});
	if (foregroundControl) {
		updateForegroundNestedProjection(foregroundControl);
		attachRootChildrenToSteps(runId, [r], foregroundControl.nestedChildren);
	}
	const details = compactForegroundDetails({
		mode: "single",
		runId,
		results: [r],
		...(data.turnBudget ? { turnBudget: data.turnBudget } : {}),
		...(effectiveToolBudget.toolBudget ? { toolBudget: effectiveToolBudget.toolBudget } : {}),
		progress: params.includeProgress ? allProgress : undefined,
		artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		truncation: r.truncation,
		totalChildUsage: sumResultsUsage([r]),
		totalCost: sumResultsCost([r]),
	});
	rememberForegroundRun(deps.state, { runId, mode: "single", cwd: effectiveCwd, results: details.results });

	if (!r.detached && !r.interrupted) {
		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "single",
			details,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
				...(r.exitCode !== 0 ? { isError: true } : {}),
			};
		}
	}

	if (r.detached) {
		return {
			content: [{ type: "text", text: `Detached for intercom coordination: ${params.agent}. Reply to the supervisor request first. Status: subagent({ action: "status", id: "${runId}" }). After the child exits, start a fresh follow-up if needed.` }],
			details,
		};
	}

	if (r.interrupted) {
		return {
			content: [{ type: "text", text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.` }],
			details,
		};
	}

	if (r.exitCode !== 0)
		return {
			content: [{ type: "text", text: formatFailedSingleRunOutput(r, finalizedOutput.displayOutput) }],
			details,
			isError: true,
		};
	return {
		content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
		details,
	};
}
