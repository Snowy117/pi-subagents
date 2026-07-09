import * as path from "node:path";
import { buildControlEvent } from "../../shared/subagent-control.ts";
import { resolveEffectiveThinking } from "../../../shared/model-info.ts";
import {
	MAX_PARALLEL_CONCURRENCY,
	mapConcurrent,
	type ParallelStepGroup,
} from "../../shared/parallel-utils.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../../shared/worktree.ts";
import { appendJsonl } from "./event-logging.ts";
import { ensureParallelProgressFile, markParallelGroupRunning, markParallelGroupSetupFailure, prepareParallelTaskRun } from "./parallel-helpers.ts";
import { resetStepLiveDetail } from "./usage-helpers.ts";
import { stepSteerInboxDir } from "../control-channel.ts";
import { runSingleStep } from "./run-single-step.ts";
import { collectParallelGroupResults } from "./runner-parallel-collection.ts";
import type { RunnerOps } from "./runner-ops.ts";
import type { RunnerState, StepOutcome } from "./runner-state.ts";

export async function runParallelGroupStep(state: RunnerState, ops: RunnerOps, group: ParallelStepGroup, stepIndex: number, flatIndex: number): Promise<StepOutcome> {
	const concurrency = group.concurrency ?? MAX_PARALLEL_CONCURRENCY;
	const failFast = group.failFast ?? false;
	const groupStartFlatIndex = flatIndex;
	let aborted = false;
	let worktreeSetup: WorktreeSetup | undefined;
	if (group.worktree) {
		const worktreeTaskCwdConflict = findWorktreeTaskCwdConflict(group.parallel, state.cwd);
		if (worktreeTaskCwdConflict) {
			const failedAt = Date.now();
			markParallelGroupSetupFailure({
				statusPayload: state.statusPayload,
				results: state.results,
				group,
				groupStartFlatIndex,
				setupError: formatWorktreeTaskCwdConflict(worktreeTaskCwdConflict, state.cwd),
				failedAt,
				statusPath: state.statusPath,
				eventsPath: state.eventsPath,
				asyncDir: state.asyncDir,
				runId: state.id,
				stepIndex,
			});
			return { nextFlatIndex: flatIndex + group.parallel.length, breakLoop: true };
		}
		try {
			worktreeSetup = createWorktrees(state.cwd, `${state.id}-s${stepIndex}`, group.parallel.length, {
				agents: group.parallel.map((task) => task.agent),
				setupHook: state.config.worktreeSetupHook
					? { hookPath: state.config.worktreeSetupHook, timeoutMs: state.config.worktreeSetupHookTimeoutMs }
					: undefined,
				baseDir: state.config.worktreeBaseDir,
			});
		} catch (error) {
			const setupError = error instanceof Error ? error.message : String(error);
			const failedAt = Date.now();
			markParallelGroupSetupFailure({
				statusPayload: state.statusPayload,
				results: state.results,
				group,
				groupStartFlatIndex,
				setupError,
				failedAt,
				statusPath: state.statusPath,
				eventsPath: state.eventsPath,
				asyncDir: state.asyncDir,
				runId: state.id,
				stepIndex,
			});
			return { nextFlatIndex: flatIndex + group.parallel.length, breakLoop: true };
		}
	}

	try {
		if (group.worktree) ensureParallelProgressFile(state.cwd, group);
		const groupStartTime = Date.now();
		markParallelGroupRunning({
			statusPayload: state.statusPayload,
			group,
			groupStartFlatIndex,
			groupStartTime,
			statusPath: state.statusPath,
			eventsPath: state.eventsPath,
			asyncDir: state.asyncDir,
			runId: state.id,
			stepIndex,
		});
		const parallelResults = await mapConcurrent(
			group.parallel,
			concurrency,
			async (task, taskIdx) => {
				const fi = groupStartFlatIndex + taskIdx;
				if (state.timedOut) return ops.timedOutStepResult(task.agent);
				if (state.interrupted) return ops.pausedStepResult(task.agent);
				if (aborted && failFast) {
					const skippedAt = Date.now();
					state.statusPayload.steps[fi].status = "failed";
					state.statusPayload.steps[fi].error = "Skipped due to fail-fast";
					state.statusPayload.steps[fi].startedAt = skippedAt;
					state.statusPayload.steps[fi].endedAt = skippedAt;
					state.statusPayload.steps[fi].durationMs = 0;
					state.statusPayload.steps[fi].exitCode = -1;
					state.statusPayload.steps[fi].activityState = undefined;
					state.statusPayload.lastUpdate = skippedAt;
					ops.writeStatusPayload();
					appendJsonl(state.eventsPath, JSON.stringify({
						type: "subagent.step.failed", ts: skippedAt, runId: state.id, stepIndex: fi, agent: task.agent, exitCode: -1, durationMs: 0,
					}));
					return { agent: task.agent, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true };
				}

				const taskStartTime = Date.now();
				state.statusPayload.currentStep = fi;
				state.statusPayload.steps[fi].status = "running";
				state.statusPayload.steps[fi].error = undefined;
				state.statusPayload.steps[fi].activityState = undefined;
				resetStepLiveDetail(state.statusPayload.steps[fi]);
				state.statusPayload.steps[fi].startedAt = taskStartTime;
				state.statusPayload.steps[fi].endedAt = undefined;
				state.statusPayload.steps[fi].durationMs = undefined;
				state.statusPayload.steps[fi].lastActivityAt = taskStartTime;
				state.statusPayload.outputFile = path.join(state.asyncDir, `output-${fi}.log`);
				state.statusPayload.lastActivityAt = taskStartTime;
				state.statusPayload.lastUpdate = taskStartTime;
				ops.writeStatusPayload();

				appendJsonl(state.eventsPath, JSON.stringify({
					type: "subagent.step.started", ts: taskStartTime, runId: state.id, stepIndex: fi, agent: task.agent,
				}));

				const taskSessionDir = state.config.sessionDir
					? path.join(state.config.sessionDir, `parallel-${taskIdx}`)
					: undefined;
				const { taskForRun, taskCwd } = prepareParallelTaskRun(task, state.cwd, worktreeSetup, taskIdx);
				ops.flushPendingStepSteers(fi);

				const singleResult = await runSingleStep(taskForRun, {
					previousOutput: state.previousOutput, placeholder: state.placeholder, cwd: taskCwd, sessionEnabled: state.sessionEnabled,
					outputs: state.outputs,
					sessionDir: taskSessionDir,
					artifactsDir: state.artifactsDir, artifactConfig: state.artifactConfig, id: state.id,
					flatIndex: fi, flatStepCount: Math.max(state.statusPayload.steps.length, 1),
					outputFile: path.join(state.asyncDir, `output-${fi}.log`),
					steerInboxDir: stepSteerInboxDir(state.asyncDir, fi),
					piPackageRoot: state.config.piPackageRoot,
					piArgv1: state.config.piArgv1,
					childIntercomTarget: state.config.childIntercomTargets?.[fi],
					orchestratorIntercomTarget: state.config.controlIntercomTarget,
					nestedRoute: state.config.nestedRoute,
					registerInterrupt: (interrupt) => ops.registerStepInterrupt(fi, interrupt),
					registerTimeout: (interrupt) => ops.registerStepTimeout(fi, interrupt),
					registerTurnBudgetAbort: (abort) => ops.registerStepTurnBudgetAbort(fi, abort),
					timeoutSignal: state.timeoutAbortController.signal,
					timeoutMessage: state.timeoutMessage,
					turnBudget: state.config.turnBudget,
					onAttemptStart: (attempt) => ops.updateStepModel(fi, attempt.model, attempt.thinking),
					onChildEvent: (event) => ops.updateStepFromChildEvent(fi, event),
					skipAcceptance: () => state.timedOut,
				});
				if (task.sessionFile) {
					state.latestSessionFile = task.sessionFile;
				}

				const taskEndTime = Date.now();
				const taskDuration = taskEndTime - taskStartTime;
				const childInterrupted = singleResult.interrupted === true;

				state.statusPayload.steps[fi].status = state.timedOut ? "failed" : childInterrupted ? "paused" : singleResult.exitCode === 0 ? "complete" : "failed";
				state.statusPayload.steps[fi].endedAt = taskEndTime;
				state.statusPayload.steps[fi].durationMs = taskDuration;
				state.statusPayload.steps[fi].exitCode = state.timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode;
				state.statusPayload.steps[fi].timedOut = state.timedOut || singleResult.timedOut ? true : undefined;
				state.statusPayload.steps[fi].turnBudget = singleResult.turnBudget;
				state.statusPayload.steps[fi].turnBudgetExceeded = singleResult.turnBudgetExceeded;
				state.statusPayload.steps[fi].wrapUpRequested = singleResult.wrapUpRequested;
				state.statusPayload.steps[fi].toolBudget = singleResult.toolBudget;
				state.statusPayload.steps[fi].toolBudgetBlocked = singleResult.toolBudgetBlocked;
				if (singleResult.toolBudget) state.statusPayload.toolBudget = singleResult.toolBudget;
				if (singleResult.toolBudgetBlocked) state.statusPayload.toolBudgetBlocked = true;
				if (singleResult.turnBudget) state.statusPayload.turnBudget = singleResult.turnBudget;
				if (singleResult.turnBudgetExceeded) state.statusPayload.turnBudgetExceeded = true;
				if (singleResult.wrapUpRequested) state.statusPayload.wrapUpRequested = true;
				state.statusPayload.steps[fi].model = singleResult.model;
				state.statusPayload.steps[fi].thinking = resolveEffectiveThinking(singleResult.model, state.statusPayload.steps[fi].thinking);
				state.statusPayload.steps[fi].attemptedModels = singleResult.attemptedModels;
				state.statusPayload.steps[fi].modelAttempts = singleResult.modelAttempts;
				state.statusPayload.steps[fi].totalCost = singleResult.totalCost;
				state.statusPayload.steps[fi].error = state.timedOut ? (state.timeoutMessage ?? "Subagent timed out.") : singleResult.error;
				state.statusPayload.steps[fi].transcriptPath = singleResult.transcriptPath ?? state.statusPayload.steps[fi].transcriptPath;
				state.statusPayload.steps[fi].transcriptError = singleResult.transcriptError;
				state.statusPayload.steps[fi].structuredOutput = singleResult.structuredOutput;
				state.statusPayload.steps[fi].structuredOutputPath = singleResult.structuredOutputPath;
				state.statusPayload.steps[fi].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
				state.statusPayload.steps[fi].acceptance = singleResult.acceptance;
				state.statusPayload.lastUpdate = taskEndTime;
				ops.writeStatusPayload();

				appendJsonl(state.eventsPath, JSON.stringify({
					type: state.timedOut ? "subagent.step.failed" : childInterrupted ? "subagent.step.paused" : singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
					ts: taskEndTime, runId: state.id, stepIndex: fi, agent: task.agent,
					exitCode: state.timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode, durationMs: taskDuration,
				}));
				if (singleResult.completionGuardTriggered) {
					ops.appendControlEvent(buildControlEvent({
						from: state.statusPayload.steps[fi].activityState,
						to: "needs_attention",
						runId: state.id,
						agent: task.agent,
						index: fi,
						ts: taskEndTime,
						message: `${task.agent} completed without making edits for an implementation task`,
						reason: "completion_guard",
					}));
				}

				if (singleResult.exitCode !== 0 && failFast) aborted = true;
				return state.timedOut ? { ...singleResult, output: state.timeoutMessage ?? "Subagent timed out.", error: state.timeoutMessage ?? "Subagent timed out.", exitCode: 1, interrupted: false, timedOut: true, skipped: false } : { ...singleResult, skipped: false };
			},
			state.globalSemaphore,
		);

		const nextFlatIndex = flatIndex + group.parallel.length;

		collectParallelGroupResults(state, ops, group, stepIndex, groupStartFlatIndex, parallelResults, worktreeSetup);

		appendJsonl(state.eventsPath, JSON.stringify({
			type: "subagent.parallel.completed",
			ts: Date.now(),
			runId: state.id,
			stepIndex,
			success: parallelResults.every((r) => r.exitCode === 0 || r.exitCode === -1),
		}));

		if (parallelResults.some((r) => r.exitCode !== 0 && r.exitCode !== -1)) {
			return { nextFlatIndex, breakLoop: true };
		}
		return { nextFlatIndex, breakLoop: false };
	} finally {
		if (worktreeSetup) cleanupWorktrees(worktreeSetup);
	}
}
