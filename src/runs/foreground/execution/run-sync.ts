/** runSync — top-level synchronous subagent execution wrapper. Iterates model
 * candidates (delegating to runSingleAttempt), writes artifacts/metadata, and
 * evaluates acceptance. Moved out of execution.ts (foreground split). */

import { existsSync } from "node:fs";
import type { AgentConfig } from "../../../agents/agents.ts";
import { ensureArtifactsDir, getArtifactPaths, writeArtifact, writeMetadata } from "../../../shared/artifacts.ts";
import { createChildTranscriptWriter, type ChildTranscriptWriter } from "../../../shared/child-transcript.ts";
import { type ArtifactPaths, type ModelAttempt, type RunSyncOptions, type SingleResult, DEFAULT_MAX_OUTPUT, truncateOutput } from "../../../shared/types.ts";
import { detectSubagentError, findLatestSessionFile, getFinalOutput } from "../../../shared/utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../../agents/skills.ts";
import { buildAgentMemoryInjection } from "../../../agents/agent-memory.ts";
import { captureSingleOutputSnapshot, injectOutputPathSystemPrompt, validateFileOnlyOutputMode, type SingleOutputSnapshot } from "../../shared/single-output.ts";
import { buildModelCandidates, formatModelAttemptNote, isRetryableModelFailure } from "../../shared/model-fallback.ts";
import { acceptanceFailureMessage, evaluateAcceptance, formatAcceptancePrompt, resolveEffectiveAcceptance } from "../../shared/acceptance.ts";
import { runSingleAttempt } from "./run-single-attempt.ts";
import { acceptanceOutputByResult, artifactOutputByResult, buildSkippedAcceptanceLedger, emptyUsage, formatTimeoutMessage, stripAcceptanceReportsFromMessages, sumUsage } from "./attempt-helpers.ts";

