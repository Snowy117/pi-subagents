import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR, type AsyncStatus, type SubagentState } from "../../../shared/types.ts";
import { resolveSubagentIntercomTarget } from "../../../intercom/intercom-bridge.ts";
import { deliverInterruptRequest } from "../control-channel.ts";
import { reconcileAsyncRun } from "../stale-run-reconciler.ts";
import { readResultFile, resultState } from "./result-file.ts";
import { resolveAsyncRunLocation } from "./location.ts";
import {
	ASYNC_RESUME_INTERRUPT_SIGNAL,
	type AsyncResumeDeps,
	type AsyncResumeOptions,
	type AsyncResumeParams,
	type AsyncResumeTarget,
	type KillFn,
} from "./types.ts";

export function interruptLiveAsyncResumeTarget(input: {
	target: AsyncResumeTarget & { kind: "live" };
	state?: Pick<SubagentState, "asyncJobs">;
	kill?: KillFn;
	now?: () => number;
	resultsDir?: string;
}): { ok: true; asyncId: string } | { ok: false; message: string } {
	const asyncId = input.target.runId;
	if (!input.target.asyncDir) {
		return { ok: false, message: `Async run ${asyncId} is live but does not have an async directory to interrupt.` };
	}
	const status = reconcileAsyncRun(input.target.asyncDir, { resultsDir: input.resultsDir, kill: input.kill, now: input.now }).status;
	if (!status || status.state !== "running" || typeof status.pid !== "number") {
		return { ok: false, message: `Async run ${asyncId} is live but no interrupt-capable runner pid was found.` };
	}
	try {
		deliverInterruptRequest({
			asyncDir: input.target.asyncDir,
			pid: status.pid,
			kill: input.kill,
			signal: ASYNC_RESUME_INTERRUPT_SIGNAL,
			now: input.now,
			source: "async-resume",
		});
		const tracked = input.state?.asyncJobs.get(asyncId);
		if (tracked) {
			tracked.activityState = undefined;
			tracked.updatedAt = input.now?.() ?? Date.now();
		}
		return { ok: true, asyncId };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `Failed to interrupt async run ${asyncId}: ${message}` };
	}
}

function validateStatusForResume(status: AsyncStatus | null, source: string): void {
	if (!status) return;
	if (typeof status.runId !== "string") throw new Error(`Invalid async status '${source}': runId must be a string.`);
	if (status.sessionId !== undefined && typeof status.sessionId !== "string") throw new Error(`Invalid async status '${source}': sessionId must be a string.`);
	if (status.cwd !== undefined && typeof status.cwd !== "string") throw new Error(`Invalid async status '${source}': cwd must be a string.`);
	if (status.sessionFile !== undefined && typeof status.sessionFile !== "string") throw new Error(`Invalid async status '${source}': sessionFile must be a string.`);
	if (status.steps !== undefined) {
		if (!Array.isArray(status.steps)) throw new Error(`Invalid async status '${source}': steps must be an array.`);
		status.steps.forEach((step, index) => {
			if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`Invalid async status '${source}': steps[${index}] must be an object.`);
			const stepRecord = step as Record<string, unknown>;
			if (typeof stepRecord.agent !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].agent must be a string.`);
			if (stepRecord.sessionFile !== undefined && typeof stepRecord.sessionFile !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].sessionFile must be a string.`);
			if (stepRecord.model !== undefined && typeof stepRecord.model !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].model must be a string.`);
			if (stepRecord.thinking !== undefined && typeof stepRecord.thinking !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].thinking must be a string.`);
		});
	}
}

function validateResumeSessionFile(runId: string, sessionFile: string): string {
	if (path.extname(sessionFile) !== ".jsonl") throw new Error(`Async run '${runId}' session file must be a .jsonl file: ${sessionFile}`);
	const resolved = path.resolve(sessionFile);
	if (!fs.existsSync(resolved)) throw new Error(`Async run '${runId}' session file does not exist: ${sessionFile}`);
	return resolved;
}

