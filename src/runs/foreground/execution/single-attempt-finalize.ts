import { existsSync } from "node:fs";
import { buildControlEvent } from "../../shared/subagent-control.ts";
import { evaluateCompletionMutationGuard } from "../../shared/completion-guard.ts";
import type { SingleResult } from "../../../shared/types.ts";
import type { SingleAttemptState } from "./single-attempt-state.ts";
import {
	acceptanceOutputByResult,
	artifactOutputByResult,
	formatTimeoutMessage,
	snapshotProgress,
	snapshotResult,
} from "./attempt-helpers.ts";
import { stripAcceptanceReport } from "../../shared/acceptance.ts";
import { formatSavedOutputReference, resolveSingleOutput } from "../../shared/single-output.ts";
import { formatTurnBudgetOutput, turnBudgetExceededMessage, turnBudgetSoftNote } from "../../shared/turn-budget.ts";
import { detectSubagentError, getFinalOutput } from "../../../shared/utils.ts";
import { readStructuredOutput } from "../../shared/structured-output.ts";

/**
 * Finalize a `SingleResult` after the child process has exited. Pure
 * synchronous post-processing: error/subagent-error detection, structured
 * output parsing, timeout/budget output framing, completion-guard evaluation,
 * and the final onUpdate snapshot. Reads shared mutable state from the
 * `state` object; no concurrent mutation happens here (the process is gone).
 */
export function finalizeSingleAttempt(state: SingleAttemptState, exitCode: number): SingleResult {
	const { result, progress, options, agent, shared } = state;
	result.exitCode = exitCode;
	if (state.interruptedByControl) {
		result.exitCode = 0;
		result.interrupted = true;
		result.error = undefined;
		result.finalOutput = result.finalOutput || "Interrupted. Waiting for explicit next action.";
		result.controlEvents = state.allControlEvents.length ? state.allControlEvents : undefined;
		progress.activityState = undefined;
		progress.durationMs = Date.now() - state.startTime;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		return result;
	}
	if (result.detached) {
		result.exitCode = -2;
		result.finalOutput = "Detached for intercom coordination before task completion.";
		result.outputMode = options.outputMode ?? "inline";
		if (options.outputPath) {
			result.outputSaveError = "Output file was not finalized because the subagent detached for intercom coordination.";
		}
		return result;
	}

	if (result.error && result.exitCode === 0) {
		result.exitCode = 1;
	}
	if (result.exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages ?? []);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}
	if (result.exitCode === 0 && !result.error) {
		const finalText = getFinalOutput(result.messages ?? []);
		const missingStructuredOutput = options.structuredOutput
			? !existsSync(options.structuredOutput.outputPath)
			: false;
		if (!finalText?.trim() && (!options.structuredOutput || missingStructuredOutput)) {
			result.exitCode = 1;
			result.error = "Subagent produced no output (possible model cold-start or empty response).";
		}
	}
	if (options.structuredOutput && result.exitCode === 0 && !result.error) {
		const structured = readStructuredOutput({
			schema: options.structuredOutput.schema,
			schemaPath: options.structuredOutput.schemaPath,
			outputPath: options.structuredOutput.outputPath,
		});
		result.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
		result.structuredOutputPath = options.structuredOutput.outputPath;
		if (structured.error) {
			result.exitCode = 1;
			result.error = structured.error;
		} else {
			result.structuredOutput = structured.value;
		}
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - state.startTime;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) {
			progress.failedTool = progress.currentTool;
		}
	}

	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	const acceptanceOutput = getFinalOutput(result.messages ?? []);
	let fullOutput = stripAcceptanceReport(acceptanceOutput);
	if (result.timedOut) {
		const timeoutMessage = formatTimeoutMessage(options.timeoutMs ?? 0);
		fullOutput = fullOutput.trim()
			? `${timeoutMessage}\n\nPartial output before timeout:\n${fullOutput}`
			: timeoutMessage;
	} else if (result.turnBudgetExceeded && result.turnBudget) {
		fullOutput = formatTurnBudgetOutput(turnBudgetExceededMessage(result.turnBudget, result.turnBudget.turnCount), fullOutput);
	} else if (result.wrapUpRequested && result.turnBudget?.outcome === "wrap-up-requested") {
		const note = turnBudgetSoftNote(result.turnBudget, result.turnBudget.wrapUpRequestedAtTurn ?? result.turnBudget.turnCount);
		fullOutput = fullOutput.trim() ? `${note}\n\n${fullOutput}` : note;
	}
	const completionGuard = result.exitCode === 0 && !result.error && agent.completionGuard !== false
		? evaluateCompletionMutationGuard({
			agent: agent.name,
			task: shared.originalTask ?? state.task,
			messages: result.messages ?? [],
			tools: agent.tools,
			mcpDirectTools: agent.mcpDirectTools,
		})
		: undefined;
	if (completionGuard?.triggered && !state.observedMutationAttempt) {
		result.exitCode = 1;
		result.error = "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.";
		progress.status = "failed";
		progress.error = result.error;
		state.emitControlEvent(buildControlEvent({
			from: progress.activityState,
			to: "needs_attention",
			runId: options.runId ?? agent.name,
			agent: agent.name,
			index: options.index,
			ts: Date.now(),
			message: `${agent.name} completed without making edits for an implementation task`,
			reason: "completion_guard",
		}));
	}
	if (options.outputPath && result.exitCode === 0) {
		const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, shared.outputSnapshot);
		fullOutput = stripAcceptanceReport(resolvedOutput.fullOutput);
		result.savedOutputPath = resolvedOutput.savedPath;
		result.outputSaveError = resolvedOutput.saveError;
		if (resolvedOutput.savedPath) {
			result.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
		}
	}
	artifactOutputByResult.set(result, fullOutput);
	acceptanceOutputByResult.set(result, acceptanceOutput);
	result.outputMode = options.outputMode ?? "inline";
	result.finalOutput = options.outputMode === "file-only" && result.savedOutputPath && result.outputReference
		? result.outputReference.message
		: fullOutput;
	result.controlEvents = state.allControlEvents.length ? state.allControlEvents : undefined;
	if (options.onUpdate) {
		const finalText = result.finalOutput || result.error || "(no output)";
		const progressSnapshot = snapshotProgress(progress);
		const resultSnapshot = snapshotResult(result, progressSnapshot);
		options.onUpdate({
			content: [{ type: "text", text: finalText }],
			details: {
				mode: "single",
				results: [resultSnapshot],
				progress: [progressSnapshot],
				controlEvents: state.allControlEvents.length ? state.allControlEvents : undefined,
			},
		});
	}
	return result;
}
