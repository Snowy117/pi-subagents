import * as fs from "node:fs";
import * as path from "node:path";
import { detectSubagentError, extractTextFromContent } from "../../../shared/utils.ts";
import { resolveOutputReferences } from "../../shared/chain-outputs.ts";
import { createStructuredOutputRuntime, readStructuredOutput } from "../../shared/structured-output.ts";
import { getArtifactPaths } from "../../../shared/artifacts.ts";
import { createChildTranscriptWriter, type ChildTranscriptWriter } from "../../../shared/child-transcript.ts";
import { acceptanceFailureMessage, evaluateAcceptance, formatAcceptancePrompt, stripAcceptanceReport } from "../../shared/acceptance.ts";
import { cleanupTempDir } from "../../shared/pi-args.ts";
import { resolveEffectiveThinking } from "../../../shared/model-info.ts";
import { runPiStreaming } from "./run-pi-streaming.ts";
import { captureSingleOutputSnapshot, finalizeSingleOutput, formatSavedOutputReference, resolveSingleOutput, type SingleOutputSnapshot } from "../../shared/single-output.ts";
import { formatTurnBudgetOutput, initialTurnBudgetState, shouldAbortForTurnBudget, turnBudgetExceededMessage, turnBudgetSoftNote, turnBudgetState } from "../../shared/turn-budget.ts";
import { initialToolBudgetState, toolBudgetState } from "../../shared/tool-budget.ts";
import { evaluateCompletionMutationGuard } from "../../shared/completion-guard.ts";
import { formatModelAttemptNote, isRetryableModelFailure } from "../../shared/model-fallback.ts";
import { isTerminalAssistantStop } from "./usage-helpers.ts";
import type { ArtifactPaths, ModelAttempt, ToolBudgetState, TurnBudgetState } from "../../../shared/types.ts";
import type { RunPiStreamingResult, SingleStepContext } from "./types.ts";
import type { RunnerSubagentStep as SubagentStep } from "../../shared/parallel-utils.ts";
import { buildSingleStepResult, buildStepPiArgs, runImportedAsyncRootStep, writeStepArtifactFiles } from "./run-single-step-helpers.ts";

