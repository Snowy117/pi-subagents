import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details, Usage } from "../../shared/types.ts";
import { aggregateParallelOutputs } from "../shared/parallel-utils.ts";
import type { NormalizedAsyncCompletion, SyncCompletionTask } from "./completion-broker.ts";
import type { ResultFileData } from "./result-watcher/helpers.ts";

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

export function completionToToolResult(completion: NormalizedAsyncCompletion, tasks: SyncCompletionTask[]): AgentToolResult<Details> {
	const data = completion.data as ResultFileData;
	const children = Array.isArray(data.results) ? data.results : [];
	const results = children.map((child, index) => {
		const descriptor = tasks[index];
		const output = child.output ?? child.summary ?? "";
		const failed = child.success === false || child.status === "failed";
		const paused = data.state === "paused" || child.status === "paused";
		const childArtifactPath = child.artifactPath ?? child.artifactPaths?.outputPath;
		const truncation = child.truncated ? { text: output, truncated: true } : undefined;
		return {
			agent: child.agent ?? descriptor?.agent ?? `step-${index + 1}`,
			task: child.task ?? descriptor?.task ?? "",
			exitCode: typeof child.exitCode === "number" ? child.exitCode : failed ? 1 : 0,
			usage: child.usage ?? { ...ZERO_USAGE },
			...(child.skipped !== undefined ? { skipped: child.skipped } : {}),
			...(child.error ? { error: child.error } : {}),
			...(child.interrupted !== undefined || paused ? { interrupted: child.interrupted ?? true } : {}),
			...(child.timedOut !== undefined ? { timedOut: child.timedOut } : {}),
			...(child.turnBudget ? { turnBudget: child.turnBudget } : {}),
			...(child.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: child.turnBudgetExceeded } : {}),
			...(child.wrapUpRequested !== undefined ? { wrapUpRequested: child.wrapUpRequested } : {}),
			...(child.toolBudget ? { toolBudget: child.toolBudget } : {}),
			...(child.toolBudgetBlocked !== undefined ? { toolBudgetBlocked: child.toolBudgetBlocked } : {}),
			...(child.sessionFile ?? child.sessionPath ? { sessionFile: child.sessionFile ?? child.sessionPath } : {}),
			...(child.model ? { model: child.model } : {}),
			...(child.attemptedModels ? { attemptedModels: child.attemptedModels } : {}),
			...(child.modelAttempts ? { modelAttempts: child.modelAttempts } : {}),
			...(child.totalCost ? { totalCost: child.totalCost } : {}),
			...(child.artifactPaths ? { artifactPaths: child.artifactPaths } : {}),
			...(truncation ? { truncation: {
				...truncation,
				...(childArtifactPath ? { artifactPath: childArtifactPath } : {}),
			} } : {}),
			...(child.transcriptPath ? { transcriptPath: child.transcriptPath } : {}),
			...(child.transcriptError ? { transcriptError: child.transcriptError } : {}),
			...(child.structuredOutput !== undefined ? { structuredOutput: child.structuredOutput } : {}),
			...(child.structuredOutputPath ? { structuredOutputPath: child.structuredOutputPath } : {}),
			...(child.structuredOutputSchemaPath ? { structuredOutputSchemaPath: child.structuredOutputSchemaPath } : {}),
			...(Array.isArray(child.children) ? { children: child.children } : {}),
			finalOutput: output,
		};
	});
	const mode = data.mode ?? completion.mode;
	const details: Details = {
		mode,
		runId: completion.runId,
		asyncId: data.id ?? completion.runId,
		results,
		...(data.sessionId ? { sessionId: data.sessionId } : {}),
		...(data.sessionFile ? { sessionFile: data.sessionFile } : {}),
		...(data.cwd ? { cwd: data.cwd } : {}),
		...(data.asyncDir ? { asyncDir: data.asyncDir } : {}),
		...(data.timeoutMs !== undefined ? { timeoutMs: data.timeoutMs } : {}),
		...(data.deadlineAt !== undefined ? { deadlineAt: data.deadlineAt } : {}),
		...(data.timedOut !== undefined ? { timedOut: data.timedOut } : {}),
		...(data.turnBudget ? { turnBudget: data.turnBudget } : {}),
		...(data.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: data.turnBudgetExceeded } : {}),
		...(data.wrapUpRequested !== undefined ? { wrapUpRequested: data.wrapUpRequested } : {}),
		...(data.toolBudget ? { toolBudget: data.toolBudget } : {}),
		...(data.toolBudgetBlocked !== undefined ? { toolBudgetBlocked: data.toolBudgetBlocked } : {}),
		...(data.exitCode !== undefined ? { exitCode: data.exitCode } : {}),
		...(data.timestamp !== undefined ? { timestamp: data.timestamp } : {}),
		...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
		...(Array.isArray(data.nestedChildren) ? { nestedChildren: data.nestedChildren } : {}),
		...(data.outputs ? { outputs: data.outputs } : {}),
		...(data.workflowGraph ? { workflowGraph: data.workflowGraph } : {}),
		...(data.totalCost ? { totalCost: data.totalCost } : {}),
		...(data.totalTokens ? { totalChildUsage: {
			input: data.totalTokens.input ?? 0, output: data.totalTokens.output ?? 0,
			cacheRead: 0, cacheWrite: 0, cost: data.totalCost?.costUsd ?? 0, turns: 0,
		} } : {}),
		...(data.artifactsDir ? { artifacts: { dir: data.artifactsDir, files: results.flatMap((result) => result.artifactPaths ? [result.artifactPaths] : []) } } : {}),
		...(data.truncated !== undefined ? { truncation: {
			truncated: data.truncated,
			...(data.truncated && results.at(-1)?.truncation?.artifactPath
				? { artifactPath: results.at(-1)!.truncation!.artifactPath }
				: {}),
		} } : {}),
	};
	const single = results[0];
	const multiOutput = aggregateParallelOutputs(
		results.map((result) => ({
			agent: result.agent,
			output: result.truncation?.text ?? result.finalOutput,
			exitCode: result.exitCode,
			error: result.error,
		})),
		(index, agent) => `=== Task ${index + 1}: ${agent} ===`,
	);
	const completedCount = results.filter((result) => result.exitCode === 0).length;
	const normalOutput = mode === "single" && single
		? single.exitCode === 0
			? (single.truncation?.text ?? single.finalOutput) || "(no output)"
			: [single.error, single.truncation?.text ?? single.finalOutput].filter(Boolean).join("\n\n") || data.error || data.summary || "Subagent failed."
		: results.length > 0
			? `${completedCount}/${results.length} succeeded\n\n${multiOutput}`
			: data.error ?? data.summary ?? "(no output)";
	const content = data.state === "paused" ? data.summary ?? normalOutput : normalOutput;
	return {
		content: [{ type: "text", text: content }],
		...(data.success === false || data.state === "failed" ? { isError: true } : {}),
		details,
	};
}
