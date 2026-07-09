import * as path from "node:path";
import { parseSessionTokens } from "../../../shared/session-tokens.ts";
import { aggregateParallelOutputs, type ParallelStepGroup } from "../../shared/parallel-utils.ts";
import { outputEntryFromAsyncResult } from "../../shared/chain-outputs.ts";
import { appendParallelWorktreeSummary } from "./parallel-helpers.ts";
import { tokenUsageFromAttempts } from "./usage-helpers.ts";
import type { WorktreeSetup } from "../../shared/worktree.ts";
import type { SingleStepResult } from "./run-single-step.ts";
import type { RunnerOps } from "./runner-ops.ts";
import type { RunnerState } from "./runner-state.ts";

export function collectParallelGroupResults(
	state: RunnerState,
	ops: RunnerOps,
	group: ParallelStepGroup,
	stepIndex: number,
	groupStartFlatIndex: number,
	parallelResults: SingleStepResult[],
	worktreeSetup: WorktreeSetup | undefined,
): void {
	for (let t = 0; t < group.parallel.length; t++) {
		const fi = groupStartFlatIndex + t;
		const sessionTokens = state.config.sessionDir
			? parseSessionTokens(path.join(state.config.sessionDir, `parallel-${t}`))
			: null;
		const taskTokens = sessionTokens ?? tokenUsageFromAttempts(parallelResults[t]?.modelAttempts);
		if (!taskTokens) continue;
		state.statusPayload.steps[fi].tokens = taskTokens;
		state.previousCumulativeTokens = {
			input: state.previousCumulativeTokens.input + taskTokens.input,
			output: state.previousCumulativeTokens.output + taskTokens.output,
			total: state.previousCumulativeTokens.total + taskTokens.total,
		};
	}
	state.statusPayload.totalTokens = { ...state.previousCumulativeTokens };
	state.statusPayload.lastUpdate = Date.now();
	ops.writeStatusPayload();

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
	for (let t = 0; t < group.parallel.length; t++) {
		const outputName = group.parallel[t]?.outputName;
		if (outputName) state.outputs[outputName] = outputEntryFromAsyncResult({
			agent: parallelResults[t]!.agent,
			output: parallelResults[t]!.output,
			structuredOutput: parallelResults[t]!.structuredOutput,
		}, stepIndex);
	}
	state.statusPayload.outputs = state.outputs;

	state.previousOutput = aggregateParallelOutputs(
		parallelResults.map((r) => ({
			agent: r.agent,
			output: r.output,
			exitCode: r.exitCode,
			error: r.error,
			model: r.model,
			attemptedModels: r.attemptedModels,
		})),
	);
	state.previousOutput = appendParallelWorktreeSummary(state.previousOutput, worktreeSetup, state.asyncDir, stepIndex, group);
}
