import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { flatToLogicalStepIndex } from "../../runs/background/parallel-groups.ts";
import { formatDuration, formatModelThinking, shortenPath } from "../../shared/formatters.ts";
import { formatAgentRunningLabel } from "../../shared/status-format.ts";
import type { AsyncJobState, AsyncJobStep } from "../../shared/types.ts";
import { runningGlyph, runningSeed } from "./glyph-animation.ts";
import { buildLiveStatusLine, formatCurrentToolLine } from "./output-target.ts";
import { formatTokenStat, formatToolUseStat, statJoin } from "./stats.ts";

export function widgetRenderKey(job: AsyncJobState): string {
	return JSON.stringify({
		asyncDir: job.asyncDir,
		status: job.status,
		activityState: job.activityState,
		lastActivityAt: job.lastActivityAt,
		currentTool: job.currentTool,
		currentToolStartedAt: job.currentToolStartedAt,
		currentPath: job.currentPath,
		turnCount: job.turnCount,
		toolCount: job.toolCount,
		mode: job.mode,
		agents: job.agents,
		currentStep: job.currentStep,
		chainStepCount: job.chainStepCount,
		parallelGroups: job.parallelGroups,
		steps: job.steps,
		nestedChildren: job.nestedChildren,
		stepsTotal: job.stepsTotal,
		runningSteps: job.runningSteps,
		completedSteps: job.completedSteps,
		activeParallelGroup: job.activeParallelGroup,
		startedAt: job.startedAt,
		updatedAt: job.updatedAt,
		totalTokens: job.totalTokens,
	});
}

export function formatWidgetAgents(agents: string[]): string {
	const distinct = [...new Set(agents)];
	if (distinct.length === 1 && agents.length > 1) return `${distinct[0]} ×${agents.length}`;
	if (agents.length > 3) return `${agents.slice(0, 2).join(", ")} +${agents.length - 2} more`;
	return agents.join(", ");
}

export function widgetJobName(job: AsyncJobState): string {
	if (job.mode === "parallel") return "parallel";
	if (job.mode === "chain") return "chain";
	if (job.mode === "single" && job.agents?.length === 1) return job.agents[0]!;
	if (job.agents?.length) return formatWidgetAgents(job.agents);
	return job.mode ?? "subagent";
}

export function widgetActivity(job: AsyncJobState): string {
	const facts: string[] = [];
	if (job.currentTool && job.currentToolStartedAt !== undefined && job.updatedAt !== undefined) facts.push(`${job.currentTool} ${formatDuration(Math.max(0, job.updatedAt - job.currentToolStartedAt))}`);
	else if (job.currentTool) facts.push(job.currentTool);
	if (job.currentPath) facts.push(shortenPath(job.currentPath));
	if (job.turnCount !== undefined) facts.push(`${job.turnCount} turns`);
	if (job.toolCount !== undefined) facts.push(`${job.toolCount} tools`);
	const activity = buildLiveStatusLine(job, job.updatedAt);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	if (facts.length) return facts.join(" · ");
	if (job.status === "running") return "thinking…";
	if (job.status === "queued") return "queued…";
	if (job.status === "paused") return "Paused";
	if (job.status === "failed") return "Failed";
	return "Done";
}

export function widgetStepRunningSeed(step: NonNullable<AsyncJobState["steps"]>[number], fallbackIndex?: number): number | undefined {
	return runningSeed(
		fallbackIndex,
		step.index,
		step.toolCount,
		step.turnCount,
		step.tokens?.total,
		step.lastActivityAt,
		step.currentToolStartedAt,
		step.durationMs,
	);
}

export function widgetStepsRunningSeed(steps: Array<NonNullable<AsyncJobState["steps"]>[number]> | undefined): number | undefined {
	let seed: number | undefined;
	for (const [index, step] of (steps ?? []).entries()) seed = runningSeed(seed, widgetStepRunningSeed(step, index));
	return seed;
}

export function widgetJobRunningSeed(job: AsyncJobState): number | undefined {
	return runningSeed(
		job.updatedAt,
		job.lastActivityAt,
		job.toolCount,
		job.turnCount,
		job.totalTokens?.total,
		job.currentStep,
		job.runningSteps,
		job.completedSteps,
		widgetStepsRunningSeed(job.steps),
	);
}

export function widgetJobsRunningSeed(jobs: AsyncJobState[]): number | undefined {
	let seed: number | undefined;
	for (const job of jobs) seed = runningSeed(seed, widgetJobRunningSeed(job));
	return seed;
}

