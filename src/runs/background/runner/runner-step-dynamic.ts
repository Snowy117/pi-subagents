import * as path from "node:path";
import { acceptanceFailureMessage, aggregateAcceptanceReport, evaluateAcceptance } from "../../shared/acceptance.ts";
import { DynamicFanoutError, materializeDynamicParallelStep, validateDynamicCollection } from "../../shared/dynamic-fanout.ts";
import { resolveEffectiveThinking } from "../../../shared/model-info.ts";
import { applyThinkingSuffix } from "../../shared/pi-args.ts";
import { MAX_PARALLEL_CONCURRENCY, mapConcurrent, type DynamicRunnerGroup } from "../../shared/parallel-utils.ts";
import { appendJsonl } from "./event-logging.ts";
import { resetStepLiveDetail } from "./usage-helpers.ts";
import { resolveAsyncStepTranscriptPath } from "./parallel-helpers.ts";
import { stepSteerInboxDir } from "../control-channel.ts";
import { runSingleStep } from "./run-single-step.ts";
import { applyDynamicMaterialization, collectDynamicFanoutResults } from "./runner-dynamic-collection.ts";
import type { RunnerStatusStep } from "./types.ts";
import type { RunnerOps } from "./runner-ops.ts";
import type { RunnerState, StepOutcome } from "./runner-state.ts";

