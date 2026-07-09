import * as path from "node:path";
import { parseSessionTokens } from "../../../shared/session-tokens.ts";
import { buildControlEvent } from "../../shared/subagent-control.ts";
import { resolveEffectiveThinking } from "../../../shared/model-info.ts";
import type { RunnerSubagentStep } from "../../shared/parallel-utils.ts";
import { outputEntryFromAsyncResult } from "../../shared/chain-outputs.ts";
import { appendJsonl } from "./event-logging.ts";
import { resetStepLiveDetail, tokenUsageFromAttempts } from "./usage-helpers.ts";
import { stepSteerInboxDir } from "../control-channel.ts";
import { runSingleStep } from "./run-single-step.ts";
import type { TokenUsage } from "../../../shared/types.ts";
import type { RunnerOps } from "./runner-ops.ts";
import type { RunnerState, StepOutcome } from "./runner-state.ts";

export async function runSequentialStep(state: RunnerState, ops: RunnerOps, seqStep: RunnerSubagentStep, stepIndex: number, flatIndex: number): Promise<StepOutcome> {
	const stepStartTime = Date.now();
	state.statusPayload.currentStep = flatIndex;
	state.statusPayload.steps[flatIndex].status = "running";
	state.statusPayload.steps[flatIndex].activityState = undefined;
	state.statusPayload.activityState = undefined;
	resetStepLiveDetail(state.statusPayload.steps[flatIndex]);
	state.statusPayload.steps[flatIndex].skills = seqStep.skills;
	state.statusPayload.steps[flatIndex].startedAt = stepStartTime;
	state.statusPayload.steps[flatIndex].lastActivityAt = stepStartTime;
	state.statusPayload.lastActivityAt = stepStartTime;
	state.statusPayload.lastUpdate = stepStartTime;
	state.statusPayload.outputFile = path.join(state.asyncDir, `output-${flatIndex}.log`);
	ops.writeStatusPayload();

	appendJsonl(state.eventsPath, JSON.stringify({
		type: "subagent.step.started",
		ts: stepStartTime,
		runId: state.id,
		stepIndex: flatIndex,
		agent: seqStep.agent,
	}));

	ops.flushPendingStepSteers(flatIndex);
	const singleResult = await runSingleStep(seqStep, {
		previousOutput: state.previousOutput, placeholder: state.placeholder, cwd: state.cwd, sessionEnabled: state.sessionEnabled,
		outputs: state.outputs,
		sessionDir: state.config.sessionDir,
		artifactsDir: state.artifactsDir, artifactConfig: state.artifactConfig, id: state.id,
		flatIndex, flatStepCount: Math.max(state.statusPayload.steps.length, 1),
		outputFile: path.join(state.asyncDir, `output-${flatIndex}.log`),
		steerInboxDir: stepSteerInboxDir(state.asyncDir, flatIndex),
		piPackageRoot: state.config.piPackageRoot,
		piArgv1: state.config.piArgv1,
		childIntercomTarget: state.config.childIntercomTargets?.[flatIndex],
		orchestratorIntercomTarget: state.config.controlIntercomTarget,
		nestedRoute: state.config.nestedRoute,
		registerInterrupt: (interrupt) => ops.registerStepInterrupt(flatIndex, interrupt),
		registerTimeout: (interrupt) => ops.registerStepTimeout(flatIndex, interrupt),
		registerTurnBudgetAbort: (abort) => ops.registerStepTurnBudgetAbort(flatIndex, abort),
		timeoutSignal: state.timeoutAbortController.signal,
		timeoutMessage: state.timeoutMessage,
		turnBudget: state.config.turnBudget,
		onAttemptStart: (attempt) => ops.updateStepModel(flatIndex, attempt.model, attempt.thinking),
		onChildEvent: (event) => ops.updateStepFromChildEvent(flatIndex, event),
		skipAcceptance: () => state.timedOut,
	});
	if (seqStep.sessionFile) {
		state.latestSessionFile = seqStep.sessionFile;
	}

	state.previousOutput = singleResult.output;
	state.results.push({
		agent: singleResult.agent,
		output: state.timedOut ? (state.timeoutMessage ?? "Subagent timed out.") : singleResult.output,
		error: state.timedOut ? (state.timeoutMessage ?? "Subagent timed out.") : singleResult.error,
		success: !state.timedOut && singleResult.interrupted !== true && singleResult.exitCode === 0,
		exitCode: state.timedOut ? 1 : singleResult.interrupted === true ? 0 : singleResult.exitCode,
		sessionFile: singleResult.sessionFile,
		intercomTarget: singleResult.intercomTarget,
		model: singleResult.model,
		attemptedModels: singleResult.attemptedModels,
		modelAttempts: singleResult.modelAttempts,
		totalCost: singleResult.totalCost,
		artifactPaths: singleResult.artifactPaths,
		transcriptPath: singleResult.transcriptPath,
		transcriptError: singleResult.transcriptError,
		structuredOutput: singleResult.structuredOutput,
		structuredOutputPath: singleResult.structuredOutputPath,
		structuredOutputSchemaPath: singleResult.structuredOutputSchemaPath,
		acceptance: singleResult.acceptance,
		interrupted: singleResult.interrupted,
		timedOut: state.timedOut || singleResult.timedOut ? true : undefined,
		turnBudget: singleResult.turnBudget,
		turnBudgetExceeded: singleResult.turnBudgetExceeded,
		wrapUpRequested: singleResult.wrapUpRequested,
		toolBudget: singleResult.toolBudget,
		toolBudgetBlocked: singleResult.toolBudgetBlocked,
	});
	if (seqStep.outputName) {
		state.outputs[seqStep.outputName] = outputEntryFromAsyncResult({
			agent: singleResult.agent,
			output: singleResult.output,
			structuredOutput: singleResult.structuredOutput,
		}, stepIndex);
	}
	state.statusPayload.outputs = state.outputs;

	const cumulativeTokens = state.config.sessionDir ? parseSessionTokens(state.config.sessionDir) : null;
	let stepTokens: TokenUsage | null = cumulativeTokens
		? {
				input: cumulativeTokens.input - state.previousCumulativeTokens.input,
				output: cumulativeTokens.output - state.previousCumulativeTokens.output,
				total: cumulativeTokens.total - state.previousCumulativeTokens.total,
			}
		: null;
	if (cumulativeTokens) {
		state.previousCumulativeTokens = cumulativeTokens;
	} else {
		stepTokens = tokenUsageFromAttempts(singleResult.modelAttempts);
		if (stepTokens) {
			state.previousCumulativeTokens = {
				input: state.previousCumulativeTokens.input + stepTokens.input,
				output: state.previousCumulativeTokens.output + stepTokens.output,
				total: state.previousCumulativeTokens.total + stepTokens.total,
			};
		}
	}

	const stepEndTime = Date.now();
	const childInterrupted = singleResult.interrupted === true;
	state.statusPayload.steps[flatIndex].status = state.timedOut ? "failed" : childInterrupted ? "paused" : singleResult.exitCode === 0 ? "complete" : "failed";
	state.statusPayload.steps[flatIndex].endedAt = stepEndTime;
	state.statusPayload.steps[flatIndex].durationMs = stepEndTime - stepStartTime;
	state.statusPayload.steps[flatIndex].exitCode = state.timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode;
	state.statusPayload.steps[flatIndex].timedOut = state.timedOut || singleResult.timedOut ? true : undefined;
	state.statusPayload.steps[flatIndex].turnBudget = singleResult.turnBudget;
	state.statusPayload.steps[flatIndex].turnBudgetExceeded = singleResult.turnBudgetExceeded;
	state.statusPayload.steps[flatIndex].wrapUpRequested = singleResult.wrapUpRequested;
	state.statusPayload.steps[flatIndex].toolBudget = singleResult.toolBudget;
	state.statusPayload.steps[flatIndex].toolBudgetBlocked = singleResult.toolBudgetBlocked;
	if (singleResult.toolBudget) state.statusPayload.toolBudget = singleResult.toolBudget;
	if (singleResult.toolBudgetBlocked) state.statusPayload.toolBudgetBlocked = true;
	if (singleResult.turnBudget) state.statusPayload.turnBudget = singleResult.turnBudget;
	if (singleResult.turnBudgetExceeded) state.statusPayload.turnBudgetExceeded = true;
	if (singleResult.wrapUpRequested) state.statusPayload.wrapUpRequested = true;
	state.statusPayload.steps[flatIndex].model = singleResult.model;
	state.statusPayload.steps[flatIndex].thinking = resolveEffectiveThinking(singleResult.model, state.statusPayload.steps[flatIndex].thinking);
	state.statusPayload.steps[flatIndex].attemptedModels = singleResult.attemptedModels;
	state.statusPayload.steps[flatIndex].modelAttempts = singleResult.modelAttempts;
	state.statusPayload.steps[flatIndex].totalCost = singleResult.totalCost;
	state.statusPayload.steps[flatIndex].error = state.timedOut ? (state.timeoutMessage ?? "Subagent timed out.") : singleResult.error;
	state.statusPayload.steps[flatIndex].transcriptPath = singleResult.transcriptPath ?? state.statusPayload.steps[flatIndex].transcriptPath;
	state.statusPayload.steps[flatIndex].transcriptError = singleResult.transcriptError;
	state.statusPayload.steps[flatIndex].structuredOutput = singleResult.structuredOutput;
	state.statusPayload.steps[flatIndex].structuredOutputPath = singleResult.structuredOutputPath;
	state.statusPayload.steps[flatIndex].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
	state.statusPayload.steps[flatIndex].acceptance = singleResult.acceptance;
	if (stepTokens) {
		state.statusPayload.steps[flatIndex].tokens = stepTokens;
		state.statusPayload.totalTokens = { ...state.previousCumulativeTokens };
	}
	state.statusPayload.lastUpdate = stepEndTime;
	ops.writeStatusPayload();

	appendJsonl(state.eventsPath, JSON.stringify({
		type: state.timedOut ? "subagent.step.failed" : childInterrupted ? "subagent.step.paused" : singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
		ts: stepEndTime,
		runId: state.id,
		stepIndex: flatIndex,
		agent: seqStep.agent,
		exitCode: state.timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode,
		durationMs: stepEndTime - stepStartTime,
		tokens: stepTokens,
	}));
	if (singleResult.completionGuardTriggered) {
		ops.appendControlEvent(buildControlEvent({
			from: state.statusPayload.steps[flatIndex].activityState,
			to: "needs_attention",
			runId: state.id,
			agent: seqStep.agent,
			index: flatIndex,
			ts: stepEndTime,
			message: `${seqStep.agent} completed without making edits for an implementation task`,
			reason: "completion_guard",
		}));
	}

	const nextFlatIndex = flatIndex + 1;
	if (singleResult.exitCode !== 0) {
		return { nextFlatIndex, breakLoop: true };
	}
	return { nextFlatIndex, breakLoop: false };
}
