import * as path from "node:path";
import { writeAtomicJson } from "../../../shared/atomic-json.ts";
import { turnBudgetExceededMessage } from "../../shared/turn-budget.ts";
import { DEFAULT_MAX_OUTPUT, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, truncateOutput, type CostSummary } from "../../../shared/types.ts";
import { findLatestSessionFile } from "./usage-helpers.ts";
import { createShareLink, exportSessionHtml } from "./share-export.ts";
import { writeRunLog } from "./run-log.ts";
import { appendJsonl } from "./event-logging.ts";
import type { RunnerOps } from "./runner-ops.ts";
import type { RunnerState } from "./runner-state.ts";

export async function finalizeRun(state: RunnerState, ops: RunnerOps, disposeControlInbox: () => void): Promise<void> {
	const { results, config, statusPayload } = state;
	let summary = results.map((r) => `${r.agent}:\n${r.output}`).join("\n\n");
	let truncated = false;

	if (state.maxOutput) {
		const maxOutputConfig = { ...DEFAULT_MAX_OUTPUT, ...state.maxOutput };
		const lastArtifactPath = results[results.length - 1]?.artifactPaths?.outputPath;
		const truncResult = truncateOutput(summary, maxOutputConfig, lastArtifactPath);
		if (truncResult.truncated) {
			summary = truncResult.text;
			truncated = true;
		}
	}

	const resultMode = config.resultMode ?? statusPayload.mode;
	const totalCost = results.reduce<CostSummary>((sum, result) => ({
		inputTokens: sum.inputTokens + (result.totalCost?.inputTokens ?? 0),
		outputTokens: sum.outputTokens + (result.totalCost?.outputTokens ?? 0),
		costUsd: sum.costUsd + (result.totalCost?.costUsd ?? 0),
	}), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
	const finalTotalCost = totalCost.inputTokens > 0 || totalCost.outputTokens > 0 || totalCost.costUsd > 0 ? totalCost : undefined;
	const finalFlatAgents = statusPayload.steps.map((step) => step.agent);
	const agentName = finalFlatAgents.length === 1
		? finalFlatAgents[0]!
		: resultMode === "parallel"
			? `parallel:${finalFlatAgents.join("+")}`
			: `chain:${finalFlatAgents.join("->")}`;
	let sessionFile: string | undefined;
	let shareUrl: string | undefined;
	let gistUrl: string | undefined;
	let shareError: string | undefined;

	if (state.shareEnabled) {
		sessionFile = config.sessionDir
			? (findLatestSessionFile(config.sessionDir) ?? undefined)
			: undefined;
		if (!sessionFile && state.latestSessionFile) {
			sessionFile = state.latestSessionFile;
		}
		if (sessionFile) {
			try {
				const exportDir = config.sessionDir ?? path.dirname(sessionFile);
				const htmlPath = await exportSessionHtml(sessionFile, exportDir, config.piPackageRoot);
				const share = createShareLink(htmlPath);
				if ("error" in share) shareError = share.error;
				else {
					shareUrl = share.shareUrl;
					gistUrl = share.gistUrl;
				}
			} catch (err) {
				shareError = String(err);
			}
		} else {
			shareError = "Session file not found.";
		}
	}

	if (state.activityTimer) {
		clearInterval(state.activityTimer);
		state.activityTimer = undefined;
	}
	if (state.timeoutTimer) {
		clearTimeout(state.timeoutTimer);
		state.timeoutTimer = undefined;
	}
	disposeControlInbox();
	const effectiveSessionFile = sessionFile ?? state.latestSessionFile;
	const runEndedAt = Date.now();
	statusPayload.state = state.timedOut || state.turnBudgetExceeded ? "failed" : state.interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed";
	statusPayload.activityState = undefined;
	if (state.timedOut) {
		statusPayload.timedOut = true;
		statusPayload.error = state.timeoutMessage ?? "Subagent timed out.";
	}
	if (state.turnBudgetExceeded && !statusPayload.error) {
		const budget = statusPayload.turnBudget;
		statusPayload.error = budget ? turnBudgetExceededMessage(budget, budget.turnCount) : "Subagent exceeded turn budget.";
	}
	statusPayload.endedAt = runEndedAt;
	statusPayload.lastUpdate = runEndedAt;
	statusPayload.sessionFile = effectiveSessionFile;
	statusPayload.totalCost = finalTotalCost;
	statusPayload.shareUrl = shareUrl;
	statusPayload.gistUrl = gistUrl;
	statusPayload.shareError = shareError;
	if (statusPayload.state === "failed" && !statusPayload.error) {
		const failedStep = statusPayload.steps.find((s) => s.status === "failed");
		if (failedStep?.agent) {
			statusPayload.error = `Step failed: ${failedStep.agent}`;
		}
	}
	ops.writeStatusPayload();
	appendJsonl(
		state.eventsPath,
		JSON.stringify({
			type: "subagent.run.completed",
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			ts: runEndedAt,
			runId: state.id,
			status: statusPayload.state,
			durationMs: runEndedAt - state.overallStartTime,
			totalTokens: statusPayload.totalTokens,
			totalCost: finalTotalCost,
		}),
	);
	writeRunLog(state.logPath, {
		id: state.id,
		mode: statusPayload.mode,
		cwd: state.cwd,
		startedAt: state.overallStartTime,
		endedAt: runEndedAt,
		steps: statusPayload.steps.map((step) => ({
			agent: step.agent,
			status: step.status,
			durationMs: step.durationMs,
		})),
		summary,
		truncated,
		artifactsDir: state.artifactsDir,
		sessionFile: effectiveSessionFile,
		shareUrl,
		shareError,
	});

	try {
		writeAtomicJson(config.resultPath, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id: state.id,
			agent: agentName,
			mode: resultMode,
			success: !state.timedOut && !state.turnBudgetExceeded && !state.interrupted && results.every((r) => r.success),
			state: state.timedOut || state.turnBudgetExceeded ? "failed" : state.interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed",
			summary: state.timedOut ? (state.timeoutMessage ?? "Subagent timed out.") : state.turnBudgetExceeded ? (statusPayload.error ?? "Subagent exceeded turn budget.") : state.interrupted ? "Paused after interrupt. Waiting for explicit next action." : summary,
			...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
			...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
			...(statusPayload.turnBudget ? { turnBudget: statusPayload.turnBudget } : {}),
			...(statusPayload.turnBudgetExceeded ? { turnBudgetExceeded: true } : {}),
			...(statusPayload.wrapUpRequested ? { wrapUpRequested: true } : {}),
			...(statusPayload.toolBudget ? { toolBudget: statusPayload.toolBudget } : {}),
			...(statusPayload.toolBudgetBlocked ? { toolBudgetBlocked: true } : {}),
			...(state.timedOut ? { timedOut: true, error: state.timeoutMessage ?? "Subagent timed out." } : state.turnBudgetExceeded ? { error: statusPayload.error ?? "Subagent exceeded turn budget." } : {}),
			results: results.map((r) => ({
				agent: r.agent,
				output: r.output,
				error: r.error,
				success: r.success,
				skipped: r.skipped || undefined,
				interrupted: r.interrupted || undefined,
				timedOut: r.timedOut || undefined,
				turnBudget: r.turnBudget,
				turnBudgetExceeded: r.turnBudgetExceeded || undefined,
				wrapUpRequested: r.wrapUpRequested || undefined,
				toolBudget: r.toolBudget,
				toolBudgetBlocked: r.toolBudgetBlocked || undefined,
				sessionFile: r.sessionFile,
				intercomTarget: r.intercomTarget,
				model: r.model,
				attemptedModels: r.attemptedModels,
				modelAttempts: r.modelAttempts,
				totalCost: r.totalCost,
				artifactPaths: r.artifactPaths,
				truncated: r.truncated,
				transcriptPath: r.transcriptPath,
				transcriptError: r.transcriptError,
				structuredOutput: r.structuredOutput,
				structuredOutputPath: r.structuredOutputPath,
				structuredOutputSchemaPath: r.structuredOutputSchemaPath,
				acceptance: r.acceptance,
			})),
			outputs: state.outputs,
			workflowGraph: statusPayload.workflowGraph,
			exitCode: state.timedOut || state.turnBudgetExceeded ? 1 : state.interrupted || results.every((r) => r.success) ? 0 : 1,
			timestamp: runEndedAt,
			durationMs: runEndedAt - state.overallStartTime,
			totalTokens: statusPayload.totalTokens,
			totalCost: finalTotalCost,
			truncated,
			artifactsDir: state.artifactsDir,
			cwd: state.cwd,
			asyncDir: state.asyncDir,
			sessionId: config.sessionId,
			sessionFile: effectiveSessionFile,
			intercomTarget: config.controlIntercomTarget,
			shareUrl,
			gistUrl,
			shareError,
			...(state.taskIndex !== undefined && { taskIndex: state.taskIndex }),
			...(state.totalTasks !== undefined && { totalTasks: state.totalTasks }),
		});
	} catch (err) {
		console.error(`Failed to write result file ${config.resultPath}:`, err);
	}
}