/**
 * Run a subagent synchronously (blocking until complete)
 */
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: `Unknown agent: ${agentName}`,
		};
	}
	const outputModeValidationError = validateFileOnlyOutputMode(options.outputMode, options.outputPath, `Single run (${agentName})`);
	if (outputModeValidationError) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			outputMode: options.outputMode,
			error: outputModeValidationError,
		};
	}

	const shareEnabled = options.share === true;
	const effectiveAcceptance = resolveEffectiveAcceptance({
		explicit: options.acceptance,
		agentName,
		task,
		mode: options.acceptanceContext?.mode ?? "single",
		async: options.acceptanceContext?.async,
		dynamic: options.acceptanceContext?.dynamic,
		dynamicGroup: options.acceptanceContext?.dynamicGroup,
	});
	const acceptancePrompt = formatAcceptancePrompt(effectiveAcceptance);
	const taskWithAcceptance = acceptancePrompt ? `${task}\n${acceptancePrompt}` : task;
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	const skillNames = options.skills ?? agent.skills ?? [];
	const skillCwd = options.cwd ?? runtimeCwd;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, skillCwd, runtimeCwd);
	if (skillNames.some((skill) => skill.trim() === "pi-subagents") && missingSkills.includes("pi-subagents")) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "Skills not found: pi-subagents",
		};
	}
	let systemPrompt = agent.systemPrompt?.trim() || "";
	if (resolvedSkills.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
	}
	const memoryInjection = buildAgentMemoryInjection(agent, skillCwd);
	if (memoryInjection) {
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryInjection}` : memoryInjection;
	}
	systemPrompt = injectOutputPathSystemPrompt(systemPrompt, options.outputPath);

	const candidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
		{ scope: options.modelScope },
	);
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const aggregateUsage = emptyUsage();
	const attemptNotes: string[] = [];
	let totalToolCount = 0;
	let totalDurationMs = 0;

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	let transcriptWriter: ChildTranscriptWriter | undefined;
	if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(options.artifactsDir, options.runId, agentName, options.index);
		ensureArtifactsDir(options.artifactsDir);
		if (options.artifactConfig?.includeInput !== false) {
				writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${taskWithAcceptance}`);
		}
		if (options.artifactConfig?.includeJsonl !== false) {
			jsonlPath = artifactPathsResult.jsonlPath;
		}
		if (options.artifactConfig?.includeTranscript !== false) {
			transcriptWriter = createChildTranscriptWriter({
				transcriptPath: artifactPathsResult.transcriptPath,
				source: "foreground",
				runId: options.runId,
				agent: agentName,
				childIndex: options.index,
				cwd: options.cwd ?? runtimeCwd,
			});
			transcriptWriter.writeInitialUserMessage(taskWithAcceptance);
		}
	}

	let lastResult: SingleResult | undefined;
	const modelsToTry = candidates.length > 0 ? candidates : [undefined];
	for (let i = 0; i < modelsToTry.length; i++) {
		const candidate = modelsToTry[i];
		const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
		const result = await runSingleAttempt(runtimeCwd, agent, taskWithAcceptance, candidate, options, {
			sessionEnabled,
			systemPrompt,
			resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
			skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
			jsonlPath,
			artifactPaths: artifactPathsResult,
			transcriptWriter,
			attemptNotes,
			outputSnapshot,
			originalTask: task,
		});
		lastResult = result;
		if (result.model) attemptedModels.push(result.model);
		else if (candidate) attemptedModels.push(candidate);
		sumUsage(aggregateUsage, result.usage);
		totalToolCount += result.progressSummary?.toolCount ?? 0;
		totalDurationMs += result.progressSummary?.durationMs ?? 0;
		const attemptSucceeded = result.exitCode === 0 && !result.error;
		const attempt: ModelAttempt = {
			model: result.model ?? candidate ?? agent.model ?? "default",
			success: attemptSucceeded,
			exitCode: result.exitCode,
			error: result.error,
			usage: { ...result.usage },
		};
		modelAttempts.push(attempt);
		if (result.detached || result.timedOut || result.turnBudgetExceeded) {
			break;
		}
		if (attemptSucceeded) {
			break;
		}
		if (!isRetryableModelFailure(result.error) || i === modelsToTry.length - 1) {
			break;
		}
		attemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[i + 1]));
	}

	const result = lastResult ?? {
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: "Subagent did not produce a result.",
	} satisfies SingleResult;

	result.usage = aggregateUsage;
	result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
	result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
	result.progressSummary = {
		toolCount: totalToolCount,
		tokens: aggregateUsage.input + aggregateUsage.output,
		durationMs: totalDurationMs,
	};
	if (attemptNotes.length > 0 && result.progress) {
		result.progress.recentOutput = [...attemptNotes, ...result.progress.recentOutput];
		if (result.progress.recentOutput.length > 50) {
			result.progress.recentOutput.splice(50);
		}
	}

	if (transcriptWriter) result.transcriptPath = artifactPathsResult?.transcriptPath;
	if (transcriptWriter?.getError()) result.transcriptError = transcriptWriter.getError();

	if (artifactPathsResult && options.artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		if (options.artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, artifactOutputByResult.get(result) ?? result.finalOutput ?? "");
		}
		if (options.artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId: options.runId,
				agent: agentName,
				task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				attemptedModels: result.attemptedModels,
				modelAttempts: result.modelAttempts,
				durationMs: result.progressSummary?.durationMs,
				toolCount: result.progressSummary?.toolCount,
				error: result.error,
				...(transcriptWriter ? { transcriptPath: artifactPathsResult.transcriptPath } : {}),
				transcriptError: result.transcriptError,
				skills: result.skills,
				skillsWarning: result.skillsWarning,
				timestamp: Date.now(),
			});
		}

		if (options.maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
			const truncationResult = truncateOutput(result.finalOutput ?? "", config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) result.truncation = truncationResult;
		}
	} else if (options.maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
		const truncationResult = truncateOutput(result.finalOutput ?? "", config);
		if (truncationResult.truncated) result.truncation = truncationResult;
	}

	if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
		result.sessionFile = options.sessionFile;
	} else if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) result.sessionFile = sessionFile;
	}

	result.acceptance = result.detached
		? buildSkippedAcceptanceLedger(effectiveAcceptance, { id: "detached", message: "Acceptance was not evaluated because the subagent detached for intercom coordination before task completion." })
		: result.timedOut
			? buildSkippedAcceptanceLedger(effectiveAcceptance, { id: "timeout", message: "Acceptance was not evaluated because the subagent timed out." })
			: result.turnBudgetExceeded
			? buildSkippedAcceptanceLedger(effectiveAcceptance, { id: "turn-budget", message: "Acceptance was not evaluated because the subagent exceeded its turn budget." })
			: await evaluateAcceptance({
			acceptance: effectiveAcceptance,
			output: acceptanceOutputByResult.get(result) ?? result.finalOutput ?? "",
			cwd: options.cwd ?? runtimeCwd,
		});
	const acceptanceFailure = acceptanceFailureMessage(result.acceptance);
	stripAcceptanceReportsFromMessages(result.messages);
	if (acceptanceFailure && result.acceptance.explicit && result.exitCode === 0 && !result.detached && !result.interrupted && !result.timedOut) {
		result.exitCode = 1;
		result.error = result.error ? `${result.error}\n${acceptanceFailure}` : acceptanceFailure;
		if (result.progress) {
			result.progress.status = "failed";
			result.progress.error = result.error;
		}
	}

	return result;
}