/** Run a single pi agent step, returning output and metadata */
export async function runSingleStep(
	step: SubagentStep,
	ctx: SingleStepContext,
): Promise<{
	agent: string;
	output: string;
	exitCode: number | null;
	error?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	transcriptPath?: string;
	transcriptError?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	completionGuardTriggered?: boolean;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: import("../../../shared/types.ts").AcceptanceLedger;
}> {
	const importedResult = await runImportedAsyncRootStep(step, ctx);
	if (importedResult) return importedResult;

	const effectiveStructuredOutput = step.structuredOutput ?? (step.structuredOutputSchema
		? createStructuredOutputRuntime(step.structuredOutputSchema, path.join(path.dirname(ctx.outputFile), "structured-output"))
		: undefined);
	const placeholderRegex = new RegExp(ctx.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
	let task = step.task.replace(placeholderRegex, () => ctx.previousOutput);
	task = resolveOutputReferences(task, ctx.outputs ?? {});
	const taskForCompletionGuard = task;
	if (step.effectiveAcceptance) {
		const acceptancePrompt = formatAcceptancePrompt(step.effectiveAcceptance);
		if (acceptancePrompt) task = `${task}\n${acceptancePrompt}`;
	}
	const sessionEnabled = Boolean(step.sessionFile) || ctx.sessionEnabled;
	const sessionDir = step.sessionFile ? undefined : ctx.sessionDir;

	let artifactPaths: ArtifactPaths | undefined;
	let transcriptWriter: ChildTranscriptWriter | undefined;
	if (ctx.artifactsDir && ctx.artifactConfig?.enabled !== false) {
		const index = ctx.flatStepCount > 1 ? ctx.flatIndex : undefined;
		artifactPaths = getArtifactPaths(ctx.artifactsDir, ctx.id, step.agent, index);
		fs.mkdirSync(ctx.artifactsDir, { recursive: true });
		if (ctx.artifactConfig?.includeInput !== false) {
			fs.writeFileSync(artifactPaths.inputPath, `# Task for ${step.agent}\n\n${task}`, "utf-8");
		}
		if (ctx.artifactConfig?.includeTranscript !== false) {
			transcriptWriter = createChildTranscriptWriter({
				transcriptPath: artifactPaths.transcriptPath,
				source: "async",
				runId: ctx.id,
				agent: step.agent,
				childIndex: ctx.flatIndex,
				cwd: step.cwd ?? ctx.cwd,
			});
		}
	}
	transcriptWriter?.writeInitialUserMessage(task);

	const candidates = step.modelCandidates && step.modelCandidates.length > 0
		? step.modelCandidates
		: step.model
			? [step.model]
			: [undefined];
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const attemptNotes: string[] = [];
	const eventsPath = path.join(path.dirname(ctx.outputFile), "events.jsonl");
	let finalResult: RunPiStreamingResult | undefined;
	let finalOutputSnapshot: SingleOutputSnapshot | undefined;
	let completionGuardTriggeredFinal = false;
	let turnBudget = ctx.turnBudget ? initialTurnBudgetState(ctx.turnBudget) : undefined;
	let toolBudget = step.toolBudget ? initialToolBudgetState(step.toolBudget) : undefined;
	let toolBudgetBlocked = false;

	for (let index = 0; index < candidates.length; index++) {
		if (ctx.timeoutSignal?.aborted || ctx.skipAcceptance?.()) break;
		const candidate = candidates[index];
		ctx.onAttemptStart?.({ model: candidate, thinking: resolveEffectiveThinking(candidate, step.thinking) });
		const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
		if (effectiveStructuredOutput) {
			try {
				if (fs.existsSync(effectiveStructuredOutput.outputPath)) fs.unlinkSync(effectiveStructuredOutput.outputPath);
			} catch {
				// Missing/stale structured-output files are handled after the child exits.
			}
		}
		const { args, env, tempDir } = buildStepPiArgs(step, ctx, { candidate, effectiveStructuredOutput, sessionEnabled, sessionDir, task });
		const run = await runPiStreaming(
			args,
			step.cwd ?? ctx.cwd,
			ctx.outputFile,
			env,
			ctx.piPackageRoot,
			ctx.piArgv1,
			step.maxSubagentDepth,
			{ eventsPath, runId: ctx.id, stepIndex: ctx.flatIndex, agent: step.agent },
			ctx.registerInterrupt,
			ctx.onChildEvent,
			transcriptWriter,
			ctx.registerTimeout,
			ctx.timeoutMessage,
			ctx.registerTurnBudgetAbort,
		);
		if (run.turnBudget) turnBudget = run.turnBudget;
		else if (ctx.turnBudget) {
			const assistantMessages = run.messages.filter((message) => message.role === "assistant");
			const turnCount = assistantMessages.length;
			const lastAssistantMessage = assistantMessages.at(-1);
			if (turnCount > 0 && turnCount < ctx.turnBudget.maxTurns) {
				turnBudget = { ...ctx.turnBudget, outcome: "within-budget", turnCount };
			} else if (turnCount >= ctx.turnBudget.maxTurns) {
				turnBudget = turnBudgetState(
					ctx.turnBudget,
					turnCount,
					shouldAbortForTurnBudget(ctx.turnBudget, turnCount, lastAssistantMessage ? isTerminalAssistantStop(lastAssistantMessage) : false),
				);
			}
		}
		cleanupTempDir(tempDir);

		const hiddenError = run.exitCode === 0 && !run.error ? detectSubagentError(run.messages) : null;
		const missingStructuredOutput = effectiveStructuredOutput
			? !fs.existsSync(effectiveStructuredOutput.outputPath)
			: false;
		const emptyOutputError = run.exitCode === 0 && !run.error && !hiddenError?.hasError && !run.finalOutput.trim() && (!effectiveStructuredOutput || missingStructuredOutput)
			? "Subagent produced no output (possible model cold-start or empty response)."
			: undefined;
		let structuredOutput: unknown;
		let structuredError: string | undefined;
		if (effectiveStructuredOutput && run.exitCode === 0 && !run.error && !hiddenError?.hasError && !emptyOutputError) {
			const structured = readStructuredOutput({
				schema: effectiveStructuredOutput.schema,
				schemaPath: effectiveStructuredOutput.schemaPath,
				outputPath: effectiveStructuredOutput.outputPath,
			});
			if (structured.error) structuredError = structured.error;
			else structuredOutput = structured.value;
		}
		const completionGuard = run.exitCode === 0 && !run.error && !hiddenError?.hasError && !emptyOutputError && step.completionGuard !== false
			? evaluateCompletionMutationGuard({
				agent: step.agent,
				task: taskForCompletionGuard,
				messages: run.messages,
				tools: step.tools,
				mcpDirectTools: step.mcpDirectTools,
			})
			: undefined;
		const completionGuardTriggered = completionGuard?.triggered === true && !run.observedMutationAttempt;
		const completionGuardError = completionGuardTriggered
			? "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes."
			: undefined;
		const effectiveExitCode = completionGuardTriggered
			? 1
			: structuredError
				? 1
				: hiddenError?.hasError
				? (hiddenError.exitCode ?? 1)
				: emptyOutputError
					? 1
					: run.error && run.exitCode === 0
						? 1
						: run.exitCode;
		const error = completionGuardError
			?? structuredError
			?? (hiddenError?.hasError
				? hiddenError.details
					? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
					: `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
				: emptyOutputError ?? (run.error || (run.exitCode !== 0 && run.stderr.trim() ? run.stderr.trim() : undefined)));
		const attempt: ModelAttempt = {
			model: candidate ?? run.model ?? step.model ?? "default",
			success: effectiveExitCode === 0 && !error,
			exitCode: effectiveExitCode,
			error,
			usage: run.usage,
		};
		modelAttempts.push(attempt);
		if (candidate) attemptedModels.push(candidate);
		completionGuardTriggeredFinal = completionGuardTriggered;
		finalOutputSnapshot = outputSnapshot;
		if (step.toolBudget) {
			const toolMessages = run.messages.filter((message) => message.role === "toolResult");
			const blockedMessage = toolMessages.find((message) => extractTextFromContent(message.content).includes("Tool budget hard limit reached"));
			toolBudgetBlocked = Boolean(blockedMessage);
			toolBudget = toolBudgetState(step.toolBudget, toolMessages.length, blockedMessage ? (blockedMessage as { toolName?: string }).toolName : undefined);
		}
		finalResult = { ...run, exitCode: effectiveExitCode, model: candidate ?? run.model, error, structuredOutput } as RunPiStreamingResult & { structuredOutput?: unknown };
		if (run.turnBudgetExceeded) break;
		if (run.timedOut || ctx.timeoutSignal?.aborted || ctx.skipAcceptance?.()) break;
		if (attempt.success || completionGuardTriggered) break;
		if (!isRetryableModelFailure(error) || index === candidates.length - 1) break;
		attemptNotes.push(formatModelAttemptNote(attempt, candidates[index + 1]));
	}

	const rawOutput = finalResult?.finalOutput ?? "";
	const outputForPersistence = stripAcceptanceReport(rawOutput);
	const resolvedOutput = step.outputPath && finalResult?.exitCode === 0
		? resolveSingleOutput(step.outputPath, outputForPersistence, finalOutputSnapshot)
		: { fullOutput: outputForPersistence };
	const output = resolvedOutput.fullOutput;
	const outputReference = resolvedOutput.savedPath ? formatSavedOutputReference(resolvedOutput.savedPath, output) : undefined;
	let outputForSummary = output;
		if (attemptNotes.length > 0) {
			outputForSummary = `${attemptNotes.join("\n")}\n\n${outputForSummary}`.trim();
		}
	if (!finalResult?.timedOut && finalResult?.turnBudgetExceeded && turnBudget) {
		outputForSummary = formatTurnBudgetOutput(turnBudgetExceededMessage(turnBudget, turnBudget.turnCount), outputForSummary);
	} else if (!finalResult?.timedOut && turnBudget?.outcome === "wrap-up-requested") {
		const note = turnBudgetSoftNote(turnBudget, turnBudget.wrapUpRequestedAtTurn ?? turnBudget.turnCount);
		outputForSummary = outputForSummary.trim() ? `${note}\n\n${outputForSummary}` : note;
	}
	const outputForAcceptance = rawOutput;
		const finalizedOutput = finalizeSingleOutput({
			fullOutput: outputForSummary,
		outputPath: step.outputPath,
		outputMode: step.outputMode,
		exitCode: finalResult?.exitCode ?? 1,
		savedPath: resolvedOutput.savedPath,
		outputReference,
		saveError: resolvedOutput.saveError,
	});
	outputForSummary = finalizedOutput.displayOutput;
	const acceptance = step.effectiveAcceptance && !finalResult?.turnBudgetExceeded && !ctx.timeoutSignal?.aborted && !ctx.skipAcceptance?.()
			? await evaluateAcceptance({
				acceptance: step.effectiveAcceptance,
				output: outputForAcceptance,
				cwd: step.cwd ?? ctx.cwd,
				signal: ctx.timeoutSignal,
				abortMessage: ctx.timeoutMessage ?? "Subagent timed out.",
			})
		: undefined;
	const timedOutAfterAcceptance = finalResult?.timedOut === true || ctx.timeoutSignal?.aborted === true || ctx.skipAcceptance?.() === true;
	const turnBudgetExceeded = finalResult?.turnBudgetExceeded === true;
	const effectiveAcceptance = timedOutAfterAcceptance || turnBudgetExceeded ? undefined : acceptance;
	const acceptanceFailure = effectiveAcceptance ? acceptanceFailureMessage(effectiveAcceptance) : undefined;
	const acceptanceCanFailRun = acceptanceFailure && effectiveAcceptance?.explicit && (finalResult?.exitCode ?? 1) === 0 && !finalResult?.interrupted && !timedOutAfterAcceptance && !turnBudgetExceeded;
	const effectiveFinalExitCode = timedOutAfterAcceptance || turnBudgetExceeded ? 1 : acceptanceCanFailRun ? 1 : finalResult?.exitCode ?? 1;
	const effectiveFinalError = timedOutAfterAcceptance
		? ctx.timeoutMessage ?? "Subagent timed out."
		: turnBudgetExceeded
			? finalResult?.error ?? (turnBudget ? turnBudgetExceededMessage(turnBudget, turnBudget.turnCount) : "Subagent exceeded turn budget.")
			: acceptanceCanFailRun
				? (finalResult?.error ? `${finalResult.error}\n${acceptanceFailure}` : acceptanceFailure)
				: finalResult?.error;

	if (artifactPaths) writeStepArtifactFiles({
		artifactPaths, ctx, step, output, effectiveFinalExitCode,
		finalResult, attemptedModels, modelAttempts, transcriptWriter, task,
	});

	return buildSingleStepResult({
		step, ctx, outputForSummary, effectiveFinalExitCode, effectiveFinalError,
		attemptedModels, modelAttempts, artifactPaths, transcriptWriter,
		timedOutAfterAcceptance, turnBudgetExceeded, finalResult, turnBudget,
		toolBudget, toolBudgetBlocked, completionGuardTriggeredFinal,
		effectiveStructuredOutput, effectiveAcceptance,
	});
}


export type SingleStepResult = Awaited<ReturnType<typeof runSingleStep>>;
