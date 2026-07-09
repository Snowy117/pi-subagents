import * as path from "node:path";
import { formatDuration, formatModelThinking, formatTokens, shortenPath } from "../../../shared/formatters.ts";
import { formatActivityLabel, formatParallelOutcome } from "../../../shared/status-format.ts";
import { type ActivityState, type TurnBudgetState } from "../../../shared/types.ts";
import { formatNestedRunStatusLines } from "../../shared/nested-render.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "../parallel-groups.ts";
import { type AsyncRunStepSummary, type AsyncRunSummary } from "./summary.ts";

function formatActivityFacts(input: { activityState?: ActivityState; lastActivityAt?: number; currentTool?: string; currentToolStartedAt?: number; currentPath?: string; turnCount?: number; toolCount?: number; steerCount?: number; lastSteerAt?: number; turnBudget?: TurnBudgetState; turnBudgetExceeded?: boolean; wrapUpRequested?: boolean }): string | undefined {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined) facts.push(`tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(`tool ${input.currentTool}`);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.turnBudgetExceeded && input.turnBudget) facts.push(`turn budget exceeded ${input.turnBudget.turnCount}/${input.turnBudget.maxTurns}+${input.turnBudget.graceTurns}`);
	else if (input.wrapUpRequested && input.turnBudget) facts.push(`wrap-up requested ${input.turnBudget.turnCount}/${input.turnBudget.maxTurns}`);
	else if (input.turnBudget) facts.push(`turn budget ${input.turnBudget.turnCount}/${input.turnBudget.maxTurns}+${input.turnBudget.graceTurns}`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	if (input.steerCount !== undefined) facts.push(`${input.steerCount} steers`);
	if (typeof input.lastSteerAt === "number" && Number.isFinite(input.lastSteerAt)) facts.push(`last steer ${new Date(input.lastSteerAt).toISOString()}`);
	const activity = formatActivityLabel(input.lastActivityAt, input.activityState);
	return activity || facts.length ? [activity, ...facts].filter(Boolean).join(" | ") : undefined;
}

function formatStepLine(step: AsyncRunStepSummary): string {
	const display = step.label ? `${step.label} (${step.agent})` : step.agent;
	const phase = step.phase ? `[${step.phase}] ` : "";
	const parts = [`${step.index + 1}. ${phase}${display}`, step.status];
	const activity = formatActivityFacts(step);
	if (activity) parts.push(activity);
	const modelThinking = formatModelThinking(step.model, step.thinking);
	if (modelThinking) parts.push(modelThinking);
	if (step.durationMs !== undefined) parts.push(formatDuration(step.durationMs));
	if (step.tokens) parts.push(`${formatTokens(step.tokens.total)} tok`);
	return parts.join(" | ");
}

export function formatAsyncRunOutputPath(run: Pick<AsyncRunSummary, "asyncDir" | "outputFile">): string | undefined {
	if (!run.outputFile) return undefined;
	return path.isAbsolute(run.outputFile) ? run.outputFile : path.join(run.asyncDir, run.outputFile);
}

export function formatAsyncRunProgressLabel(run: Pick<AsyncRunSummary, "mode" | "state" | "currentStep" | "chainStepCount" | "parallelGroups" | "steps">): string {
	const stepCount = run.steps.length || 1;
	const chainStepCount = run.chainStepCount ?? stepCount;
	const groups = normalizeParallelGroups(run.parallelGroups, run.steps.length, chainStepCount);
	const activeGroup = run.currentStep !== undefined
		? groups.find((group) => run.currentStep! >= group.start && run.currentStep! < group.start + group.count)
		: undefined;
	if (activeGroup) {
		const groupSteps = run.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count);
		const groupLabel = formatParallelOutcome(groupSteps, activeGroup.count, { showRunning: run.state === "running" });
		if (run.mode === "parallel") return groupLabel;
		return `step ${activeGroup.stepIndex + 1}/${chainStepCount} · parallel group: ${groupLabel}`;
	}
	if (run.mode === "parallel") return formatParallelOutcome(run.steps, stepCount, { showRunning: run.state === "running" });
	if (run.mode === "chain" && run.currentStep !== undefined && groups.length > 0) {
		const logicalStep = flatToLogicalStepIndex(run.currentStep, chainStepCount, groups);
		return `step ${logicalStep + 1}/${chainStepCount}`;
	}
	return run.currentStep !== undefined ? `step ${run.currentStep + 1}/${stepCount}` : `steps ${stepCount}`;
}

function formatRunHeader(run: AsyncRunSummary): string {
	const stepLabel = formatAsyncRunProgressLabel(run);
	const cwd = run.cwd ? shortenPath(run.cwd) : shortenPath(run.asyncDir);
	const activity = formatActivityFacts(run);
	const pending = run.pendingAppends ? ` | ${run.pendingAppends} pending append${run.pendingAppends === 1 ? "" : "s"}` : "";
	return `${run.id} | ${run.state}${activity ? ` | ${activity}` : ""} | ${run.mode} | ${stepLabel}${pending} | ${cwd}`;
}

export function formatAsyncRunList(runs: AsyncRunSummary[], heading = "Active async runs"): string {
	if (runs.length === 0) return `No ${heading.toLowerCase()}.`;

	const lines = [`${heading}: ${runs.length}`, ""];
	for (const run of runs) {
		lines.push(`- ${formatRunHeader(run)}`);
		for (const step of run.steps) {
			lines.push(`  ${formatStepLine(step)}`);
			lines.push(...formatNestedRunStatusLines(step.children, { indent: "    ", maxLines: 12 }));
		}
		const attached = new Set(run.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
		const unattached = run.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
		lines.push(...formatNestedRunStatusLines(unattached, { indent: "  ", maxLines: 12 }));
		if (run.error) lines.push(`  Error: ${run.error}`);
		for (const warning of run.nestedWarnings ?? []) lines.push(`  Warning: ${warning}`);
		const outputPath = formatAsyncRunOutputPath(run);
		if (outputPath) lines.push(`  output: ${shortenPath(outputPath)}`);
		if (run.sessionFile) lines.push(`  session: ${shortenPath(run.sessionFile)}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
