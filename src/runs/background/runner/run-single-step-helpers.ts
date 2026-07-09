/** run-single-step-helpers (split from run-single-step.ts; internal-only). */

import * as fs from "node:fs";
import { deliverTimeoutRequest } from "../control-channel.ts";
import { waitForImportedAsyncRoot } from "../chain-root-attachment.ts";
import { readStatus } from "../../../shared/utils.ts";
import { type StructuredOutputRuntime } from "../../shared/structured-output.ts";
import { type ChildTranscriptWriter } from "../../../shared/child-transcript.ts";
import { buildPiArgs } from "../../shared/pi-args.ts";
import { appendTurnBudgetSystemPrompt } from "../../shared/turn-budget.ts";
import { costSummaryFromAttempts } from "./usage-helpers.ts";
import type { AcceptanceLedger, ArtifactPaths, ModelAttempt, ToolBudgetState, TurnBudgetState } from "../../../shared/types.ts";
import type { RunPiStreamingResult, SingleStepContext } from "./types.ts";
import type { RunnerSubagentStep as SubagentStep } from "../../shared/parallel-utils.ts";


export async function runImportedAsyncRootStep(
	step: SubagentStep,
	ctx: SingleStepContext,
) {
	if (!step.importAsyncRoot) return undefined;
	let importTimedOut = false;
	ctx.registerTimeout?.(() => {
		importTimedOut = true;
		let pid: number | undefined;
		try {
			pid = readStatus(step.importAsyncRoot!.asyncDir)?.pid;
		} catch {
			pid = undefined;
		}
		try {
			deliverTimeoutRequest({ asyncDir: step.importAsyncRoot!.asyncDir, pid, source: "ancestor-timeout" });
		} catch {
			// The parent runner's own timeout result is authoritative for the attached step.
		}
	});
	try {
		const imported = await waitForImportedAsyncRoot(step.importAsyncRoot, {
			shouldAbort: () => importTimedOut || ctx.timeoutSignal?.aborted === true || ctx.skipAcceptance?.() === true,
			timeoutMessage: ctx.timeoutMessage,
		});
		try {
			fs.writeFileSync(ctx.outputFile, imported.output, "utf-8");
		} catch {
			// Output files are observability only for imported roots.
		}
		const timedOut = importTimedOut || imported.timedOut === true || ctx.timeoutSignal?.aborted === true || ctx.skipAcceptance?.() === true;
		return {
			agent: imported.agent,
			output: timedOut ? ctx.timeoutMessage ?? "Subagent timed out." : imported.output,
			exitCode: timedOut ? 1 : imported.exitCode,
			error: timedOut ? ctx.timeoutMessage ?? "Subagent timed out." : imported.error,
			timedOut: timedOut ? true : undefined,
			sessionFile: imported.sessionFile,
			intercomTarget: imported.intercomTarget,
			model: imported.model,
			attemptedModels: imported.attemptedModels,
			modelAttempts: imported.modelAttempts,
			totalCost: imported.totalCost,
			structuredOutput: timedOut ? undefined : imported.structuredOutput,
			structuredOutputPath: timedOut ? undefined : imported.structuredOutputPath,
			structuredOutputSchemaPath: timedOut ? undefined : imported.structuredOutputSchemaPath,
			acceptance: timedOut ? undefined : imported.acceptance,
		};
	} finally {
		ctx.registerTimeout?.(undefined);
	}
}


export function buildStepPiArgs(
	step: SubagentStep,
	ctx: SingleStepContext,
	locals: {
		candidate: string | undefined;
		effectiveStructuredOutput: StructuredOutputRuntime | undefined;
		sessionEnabled: boolean;
		sessionDir: string | undefined;
		task: string;
	},
) {
	const { candidate, effectiveStructuredOutput, sessionEnabled, sessionDir, task } = locals;
	return buildPiArgs({
		parentSessionId: step.parentSessionId,
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled,
		sessionDir,
		sessionFile: step.sessionFile,
		model: candidate,
		inheritProjectContext: step.inheritProjectContext,
		inheritSkills: step.inheritSkills,
		requireReadTool: Boolean(step.skills?.length),
		tools: step.tools,
		extensions: step.extensions,
		subagentOnlyExtensions: step.subagentOnlyExtensions,
		systemPrompt: appendTurnBudgetSystemPrompt(step.systemPrompt ?? "", ctx.turnBudget),
		systemPromptMode: step.systemPromptMode,
		mcpDirectTools: step.mcpDirectTools,
		cwd: step.cwd ?? ctx.cwd,
		promptFileStem: step.agent,
		intercomSessionName: ctx.childIntercomTarget,
		orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
		runId: ctx.id,
		childAgentName: step.agent,
		childIndex: ctx.flatIndex,
		parentEventSink: ctx.nestedRoute?.eventSink,
		parentControlInbox: ctx.nestedRoute?.controlInbox,
		parentRootRunId: ctx.nestedRoute?.rootRunId,
		parentCapabilityToken: ctx.nestedRoute?.capabilityToken,
		steerInboxDir: ctx.steerInboxDir,
		structuredOutput: effectiveStructuredOutput,
		toolBudget: step.toolBudget,
	});
}


