import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatNestedAggregate } from "../../runs/shared/nested-render.ts";
import { formatDuration, shortenPath } from "../../shared/formatters.ts";
import { aggregateStepStatus, formatParallelOutcome } from "../../shared/status-format.ts";
import type { AsyncJobState, NestedRunSummary, NestedStepSummary } from "../../shared/types.ts";
import { runningGlyph, runningSeed } from "./glyph-animation.ts";
import { buildLiveStatusLine, liveDetailHintText } from "./output-target.ts";
import { buildAsyncChainStepSpans } from "./chain.ts";
import { themeBold } from "./stats.ts";
import { truncLine, getTermWidth } from "./text-wrap.ts";
import {
	formatWidgetAgents,
	modelThinkingBadge,
	widgetActivity,
	widgetJobName,
	widgetStats,
	widgetStatusGlyph,
	widgetStepActivity,
	widgetStepActivityLine,
	widgetStepGlyph,
	widgetStepRunningSeed,
	widgetStepsRunningSeed,
	widgetStepStats,
	widgetStepStatus,
	widgetOutputPath,
} from "./widget-core.ts";

export function nestedRunName(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return formatWidgetAgents(run.agents);
	return run.id;
}

export function nestedStatusGlyph(state: NestedRunSummary["state"] | NestedStepSummary["status"], theme: Theme, seed?: number): string {
	if (state === "running") return theme.fg("accent", runningGlyph(seed));
	if (state === "complete" || state === "completed") return theme.fg("success", "✓");
	if (state === "failed") return theme.fg("error", "✗");
	if (state === "paused") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

export function nestedRunSeed(run: NestedRunSummary): number | undefined {
	return runningSeed(run.lastUpdate, run.lastActivityAt, run.currentStep, run.toolCount, run.turnCount, run.totalTokens?.total, run.currentToolStartedAt);
}

export function nestedActivity(input: Pick<NestedRunSummary | NestedStepSummary, "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount">, state: NestedRunSummary["state"] | NestedStepSummary["status"], snapshotNow?: number): string {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined && snapshotNow !== undefined) facts.push(`${input.currentTool} ${formatDuration(Math.max(0, snapshotNow - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(input.currentTool);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	const activity = buildLiveStatusLine(input, snapshotNow);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	if (facts.length) return facts.join(" · ");
	if (state === "running") return "thinking…";
	if (state === "queued" || state === "pending") return "queued…";
	if (state === "paused") return "Paused";
	if (state === "failed") return "Failed";
	return "Done";
}

export function formatNestedWidgetLines(children: NestedRunSummary[] | undefined, theme: Theme, width: number, expanded: boolean, snapshotNow?: number, lineBudget = expanded ? 12 : 1): string[] {
	if (!children?.length || lineBudget <= 0) return [];
	if (!expanded) {
		const aggregate = formatNestedAggregate(children);
		return aggregate ? [theme.fg("dim", `↳ ${aggregate}`)] : [];
	}
	const lines: string[] = [];
	const maxDepth = 2;
	const append = (items: NestedRunSummary[] | undefined, depth: number, prefix: string): void => {
		if (!items?.length || lines.length >= lineBudget) return;
		if (depth > maxDepth) {
			const aggregate = formatNestedAggregate(items);
			if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}↳ ${aggregate}`));
			return;
		}
		for (let index = 0; index < items.length; index++) {
			const child = items[index]!;
			if (lines.length >= lineBudget) {
				const aggregate = formatNestedAggregate(items.slice(index));
				if (aggregate) lines[lines.length - 1] = theme.fg("dim", `${prefix}↳ ${aggregate}`);
				return;
			}
			const activity = nestedActivity(child, child.state, snapshotNow ?? child.lastUpdate);
			const error = child.error ? ` · ${child.error}` : "";
			lines.push(theme.fg("dim", `${prefix}↳ ${nestedStatusGlyph(child.state, theme, nestedRunSeed(child))} ${nestedRunName(child)} · ${child.state} · ${activity}${error}`));
			if (depth === maxDepth) {
				const aggregate = formatNestedAggregate([...(child.steps?.flatMap((step) => step.children ?? []) ?? []), ...(child.children ?? [])]);
				if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}  ↳ ${aggregate}`));
				continue;
			}
			for (const step of child.steps ?? []) {
				if (lines.length >= lineBudget) return;
				lines.push(theme.fg("dim", `${prefix}  ↳ ${nestedStatusGlyph(step.status, theme)} ${step.agent} · ${step.status} · ${nestedActivity(step, step.status, snapshotNow ?? child.lastUpdate)}`));
				append(step.children, depth + 1, `${prefix}    `);
			}
			append(child.children, depth + 1, `${prefix}  `);
		}
	};
	append(children, 0, "");
	return lines.map((line) => truncLine(line, width));
}

export function foregroundStyleWidgetStepLines(
	job: AsyncJobState,
	theme: Theme,
	step: NonNullable<AsyncJobState["steps"]>[number],
	itemTitle: "Agent" | "Step",
	index: number,
	total: number,
	expanded: boolean,
	width: number,
): string[] {
	const status = widgetStepStatus(step.status, theme);
	const stats = widgetStepStats(theme, step);
	const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
	const lines = [`  ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index - 1))} ${itemTitle} ${index}/${total}: ${themeBold(theme, step.agent)} ${theme.fg("dim", "·")} ${status}${modelDisplay}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`];
	const activity = widgetStepActivityLine(step, width, expanded, job.updatedAt);
	if (activity) lines.push(`    ${theme.fg("dim", `⎿  ${activity}`)}`);
	for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt)) {
		lines.push(`    ${nestedLine}`);
	}
	if (step.status === "running") {
		if (!expanded) lines.push(`    ${theme.fg("accent", liveDetailHintText())}`);
		const output = widgetOutputPath(job, step);
		if (output) lines.push(`    ${theme.fg("dim", `output: ${shortenPath(output)}`)}`);
		if (expanded) {
			const liveStatus = buildLiveStatusLine(step, job.updatedAt);
			if (liveStatus && liveStatus !== activity) lines.push(`    ${theme.fg("accent", liveStatus)}`);
			for (const tool of step.recentTools?.slice(-3) ?? []) {
				const maxArgsLen = Math.max(40, width - 30);
				const argsPreview = tool.args.length <= maxArgsLen ? tool.args : `${tool.args.slice(0, maxArgsLen)}...`;
				lines.push(`      ${theme.fg("dim", `${tool.tool}${argsPreview ? `: ${argsPreview}` : ""}`)}`);
			}
			for (const line of step.recentOutput?.slice(-5) ?? []) {
				lines.push(`      ${theme.fg("dim", line)}`);
			}
		}
	}
	return lines;
}

export function foregroundStyleWidgetDetails(job: AsyncJobState, theme: Theme, expanded: boolean, width: number): string[] {
	if (!job.steps?.length) return [
		`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
		...formatNestedWidgetLines(job.nestedChildren, theme, width, expanded, job.updatedAt).map((line) => `  ${line}`),
	];
	if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length) return widgetChainDetails(job, theme, expanded, width);
	const total = job.stepsTotal ?? job.steps.length;
	const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
	const lines: string[] = [];
	for (const [index, step] of job.steps.entries()) {
		lines.push(...foregroundStyleWidgetStepLines(job, theme, step, itemTitle, index + 1, total, expanded, width));
	}
	const attached = new Set(job.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
	const unattached = job.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
	for (const nestedLine of formatNestedWidgetLines(unattached, theme, width, expanded, job.updatedAt)) {
		lines.push(`  ${nestedLine}`);
	}
	return lines;
}

