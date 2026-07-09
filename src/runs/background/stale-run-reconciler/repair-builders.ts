import * as path from "node:path";
import { writeAtomicJson } from "../../../shared/atomic-json.ts";
import { type AsyncStatus } from "../../../shared/types.ts";
import { resolveEffectiveThinking } from "../../../shared/model-info.ts";
import { normalizeParallelGroups } from "../parallel-groups.ts";
import {
	type ReconcileAsyncRunResult,
	type ResultChildOutcome,
	type ResultRepairData,
	type StartedRunMetadata,
	appendJsonlBestEffort,
	readResultRepairData,
	readRunnerStartupDiagnostics,
} from "./reconcile-helpers.ts";

export function childState(overallState: ResultRepairData["state"], child: ResultChildOutcome | undefined): "complete" | "failed" | "paused" {
	if (child?.success === true) return "complete";
	if (child?.success === false) return "failed";
	return overallState;
}

export function terminalStatusFromResult(status: AsyncStatus, resultPath: string, now: number): AsyncStatus | undefined {
	const repair = readResultRepairData(resultPath);
	if (!repair) return undefined;
	const steps = (status.steps ?? []).map((step, index) => {
		if (step.status !== "running" && step.status !== "pending") return step;
		const child = repair.results?.[index];
		const state = childState(repair.state, child);
		const model = child?.model ?? step.model;
		const thinking = resolveEffectiveThinking(model, child?.thinking ?? step.thinking);
		return {
			...step,
			status: state === "complete" ? "complete" as const : state,
			endedAt: step.endedAt ?? now,
			durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
			exitCode: step.exitCode ?? (state === "complete" || state === "paused" ? 0 : 1),
			error: state === "failed" ? step.error ?? child?.error : step.error,
			sessionFile: step.sessionFile ?? child?.sessionFile,
			model,
			thinking,
			attemptedModels: child?.attemptedModels ?? step.attemptedModels,
			modelAttempts: child?.modelAttempts ?? step.modelAttempts,
		};
	});
	return {
		...status,
		state: repair.state,
		activityState: undefined,
		lastUpdate: now,
		endedAt: status.endedAt ?? now,
		steps,
	};
}

export function buildStartedStatus(asyncDir: string, startedRun: StartedRunMetadata, now: number): AsyncStatus {
	const startedAt = startedRun.startedAt ?? now;
	const agents = startedRun.agents?.length ? startedRun.agents : ["subagent"];
	const chainStepCount = startedRun.chainStepCount;
	const parallelGroups = chainStepCount !== undefined
		? normalizeParallelGroups(startedRun.parallelGroups, agents.length, chainStepCount)
		: [];
	return {
		runId: startedRun.runId || path.basename(asyncDir),
		...(startedRun.sessionId ? { sessionId: startedRun.sessionId } : {}),
		mode: startedRun.mode ?? "single",
		state: "running",
		pid: startedRun.pid,
		startedAt,
		lastUpdate: now,
		currentStep: 0,
		...(chainStepCount !== undefined ? { chainStepCount } : {}),
		...(parallelGroups.length ? { parallelGroups } : {}),
		steps: agents.map((agent) => ({
			agent,
			status: "running" as const,
			startedAt,
		})),
		...(startedRun.sessionFile ? { sessionFile: startedRun.sessionFile } : {}),
	};
}

export function buildFailedRepair(status: AsyncStatus, asyncDir: string, now: number, reason?: string): { status: AsyncStatus; result: object; message: string } {
	const runId = status.runId || path.basename(asyncDir);
	const pid = typeof status.pid === "number" ? status.pid : "unknown";
	const baseMessage = reason ?? `Async runner process ${pid} exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.`;
	const diagnostics = readRunnerStartupDiagnostics(asyncDir);
	const message = diagnostics ? `${baseMessage}\n\nRunner stderr tail:\n${diagnostics}` : baseMessage;
	const steps = status.steps?.length ? status.steps : [{ agent: "subagent", status: "running" as const }];
	const repairedSteps = steps.map((step) => step.status === "running" || step.status === "pending"
		? {
			...step,
			status: "failed" as const,
			activityState: undefined,
			endedAt: step.endedAt ?? now,
			durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
			exitCode: step.exitCode ?? 1,
			error: step.error ?? message,
		}
		: step);
	const repairedStatus: AsyncStatus = {
		...status,
		state: "failed",
		activityState: undefined,
		lastUpdate: now,
		endedAt: now,
		steps: repairedSteps,
	};
	const resultAgent = repairedSteps[status.currentStep ?? 0]?.agent ?? repairedSteps[0]?.agent ?? "subagent";
	return {
		status: repairedStatus,
		message,
		result: {
			id: runId,
			agent: resultAgent,
			mode: status.mode,
			success: false,
			state: "failed",
			summary: message,
			results: repairedSteps.map((step) => ({
				agent: step.agent,
				output: step.status === "complete" || step.status === "completed" ? "" : message,
				error: step.status === "complete" || step.status === "completed" ? undefined : step.error ?? message,
				success: step.status === "complete" || step.status === "completed",
				model: step.model,
				attemptedModels: step.attemptedModels,
				modelAttempts: step.modelAttempts,
				sessionFile: step.sessionFile,
			})),
			exitCode: 1,
			timestamp: now,
			durationMs: Math.max(0, now - status.startedAt),
			asyncDir,
			sessionId: status.sessionId,
			sessionFile: status.sessionFile,
		},
	};
}

export function writeFailedRepair(asyncDir: string, status: AsyncStatus, resultPath: string, now: number, reason?: string): ReconcileAsyncRunResult {
	const repair = buildFailedRepair(status, asyncDir, now, reason);
	writeAtomicJson(resultPath, repair.result);
	writeAtomicJson(path.join(asyncDir, "status.json"), repair.status);
	appendJsonlBestEffort(path.join(asyncDir, "events.jsonl"), {
		type: "subagent.run.repaired_stale",
		ts: now,
		runId: repair.status.runId,
		pid: status.pid,
		resultPath,
		message: repair.message,
	});
	return { status: repair.status, repaired: true, resultPath, message: repair.message };
}

export function terminal(state: AsyncStatus["state"]): boolean {
	return state === "complete" || state === "failed" || state === "paused";
}