export function resolveAsyncResumeTarget(params: AsyncResumeParams, deps: AsyncResumeDeps = {}, options: AsyncResumeOptions = {}): AsyncResumeTarget {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const requireSessionFile = options.requireSessionFile ?? true;
	const location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
	if (!location.asyncDir && !location.resultPath) {
		throw new Error("Async run not found. Provide id or dir.");
	}

	const reconciliation = location.asyncDir
		? reconcileAsyncRun(location.asyncDir, { resultsDir, kill: deps.kill, now: deps.now })
		: undefined;
	const status = reconciliation?.status ?? null;
	validateStatusForResume(status, location.asyncDir ? path.join(location.asyncDir, "status.json") : "status.json");
	const result = location.resultPath ? readResultFile(location.resultPath) : undefined;
	const runId = status?.runId ?? result?.runId ?? result?.id ?? location.resolvedId ?? (location.asyncDir ? path.basename(location.asyncDir) : "unknown");
	const state = status?.state ?? (result ? resultState(result) : undefined);
	if (!state) throw new Error(`Status file not found for async run '${runId}'.`);

	const statusSteps = status?.steps ?? [];
	const resultSteps = result?.results ?? [];
	const stepCount = statusSteps.length || resultSteps.length || (result?.agent ? 1 : 0);
	const requestedIndex = params.index;
	if (requestedIndex !== undefined && !Number.isInteger(requestedIndex)) throw new Error(`Async run '${runId}' index must be an integer.`);
	const terminalStepStatuses = new Set(["complete", "completed", "failed", "paused"]);

	if (state === "running") {
		if (requestedIndex !== undefined) {
			if (requestedIndex < 0 || requestedIndex >= stepCount) throw new Error(`Async run '${runId}' has ${stepCount} children. Index ${requestedIndex} is out of range.`);
			const selectedStep = statusSteps[requestedIndex];
			if (selectedStep?.status === "running") {
				return {
					kind: "live",
					runId,
					asyncDir: location.asyncDir ?? undefined,
					state,
					agent: selectedStep.agent,
					index: requestedIndex,
					intercomTarget: resolveSubagentIntercomTarget(runId, selectedStep.agent, requestedIndex),
					cwd: status?.cwd ?? result?.cwd,
					sessionFile: selectedStep.sessionFile ?? status?.sessionFile ?? result?.sessionFile,
					model: selectedStep.model,
					thinking: selectedStep.thinking,
				};
			}
			if (selectedStep?.status === "pending") throw new Error(`Async run '${runId}' child ${requestedIndex} is pending and has not started yet. Wait for it to run or complete before resuming.`);
			if (selectedStep && !terminalStepStatuses.has(selectedStep.status)) throw new Error(`Async run '${runId}' child ${requestedIndex} is ${selectedStep.status} and cannot be revived yet.`);
		} else {
			const running = statusSteps
				.map((step, index) => ({ step, index }))
				.filter(({ step }) => step.status === "running");
			const selected = running.length === 1 ? running[0] : undefined;
			if (!selected) {
				throw new Error(`Async run '${runId}' has ${running.length} running children. Provide index to choose one.`);
			}
			return {
				kind: "live",
				runId,
				asyncDir: location.asyncDir ?? undefined,
				state,
				agent: selected.step.agent,
				index: selected.index,
				intercomTarget: resolveSubagentIntercomTarget(runId, selected.step.agent, selected.index),
				cwd: status?.cwd ?? result?.cwd,
				sessionFile: selected.step.sessionFile ?? status?.sessionFile ?? result?.sessionFile,
				model: selected.step.model,
				thinking: selected.step.thinking,
			};
		}
	}

	if (stepCount > 1 && requestedIndex === undefined) {
		throw new Error(`Async run '${runId}' has ${stepCount} children. Provide index to choose one.`);
	}
	const index = requestedIndex ?? 0;
	if (!Number.isInteger(index)) throw new Error(`Async run '${runId}' index must be an integer.`);
	if (index < 0 || index >= stepCount) throw new Error(`Async run '${runId}' has ${stepCount} children. Index ${index} is out of range.`);
	const agent = statusSteps[index]?.agent ?? resultSteps[index]?.agent ?? result?.agent;
	if (!agent) throw new Error(`Could not determine child agent for async run '${runId}'.`);
	const sessionFile = statusSteps[index]?.sessionFile
		?? resultSteps[index]?.sessionFile
		?? (stepCount === 1 ? status?.sessionFile ?? result?.sessionFile : undefined);
	if (!sessionFile && requireSessionFile) throw new Error(`Async run '${runId}' child ${index} does not have a persisted session file to resume from.`);
	const resolvedSessionFile = sessionFile ? validateResumeSessionFile(runId, sessionFile) : undefined;
	const stepModel = statusSteps[index]?.model ?? resultSteps[index]?.model ?? (stepCount === 1 ? result?.model : undefined);
	const stepThinking = statusSteps[index]?.thinking ?? resultSteps[index]?.thinking ?? (stepCount === 1 ? result?.thinking : undefined);

	return {
		kind: "revive",
		runId,
		asyncDir: location.asyncDir ?? undefined,
		state,
		agent,
		index,
		intercomTarget: resolveSubagentIntercomTarget(runId, agent, index),
		cwd: status?.cwd ?? result?.cwd,
		...(resolvedSessionFile ? { sessionFile: resolvedSessionFile } : {}),
		...(stepModel ? { model: stepModel } : {}),
		...(stepThinking ? { thinking: stepThinking } : {}),
	};
}

export function buildRevivedAsyncTask(target: AsyncResumeTarget, message: string): string {
	return [
		"You are reviving a previous subagent conversation.",
		"",
		`Original run: ${target.runId}`,
		`Original agent: ${target.agent}`,
		target.sessionFile ? `Original session file: ${target.sessionFile}` : undefined,
		"",
		"Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.",
		"",
		"Follow-up:",
		message,
	].filter((line): line is string => line !== undefined).join("\n");
}