export function widgetChainDetails(job: AsyncJobState, theme: Theme, expanded = false, width = getTermWidth()): string[] {
	if (!job.steps?.length) return [];
	const total = job.chainStepCount ?? job.steps.length;
	const lines: string[] = [];
	for (const span of buildAsyncChainStepSpans(total, job.steps.length, job.parallelGroups)) {
		const steps = job.steps.slice(span.start, span.start + span.count);
		if (span.isParallel) {
			const status = aggregateStepStatus(steps);
			lines.push(`  ${widgetStepGlyph(status, theme, widgetStepsRunningSeed(steps))} Step ${span.stepIndex + 1}/${total}: ${themeBold(theme, "parallel group")} ${theme.fg("dim", "·")} ${theme.fg("dim", formatParallelOutcome(steps, span.count))}`);
			continue;
		}
		const step = steps[0];
		if (!step) {
			lines.push(`  ${theme.fg("dim", `◦ Step ${span.stepIndex + 1}/${total}: pending`)}`);
			continue;
		}
		lines.push(...foregroundStyleWidgetStepLines(job, theme, step, "Step", span.stepIndex + 1, total, expanded, width));
	}
	return lines;
}

export function widgetParallelAgentDetails(job: AsyncJobState, theme: Theme, expanded = false, width = getTermWidth()): string[] {
	if (!job.steps?.length) return [];
	if (job.mode !== "parallel" && job.mode !== "chain") return [];
	if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length) return widgetChainDetails(job, theme, expanded, width);
	const total = job.stepsTotal ?? job.steps.length;
	const lines: string[] = [];
	for (const [index, step] of job.steps.entries()) {
		const marker = index === job.steps.length - 1 ? "└" : "├";
		const activity = widgetStepActivity(step, job.updatedAt);
		const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
		const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
		lines.push(`  ${theme.fg("dim", `${marker} ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index))} ${itemTitle} ${index + 1}/${total}: ${step.agent} · ${widgetStepStatus(step.status, theme)}${modelDisplay}${activity ? ` · ${activity}` : ""}`)}`);
		for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt, expanded ? 8 : 1)) lines.push(`    ${nestedLine}`);
	}
	return lines;
}

