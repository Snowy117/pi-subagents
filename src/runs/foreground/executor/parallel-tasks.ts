/** parallel-tasks (split from subagent-executor.ts; internal-only). */

import { INTERCOM_BRIDGE_MARKER } from "../../../intercom/intercom-bridge.ts";
import { buildChainInstructions } from "../../../shared/settings.ts";
import { type AgentProgress, type SingleResult } from "../../../shared/types.ts";
import { mapConcurrent } from "../../../shared/utils.ts";
import { injectSingleOutputInstruction, resolveSingleOutputPath } from "../../shared/single-output.ts";
import { runSync } from ".././execution.ts";
import { notifyForegroundDetachedCompletion } from "./foreground-notify.ts";
import { updateRememberedForegroundChild } from "./foreground-state.ts";
import { resolveParallelTaskCwd } from "./parallel-helpers.ts";
import { type ForegroundParallelRunInput } from "./types.ts";


export async function runForegroundParallelTasks(input: ForegroundParallelRunInput): Promise<SingleResult[]> {
	// Pre-warm fork session files sequentially before concurrent dispatch to avoid
	// races where multiple workers simultaneously try to branch the same parent session.
	// sessionFileForIndex caches results, so these calls return instantly inside mapConcurrent.
	for (let i = 0; i < input.tasks.length; i++) {
		input.sessionFileForIndex(i);
	}
	return mapConcurrent(input.tasks, input.concurrencyLimit, async (task, index) => {
		const behavior = input.behaviors[index];
		const effectiveSkills = behavior?.skills;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
		const readInstructions = behavior
			? buildChainInstructions({ ...behavior, output: false, progress: false }, taskCwd, false)
			: { prefix: "", suffix: "" };
		const progressInstructions = behavior
			? buildChainInstructions({ ...behavior, output: false, reads: false }, input.progressDir, index === input.firstProgressIndex)
			: { prefix: "", suffix: "" };
		const outputPath = resolveSingleOutputPath(behavior?.output, input.ctx.cwd, taskCwd, input.outputBaseDir);
		const taskText = injectSingleOutputInstruction(
			`${readInstructions.prefix}${input.taskTexts[index]!}${progressInstructions.suffix}`,
			outputPath,
		);
		const interruptController = new AbortController();
		if (input.foregroundControl) {
			input.foregroundControl.currentAgent = task.agent;
			input.foregroundControl.currentIndex = index;
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
		const agentConfig = input.agents.find((agent) => agent.name === task.agent);
		return runSync(input.ctx.cwd, input.agents, task.agent, taskText, {
			parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
			cwd: taskCwd,
			signal: input.signal,
			interruptSignal: interruptController.signal,
			allowIntercomDetach: agentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			intercomEvents: input.intercomEvents,
			runId: input.runId,
			index,
			sessionDir: input.sessionDirForIndex(index),
			sessionFile: input.sessionFileForTask(task.agent, index),
			share: input.shareEnabled,
			artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
			artifactConfig: input.artifactConfig,
			maxOutput: input.maxOutput,
			outputPath,
			outputMode: behavior?.outputMode,
			maxSubagentDepth: input.maxSubagentDepths[index],
			controlConfig: input.controlConfig,
			onControlEvent: input.onControlEvent,
			onDetachedExit: (result) => {
				updateRememberedForegroundChild(input.state, { runId: input.runId, mode: "parallel", cwd: taskCwd, index, result });
				notifyForegroundDetachedCompletion({ events: input.intercomEvents, state: input.state, runId: input.runId, mode: "parallel", index, result, orchestratorIntercomTarget: input.orchestratorIntercomTarget });
			},
			intercomSessionName: input.childIntercomTarget?.(task.agent, index),
			orchestratorIntercomTarget: input.orchestratorIntercomTarget,
			nestedRoute: input.foregroundControl?.nestedRoute,
			modelOverride: input.modelOverrides[index],
			thinkingOverride: input.thinkingOverrideForTask(task.agent, index),
			availableModels: input.availableModels,
			preferredModelProvider: input.ctx.model?.provider,
			modelScope: input.modelScope,
			skills: effectiveSkills === false ? [] : effectiveSkills,
			acceptance: task.acceptance,
			acceptanceContext: { mode: "parallel" },
			timeoutMs: input.timeoutMs,
			deadlineAt: input.deadlineAt,
			turnBudget: input.turnBudget,
			toolBudget: input.toolBudgets[index],
			onUpdate: input.onUpdate
				? (progressUpdate) => {
					const stepResults = progressUpdate.details?.results || [];
					const stepProgress = progressUpdate.details?.progress || [];
					if (input.foregroundControl && stepProgress.length > 0) {
						const current = stepProgress[0];
						input.foregroundControl.currentAgent = task.agent;
						input.foregroundControl.currentIndex = index;
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
					if (stepResults.length > 0) input.liveResults[index] = stepResults[0];
					if (stepProgress.length > 0) input.liveProgress[index] = stepProgress[0];
					const mergedResults = input.liveResults.filter((result): result is SingleResult => result !== undefined);
					const mergedProgress = input.liveProgress.filter((progress): progress is AgentProgress => progress !== undefined);
					input.onUpdate?.({
						content: progressUpdate.content,
						details: {
							mode: "parallel",
							results: mergedResults,
							progress: mergedProgress,
							controlEvents: progressUpdate.details?.controlEvents,
							totalSteps: input.tasks.length,
						},
					});
				}
				: undefined,
		}).finally(() => {
			if (input.foregroundControl?.currentIndex === index) {
				input.foregroundControl.interrupt = undefined;
				input.foregroundControl.updatedAt = Date.now();
			}
		});
	}, input.globalSemaphore);
}
