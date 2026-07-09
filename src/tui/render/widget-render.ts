import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { MAX_WIDGET_JOBS, WIDGET_KEY, type AsyncJobState } from "../../shared/types.ts";
import { runningGlyph } from "./glyph-animation.ts";
import { themeBold } from "./stats.ts";
import { fitAdaptiveWidgetLines, resetWidgetLayoutSession } from "./widget-layout.ts";
import { buildSingleWidgetLines, compactSingleWidgetLines, widgetParallelAgentDetails } from "./widget-step.ts";
import { widgetActivity, widgetJobName, widgetJobsRunningSeed, widgetStats, widgetStatusGlyph } from "./widget-core.ts";
import { getTermWidth, truncLine } from "./text-wrap.ts";
import { Container, Text } from "./render.ts";

function buildWidgetComponent(jobs: AsyncJobState[], expanded: boolean): (_tui: unknown, theme: Theme) => Component {
	return (_tui, theme) => {
		const width = getTermWidth();
		const lines = expanded
			? buildWidgetLines(jobs, theme, width, true)
			: jobs.length === 1
				? compactSingleWidgetLines(jobs[0]!, theme, width)
				: buildWidgetLines(jobs, theme, width, false);
		const container = new Container();
		for (const line of fitAdaptiveWidgetLines(jobs, lines, theme, width, expanded)) container.addChild(new Text(line, 1, 0));
		return container;
	};
}

export function buildWidgetLines(jobs: AsyncJobState[], theme: Theme, width = getTermWidth(), expanded = false): string[] {
	if (jobs.length === 0) return [];
	if (jobs.length === 1) return buildSingleWidgetLines(jobs[0]!, theme, width, expanded);
	const running = jobs.filter((job) => job.status === "running");
	const queued = jobs.filter((job) => job.status === "queued");
	const finished = jobs.filter((job) => job.status !== "running" && job.status !== "queued");

	const lines: string[] = [];
	const hasActive = running.length > 0 || queued.length > 0;
	const headerGlyph = running.length > 0 ? runningGlyph(widgetJobsRunningSeed(running)) : hasActive ? "●" : "○";
	lines.push(truncLine(`${theme.fg(hasActive ? "accent" : "dim", headerGlyph)} ${theme.fg(hasActive ? "accent" : "dim", "Async agents")} ${theme.fg("dim", "· background")}`, width));

	const items: string[][] = [];
	let hiddenRunning = 0;
	let hiddenFinished = 0;
	let queuedSummaryShown = false;
	let slots = MAX_WIDGET_JOBS;

	for (const job of running) {
		if (slots <= 0) { hiddenRunning++; continue; }
		const stats = widgetStats(job, theme);
		items.push([
			`${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
			`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
			...widgetParallelAgentDetails(job, theme, expanded, width),
		]);
		slots--;
	}

	if (queued.length > 0 && slots > 0) {
		items.push([`${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`]);
		queuedSummaryShown = true;
		slots--;
	}

	for (const job of finished) {
		if (slots <= 0) { hiddenFinished++; continue; }
		const stats = widgetStats(job, theme);
		items.push([
			`${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
			`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
			...widgetParallelAgentDetails(job, theme, expanded, width),
		]);
		slots--;
	}

	const hiddenQueued = queued.length > 0 && !queuedSummaryShown ? queued.length : 0;
	const hiddenTotal = hiddenRunning + hiddenFinished + hiddenQueued;
	if (hiddenTotal > 0) {
		const parts: string[] = [];
		if (hiddenRunning > 0) parts.push(`${hiddenRunning} running`);
		if (hiddenQueued > 0) parts.push(`${hiddenQueued} queued`);
		if (hiddenFinished > 0) parts.push(`${hiddenFinished} finished`);
		items.push([theme.fg("dim", `+${hiddenTotal} more (${parts.join(", ")})`)]);
	}

	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const last = i === items.length - 1;
		const branch = last ? "└─" : "├─";
		const continuation = last ? "   " : "│  ";
		lines.push(truncLine(`${theme.fg("dim", branch)} ${item[0]}`, width));
		for (const detail of item.slice(1)) {
			lines.push(truncLine(`${theme.fg("dim", continuation)} ${detail}`, width));
		}
	}

	return lines;
}

/**
 * Render the async jobs widget
 */
export function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[]): void {
	if (jobs.length === 0) {
		resetWidgetLayoutSession();
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_KEY, buildWidgetComponent(jobs, ctx.ui.getToolsExpanded?.() ?? false));
}