export function writeStepArtifactFiles(opts: {
	artifactPaths: ArtifactPaths;
	ctx: SingleStepContext;
	step: SubagentStep;
	output: string;
	effectiveFinalExitCode: number;
	finalResult: RunPiStreamingResult | undefined;
	attemptedModels: string[];
	modelAttempts: ModelAttempt[];
	transcriptWriter: ChildTranscriptWriter | undefined;
	task: string;
}): void {
	const { artifactPaths, ctx, step, output, effectiveFinalExitCode, finalResult, attemptedModels, modelAttempts, transcriptWriter, task } = opts;
	if (ctx.artifactConfig?.enabled !== false) {
		if (ctx.artifactConfig?.includeOutput !== false) {
			fs.writeFileSync(artifactPaths.outputPath, output, "utf-8");
		}
		if (ctx.artifactConfig?.includeMetadata !== false) {
			fs.writeFileSync(
				artifactPaths.metadataPath,
				JSON.stringify({
					runId: ctx.id,
					agent: step.agent,
					task,
					exitCode: effectiveFinalExitCode,
					model: finalResult?.model,
					attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
					modelAttempts,
					...(transcriptWriter ? { transcriptPath: artifactPaths.transcriptPath } : {}),
					transcriptError: transcriptWriter?.getError(),
					skills: step.skills,
					timestamp: Date.now(),
				}, null, 2),
				"utf-8",
			);
		}
	}
}


export function buildSingleStepResult(opts: {
	step: SubagentStep;
	ctx: SingleStepContext;
	outputForSummary: string;
	effectiveFinalExitCode: number;
	effectiveFinalError: string | undefined;
	attemptedModels: string[];
	modelAttempts: ModelAttempt[];
	artifactPaths: ArtifactPaths | undefined;
	transcriptWriter: ChildTranscriptWriter | undefined;
	timedOutAfterAcceptance: boolean;
	turnBudgetExceeded: boolean;
	finalResult: RunPiStreamingResult | undefined;
	turnBudget: TurnBudgetState | undefined;
	toolBudget: ToolBudgetState | undefined;
	toolBudgetBlocked: boolean;
	completionGuardTriggeredFinal: boolean;
	effectiveStructuredOutput: StructuredOutputRuntime | undefined;
	effectiveAcceptance: AcceptanceLedger | undefined;
}) {
	const {
		step, ctx, outputForSummary, effectiveFinalExitCode, effectiveFinalError,
		attemptedModels, modelAttempts, artifactPaths, transcriptWriter,
		timedOutAfterAcceptance, turnBudgetExceeded, finalResult, turnBudget,
		toolBudget, toolBudgetBlocked, completionGuardTriggeredFinal,
		effectiveStructuredOutput, effectiveAcceptance,
	} = opts;
	return {
		agent: step.agent,
		output: outputForSummary,
		exitCode: effectiveFinalExitCode,
		error: effectiveFinalError,
		sessionFile: step.sessionFile,
		intercomTarget: ctx.childIntercomTarget,
		model: finalResult?.model,
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		modelAttempts,
		totalCost: costSummaryFromAttempts(modelAttempts),
		artifactPaths,
		transcriptPath: transcriptWriter ? artifactPaths?.transcriptPath : undefined,
		transcriptError: transcriptWriter?.getError(),
		interrupted: timedOutAfterAcceptance || turnBudgetExceeded ? false : finalResult?.interrupted,
		timedOut: timedOutAfterAcceptance ? true : finalResult?.timedOut,
		turnBudget,
		turnBudgetExceeded: turnBudgetExceeded || undefined,
		wrapUpRequested: finalResult?.wrapUpRequested || turnBudget?.outcome === "wrap-up-requested" || turnBudgetExceeded || undefined,
		toolBudget,
		toolBudgetBlocked: toolBudgetBlocked || undefined,
		completionGuardTriggered: completionGuardTriggeredFinal,
		structuredOutput: timedOutAfterAcceptance || turnBudgetExceeded ? undefined : (finalResult as (RunPiStreamingResult & { structuredOutput?: unknown }) | undefined)?.structuredOutput,
		structuredOutputPath: timedOutAfterAcceptance || turnBudgetExceeded ? undefined : effectiveStructuredOutput?.outputPath,
		structuredOutputSchemaPath: timedOutAfterAcceptance || turnBudgetExceeded ? undefined : effectiveStructuredOutput?.schemaPath,
		acceptance: effectiveAcceptance,
	};
}