export async function runDynamicStep(state: RunnerState, ops: RunnerOps, step: DynamicRunnerGroup, stepIndex: number, flatIndex: number): Promise<StepOutcome> {
	const groupStartFlatIndex = flatIndex;
	let materialized: ReturnType<typeof materializeDynamicParallelStep>;
	try {
		materialized = materializeDynamicParallelStep(step as Parameters<typeof materializeDynamicParallelStep>[0], state.outputs, stepIndex, { maxItems: state.config.dynamicFanoutMaxItems, allowRunnerFields: true });
		if (materialized.collectedOnEmpty) validateDynamicCollection(step.collect.outputSchema, materialized.collectedOnEmpty);
	} catch (error) {
		const now = Date.now();
		const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
		state.statusPayload.state = "failed";
		state.statusPayload.error = message;
		state.statusPayload.currentStep = flatIndex;
		const placeholder = state.statusPayload.steps[groupStartFlatIndex];
		if (placeholder) {
			placeholder.status = "failed";
			placeholder.error = message;
			placeholder.startedAt = now;
			placeholder.endedAt = now;
			placeholder.durationMs = 0;
			placeholder.exitCode = 1;
		}
		state.statusPayload.lastUpdate = now;
		ops.markDynamicGraphGroup(stepIndex, "failed", message);
		ops.writeStatusPayload();
		state.results.push({ agent: step.parallel.agent, output: message, error: message, success: false, exitCode: 1 });
		return { nextFlatIndex: flatIndex, breakLoop: true };
	}

	if (materialized.parallel.length === 0) {
		const now = Date.now();
		const collection = materialized.collectedOnEmpty ?? [];
		state.outputs[step.collect.as] = {
			text: JSON.stringify(collection),
			structured: collection,
			agent: step.parallel.agent,
			stepIndex,
		};
		state.statusPayload.outputs = state.outputs;
		const placeholder = state.statusPayload.steps[groupStartFlatIndex];
		if (placeholder) {
			placeholder.status = "complete";
			placeholder.startedAt = now;
			placeholder.endedAt = now;
			placeholder.durationMs = 0;
		}
		state.previousOutput = "Dynamic fanout produced 0 results.";
		const groupAcceptance = step.effectiveAcceptance?.explicit && !state.timedOut
			? await evaluateAcceptance({
				acceptance: step.effectiveAcceptance,
				output: "",
				report: aggregateAcceptanceReport({
					results: [],
					notes: "Dynamic fanout produced 0 results.",
				}),
				cwd: state.cwd,
				signal: state.timeoutAbortController.signal,
				abortMessage: state.timeoutMessage ?? "Subagent timed out.",
			})
			: undefined;
		const groupTimedOut = state.timedOut || state.timeoutAbortController.signal.aborted;
		const effectiveGroupAcceptance = groupTimedOut ? undefined : groupAcceptance;
		if (placeholder && effectiveGroupAcceptance) placeholder.acceptance = effectiveGroupAcceptance;
		const groupAcceptanceFailure = effectiveGroupAcceptance ? acceptanceFailureMessage(effectiveGroupAcceptance) : undefined;
		if (groupTimedOut || groupAcceptanceFailure) {
			const errorMessage = groupTimedOut ? state.timeoutMessage ?? "Subagent timed out." : groupAcceptanceFailure!;
			state.statusPayload.state = "failed";
			state.statusPayload.error = errorMessage;
			if (placeholder) {
				placeholder.status = "failed";
				placeholder.error = errorMessage;
				placeholder.exitCode = 1;
				placeholder.timedOut = groupTimedOut ? true : undefined;
			}
			ops.markDynamicGraphGroup(stepIndex, "failed", errorMessage, effectiveGroupAcceptance);
			state.statusPayload.lastUpdate = Date.now();
			ops.writeStatusPayload();
			state.results.push({ agent: step.parallel.agent, output: errorMessage, error: errorMessage, success: false, exitCode: 1, timedOut: groupTimedOut ? true : undefined, acceptance: effectiveGroupAcceptance });
			return { nextFlatIndex: flatIndex, breakLoop: true };
		}
		state.statusPayload.lastUpdate = now;
		ops.markDynamicGraphGroup(stepIndex, "completed", undefined, effectiveGroupAcceptance);
		ops.writeStatusPayload();
		return { nextFlatIndex: flatIndex + 1, breakLoop: false };
	}

	const dynamicSteps = materialized.parallel.map((task, itemIndex) => {
		const thinkingOverride = step.thinkingOverrides?.[itemIndex];
		const model = thinkingOverride ? applyThinkingSuffix(step.parallel.model, thinkingOverride, true) : step.parallel.model;
		const thinking = thinkingOverride ? resolveEffectiveThinking(model, thinkingOverride) : undefined;
		return {
			...step.parallel,
			task: task.task ?? step.parallel.task,
			label: task.label ?? step.parallel.label,
			...(step.sessionFiles?.[itemIndex] ? { sessionFile: step.sessionFiles[itemIndex] } : {}),
			...(thinkingOverride ? {
				...(model ? { model } : {}),
				...(thinking ? { thinking } : {}),
				...(step.parallel.modelCandidates ? { modelCandidates: step.parallel.modelCandidates.map((candidate) => applyThinkingSuffix(candidate, thinkingOverride, true)) } : {}),
			} : {}),
			structuredOutput: undefined,
			structuredOutputSchema: step.parallel.structuredOutputSchema ?? step.parallel.structuredOutput?.schema,
		};
	});
	const dynamicFlatStepCount = Math.max(state.statusPayload.steps.length - 1 + dynamicSteps.length, 1);
	const dynamicStatusSteps: RunnerStatusStep[] = dynamicSteps.map((task, itemIndex) => {
		const transcriptPath = resolveAsyncStepTranscriptPath({ artifactsDir: state.artifactsDir, artifactConfig: state.artifactConfig, runId: state.id, agent: task.agent, flatIndex: groupStartFlatIndex + itemIndex, flatStepCount: dynamicFlatStepCount });
		return {
			agent: task.agent,
			phase: task.phase ?? step.phase,
			label: task.label,
			outputName: undefined,
			structured: Boolean(task.structuredOutputSchema),
			status: "pending",
			...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
			...(transcriptPath ? { transcriptPath } : {}),
			skills: task.skills,
			model: task.model,
			thinking: task.thinking,
			attemptedModels: task.modelCandidates && task.modelCandidates.length > 0 ? task.modelCandidates : task.model ? [task.model] : undefined,
			recentTools: [],
			recentOutput: [],
		};
	});
	applyDynamicMaterialization(state, ops, step, stepIndex, groupStartFlatIndex, materialized, dynamicSteps, dynamicStatusSteps);

	const concurrency = step.concurrency ?? MAX_PARALLEL_CONCURRENCY;
	const failFast = step.failFast ?? false;
	let aborted = false;
	const parallelResults = await mapConcurrent(dynamicSteps, concurrency, async (task, taskIdx) => {
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
			state.statusPayload.lastUpdate = skippedAt;
			ops.writeStatusPayload();
			return { agent: task.agent, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true };
		}
		const taskStartTime = Date.now();
		state.statusPayload.currentStep = fi;
		state.statusPayload.steps[fi].status = "running";
		state.statusPayload.steps[fi].error = undefined;
		state.statusPayload.steps[fi].activityState = undefined;
		resetStepLiveDetail(state.statusPayload.steps[fi]);
		state.statusPayload.steps[fi].startedAt = taskStartTime;
		state.statusPayload.steps[fi].lastActivityAt = taskStartTime;
		state.statusPayload.outputFile = path.join(state.asyncDir, `output-${fi}.log`);
		state.statusPayload.lastActivityAt = taskStartTime;
		state.statusPayload.lastUpdate = taskStartTime;
		ops.writeStatusPayload();
		appendJsonl(state.eventsPath, JSON.stringify({ type: "subagent.step.started", ts: taskStartTime, runId: state.id, stepIndex: fi, agent: task.agent }));
		ops.flushPendingStepSteers(fi);
		const singleResult = await runSingleStep(task, {
			previousOutput: state.previousOutput, placeholder: state.placeholder, cwd: state.cwd, sessionEnabled: state.sessionEnabled,
			outputs: state.outputs,
			sessionDir: state.config.sessionDir ? path.join(state.config.sessionDir, `dynamic-${stepIndex}-${taskIdx}`) : undefined,
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
		const taskEndTime = Date.now();
		const childInterrupted = singleResult.interrupted === true;
		state.statusPayload.steps[fi].status = state.timedOut ? "failed" : childInterrupted ? "paused" : singleResult.exitCode === 0 ? "complete" : "failed";
		state.statusPayload.steps[fi].endedAt = taskEndTime;
		state.statusPayload.steps[fi].durationMs = taskEndTime - taskStartTime;
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
			exitCode: state.timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode, durationMs: taskEndTime - taskStartTime,
		}));
		if (singleResult.exitCode !== 0 && failFast) aborted = true;
		return state.timedOut ? { ...singleResult, output: state.timeoutMessage ?? "Subagent timed out.", error: state.timeoutMessage ?? "Subagent timed out.", exitCode: 1, interrupted: false, timedOut: true, skipped: false } : { ...singleResult, skipped: false };
	}, state.globalSemaphore);

	const nextFlatIndex = flatIndex + dynamicSteps.length;
	for (const pr of parallelResults) {
		state.results.push({
			agent: pr.agent,
			output: pr.output,
			error: pr.error,
			success: pr.interrupted !== true && pr.exitCode === 0,
			exitCode: pr.interrupted === true ? 0 : pr.exitCode,
			skipped: pr.skipped,
			interrupted: pr.interrupted,
			timedOut: pr.timedOut,
			turnBudget: pr.turnBudget,
			turnBudgetExceeded: pr.turnBudgetExceeded,
			wrapUpRequested: pr.wrapUpRequested,
			toolBudget: pr.toolBudget,
			toolBudgetBlocked: pr.toolBudgetBlocked,
			sessionFile: pr.sessionFile,
			intercomTarget: pr.intercomTarget,
			model: pr.model,
			attemptedModels: pr.attemptedModels,
			modelAttempts: pr.modelAttempts,
			totalCost: pr.totalCost,
			artifactPaths: pr.artifactPaths,
			transcriptPath: pr.transcriptPath,
			transcriptError: pr.transcriptError,
			structuredOutput: pr.structuredOutput,
			structuredOutputPath: pr.structuredOutputPath,
			structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
			acceptance: pr.acceptance,
		});
	}
	return await collectDynamicFanoutResults(state, ops, step, stepIndex, materialized, parallelResults, nextFlatIndex);
}