export function buildSingleWidgetLines(job: AsyncJobState, theme: Theme, width: number, expanded: boolean): string[] {
	const stats = widgetStats(job, theme);
	const count = job.mode === "chain" ? job.chainStepCount : job.stepsTotal ?? job.agents?.length ?? job.steps?.length;
	const mode = widgetJobName(job);
	const title = `async subagent ${mode}${count && count > 1 ? ` (${count})` : ""}`;
	return [
		`${theme.fg("toolTitle", themeBold(theme, title))} ${theme.fg("dim", "· background")}`,
		`${widgetStatusGlyph(job, theme)} ${themeBold(theme, mode)}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
		...foregroundStyleWidgetDetails(job, theme, expanded, width),
	].map((line) => truncLine(line, width));
}

export function compactSingleWidgetLines(job: AsyncJobState, theme: Theme, width: number): string[] {
	const fullLines = buildSingleWidgetLines(job, theme, width, false);
	if (fullLines.length <= 10 || !job.steps?.length || (job.mode !== "parallel" && !job.activeParallelGroup)) return fullLines;

	const total = job.stepsTotal ?? job.steps.length;
	const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
	const lines = fullLines.slice(0, 2);
	for (const [index, step] of job.steps.entries()) {
		const status = widgetStepStatus(step.status, theme);
		const activity = widgetStepActivityLine(step, width, false, job.updatedAt);
		const stepStats = widgetStepStats(theme, step);
		const activitySuffix = activity ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", activity)}` : "";
		const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
		lines.push(`  ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index))} ${itemTitle} ${index + 1}/${total}: ${themeBold(theme, step.agent)} ${theme.fg("dim", "·")} ${status}${modelDisplay}${activitySuffix}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}`);
		for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, false, job.updatedAt)) lines.push(`    ${nestedLine}`);
	}
	if (job.steps.some((step) => step.status === "running")) lines.push(theme.fg("accent", `  ${liveDetailHintText()}`));
	return lines.map((line) => truncLine(line, width));
}