export function widgetStatusGlyph(job: AsyncJobState, theme: Theme): string {
	if (job.status === "running") return theme.fg("accent", runningGlyph(widgetJobRunningSeed(job)));
	if (job.status === "queued") return theme.fg("muted", "◦");
	if (job.status === "complete") return theme.fg("success", "✓");
	if (job.status === "paused") return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

export function widgetStepGlyph(status: AsyncJobStep["status"], theme: Theme, seed?: number): string {
	if (status === "running") return theme.fg("accent", runningGlyph(seed));
	if (status === "complete" || status === "completed") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "paused") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

export function widgetStepStatus(status: AsyncJobStep["status"], theme: Theme): string {
	if (status === "running") return theme.fg("accent", "running");
	if (status === "complete" || status === "completed") return theme.fg("success", "complete");
	if (status === "failed") return theme.fg("error", "failed");
	if (status === "paused") return theme.fg("warning", "paused");
	return theme.fg("dim", status);
}

export function widgetStepActivity(step: NonNullable<AsyncJobState["steps"]>[number], snapshotNow?: number): string {
	const facts: string[] = [];
	if (step.currentTool && step.currentToolStartedAt !== undefined && snapshotNow !== undefined) facts.push(`${step.currentTool} ${formatDuration(Math.max(0, snapshotNow - step.currentToolStartedAt))}`);
	else if (step.currentTool) facts.push(step.currentTool);
	if (step.currentPath) facts.push(shortenPath(step.currentPath));
	if (step.turnCount !== undefined) facts.push(`${step.turnCount} turns`);
	if (step.toolCount !== undefined) facts.push(`${step.toolCount} tools`);
	if (step.tokens?.total) facts.push(formatTokenStat(step.tokens.total));
	const activity = buildLiveStatusLine(step, snapshotNow);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	return facts.join(" · ");
}

export function widgetStats(job: AsyncJobState, theme: Theme): string {
	const parts: string[] = [];
	const stepsTotal = job.stepsTotal ?? (job.agents?.length ?? 1);
	if (job.activeParallelGroup) {
		const running = job.runningSteps ?? (job.status === "running" ? 1 : 0);
		const done = job.completedSteps ?? (job.status === "complete" ? stepsTotal : 0);
		if (job.mode === "parallel") {
			if (job.status === "running" && running > 0) parts.push(formatAgentRunningLabel(running));
			if (stepsTotal > 0) parts.push(`${done}/${stepsTotal} done`);
		} else {
			const activeGroup = job.currentStep !== undefined
				? job.parallelGroups?.find((group) => job.currentStep! >= group.start && job.currentStep! < group.start + group.count)
				: job.parallelGroups?.find((group) => group.start === 0);
			const logicalStep = activeGroup?.stepIndex ?? job.currentStep ?? 0;
			const total = job.chainStepCount ?? stepsTotal;
			const groupParts = [`${done}/${stepsTotal} done`];
			if (job.status === "running" && running > 0) groupParts.unshift(formatAgentRunningLabel(running));
			parts.push(`step ${logicalStep + 1}/${total} · parallel group: ${groupParts.join(" · ")}`);
		}
	} else if (job.currentStep !== undefined) {
		if (job.mode === "chain" && job.parallelGroups?.length) {
			const total = job.chainStepCount ?? stepsTotal;
			parts.push(`step ${flatToLogicalStepIndex(job.currentStep, total, job.parallelGroups) + 1}/${total}`);
		} else {
			parts.push(`step ${job.currentStep + 1}/${stepsTotal}`);
		}
	} else if (stepsTotal > 1) {
		parts.push(`steps ${stepsTotal}`);
	}
	if (job.toolCount !== undefined) parts.push(formatToolUseStat(job.toolCount));
	if (job.totalTokens?.total) parts.push(formatTokenStat(job.totalTokens.total));
	if (job.startedAt !== undefined && job.updatedAt !== undefined) parts.push(formatDuration(Math.max(0, job.updatedAt - job.startedAt)));
	return statJoin(theme, parts);
}

export function widgetStepStats(theme: Theme, step: NonNullable<AsyncJobState["steps"]>[number]): string {
	return statJoin(theme, [
		step.turnCount !== undefined ? `${step.turnCount} turns` : "",
		step.toolCount !== undefined ? formatToolUseStat(step.toolCount) : "",
		step.tokens?.total ? formatTokenStat(step.tokens.total) : "",
		step.durationMs !== undefined ? formatDuration(step.durationMs) : "",
	]);
}

export function modelThinkingBadge(theme: Theme, model?: string, thinking?: string): string {
	const label = formatModelThinking(model, thinking);
	return label ? theme.fg("dim", ` (${label})`) : "";
}

export function widgetStepActivityLine(step: NonNullable<AsyncJobState["steps"]>[number], width: number, expanded: boolean, snapshotNow?: number): string {
	const toolLine = formatCurrentToolLine(step, width, expanded, snapshotNow);
	if (toolLine) return toolLine;
	const activity = buildLiveStatusLine(step, snapshotNow);
	if (activity) return activity;
	if (step.status === "running") return "thinking…";
	return "";
}

export function widgetOutputPath(job: AsyncJobState, step: NonNullable<AsyncJobState["steps"]>[number]): string | undefined {
	if (typeof step.index !== "number") return undefined;
	return path.join(job.asyncDir, `output-${step.index}.log`);
}
