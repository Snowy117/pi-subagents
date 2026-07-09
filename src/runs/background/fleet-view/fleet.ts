import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { formatDuration, formatModelThinking, formatTokens, shortenPath } from "../../../shared/formatters.ts";
import { formatActivityLabel } from "../../../shared/status-format.ts";
import {
	ASYNC_DIR,
	RESULTS_DIR,
	type ActivityState,
	type Details,
	type SubagentState,
} from "../../../shared/types.ts";
import { formatNestedRunStatusLines } from "../../shared/nested-render.ts";
import { formatAsyncRunOutputPath, formatAsyncRunProgressLabel, listAsyncRuns, type AsyncRunSummary } from "../async-status.ts";

type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
type ForegroundRun = NonNullable<SubagentState["foregroundRuns"]> extends Map<string, infer T> ? T : never;

interface FleetViewParams {
	lines?: number;
}

interface FleetViewDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	state?: SubagentState;
	childSafe?: boolean;
}

export function formatActivityFacts(input: {
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	tokens?: { total: number };
}): string | undefined {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined) facts.push(`tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(`tool ${input.currentTool}`);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	if (input.tokens?.total) facts.push(`${formatTokens(input.tokens.total)} tok`);
	const activity = formatActivityLabel(input.lastActivityAt, input.activityState);
	return activity || facts.length ? [activity, ...facts].filter(Boolean).join(" | ") : undefined;
}

function foregroundModeName(control: ForegroundControl): string {
	if (control.mode === "single" && control.currentAgent) return control.currentAgent;
	return control.mode;
}

function formatForegroundFleetLines(controls: ForegroundControl[]): string[] {
	if (controls.length === 0) return [];
	const lines = ["Foreground runs:"];
	const ordered = [...controls].sort((left, right) => right.updatedAt - left.updatedAt);
	for (const control of ordered) {
		const activity = formatActivityFacts({
			activityState: control.currentActivityState,
			lastActivityAt: control.lastActivityAt,
			currentTool: control.currentTool,
			currentToolStartedAt: control.currentToolStartedAt,
			currentPath: control.currentPath,
			turnCount: control.turnCount,
			toolCount: control.toolCount,
			...(control.tokens !== undefined ? { tokens: { total: control.tokens } } : {}),
		});
		const current = control.currentAgent ? ` | ${control.currentAgent}${control.currentIndex !== undefined ? ` #${control.currentIndex}` : ""}` : "";
		lines.push(`- ${control.runId} | running | ${foregroundModeName(control)}${current}${activity ? ` | ${activity}` : ""}`);
		lines.push(`  status: subagent({ action: "status", id: "${control.runId}" })`);
		lines.push("  transcript: live in the expanded foreground result; persisted session transcript appears after completion when sessions are enabled.");
		lines.push(...formatNestedRunStatusLines(control.nestedChildren, { indent: "  ", commandHints: true, maxLines: 12 }));
	}
	return lines;
}

function formatDetachedForegroundFleetLines(runs: ForegroundRun[]): string[] {
	if (runs.length === 0) return [];
	const lines = ["Detached foreground runs:"];
	const ordered = [...runs].sort((left, right) => right.updatedAt - left.updatedAt);
	for (const run of ordered) {
		const detachedChildren = run.children.filter((child) => child.status === "detached");
		const childSummary = detachedChildren.map((child) => `${child.agent} #${child.index}`).join(", ");
		lines.push(`- ${run.runId} | detached | ${run.mode}${childSummary ? ` | ${childSummary}` : ""}`);
		lines.push(`  status: subagent({ action: "status", id: "${run.runId}" })`);
		lines.push("  recovery: reply to the supervisor request first; status will recover output after the child exits.");
	}
	return lines;
}

function formatAsyncFleetLines(runs: AsyncRunSummary[]): string[] {
	if (runs.length === 0) return [];
	const lines = ["Async runs:"];
	for (const run of runs) {
		const progress = formatAsyncRunProgressLabel(run);
		const activity = formatActivityFacts(run);
		const cwd = run.cwd ? shortenPath(run.cwd) : shortenPath(run.asyncDir);
		const pending = run.pendingAppends ? ` | ${run.pendingAppends} pending append${run.pendingAppends === 1 ? "" : "s"}` : "";
		lines.push(`- ${run.id} | ${run.state}${activity ? ` | ${activity}` : ""} | ${run.mode} | ${progress}${pending} | ${cwd}`);
		lines.push(`  status: subagent({ action: "status", id: "${run.id}" })`);
		lines.push(`  transcript: subagent({ action: "status", id: "${run.id}", view: "transcript" })`);
		for (const step of run.steps) {
			const display = step.label ? `${step.label} (${step.agent})` : step.agent;
			const phase = step.phase ? `[${step.phase}] ` : "";
			const stepActivity = formatActivityFacts(step);
			const modelThinking = formatModelThinking(step.model, step.thinking);
			const parts = [`${step.index}. ${phase}${display}`, step.status, stepActivity, modelThinking].filter(Boolean);
			lines.push(`  ${parts.join(" | ")}`);
			const output = path.join(run.asyncDir, `output-${step.index}.log`);
			if (fs.existsSync(output)) lines.push(`    output: ${shortenPath(output)}`);
			if (step.sessionFile) lines.push(`    session: ${shortenPath(step.sessionFile)}`);
			if (step.status === "running" || step.recentOutput?.length || fs.existsSync(output)) {
				lines.push(`    transcript: subagent({ action: "status", id: "${run.id}", index: ${step.index}, view: "transcript" })`);
			}
			lines.push(...formatNestedRunStatusLines(step.children, { indent: "    ", commandHints: true, maxLines: 12 }));
		}
		const attached = new Set(run.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
		const unattached = run.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
		lines.push(...formatNestedRunStatusLines(unattached, { indent: "  ", commandHints: true, maxLines: 12 }));
		if (run.error) lines.push(`  error: ${run.error}`);
		for (const warning of run.nestedWarnings ?? []) lines.push(`  warning: ${warning}`);
		const outputPath = formatAsyncRunOutputPath(run);
		if (outputPath) lines.push(`  output: ${shortenPath(outputPath)}`);
		if (run.sessionFile) lines.push(`  session: ${shortenPath(run.sessionFile)}`);
	}
	return lines;
}

export function inspectSubagentFleet(_params: FleetViewParams, deps: FleetViewDeps = {}): AgentToolResult<Details> {
	if (deps.childSafe) {
		return {
			content: [{ type: "text", text: "Child-safe subagent fleet view is unavailable without an explicit run id. Use subagent({ action: \"status\", id: \"...\" }) for the delegated run you can see." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	let asyncRuns: AsyncRunSummary[];
	try {
		asyncRuns = listAsyncRuns(deps.asyncDirRoot ?? ASYNC_DIR, {
			states: ["queued", "running"],
			sessionId: deps.state?.currentSessionId ?? undefined,
			resultsDir: deps.resultsDir ?? RESULTS_DIR,
			kill: deps.kill,
			now: deps.now,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
	}

	const foregroundControls = deps.state ? [...deps.state.foregroundControls.values()] : [];
	const activeForegroundIds = new Set(foregroundControls.map((control) => control.runId));
	const detachedForegroundRuns = deps.state?.foregroundRuns
		? [...deps.state.foregroundRuns.values()].filter((run) => !activeForegroundIds.has(run.runId) && run.children.some((child) => child.status === "detached"))
		: [];
	const total = foregroundControls.length + detachedForegroundRuns.length + asyncRuns.length;
	if (total === 0) {
		return {
			content: [{ type: "text", text: "No active subagent fleet. Background runs that already finished are available through completion notifications or subagent({ action: \"status\", id: \"...\" })." }],
			details: { mode: "management", results: [] },
		};
	}

	const lines = [`Subagent fleet: ${total} tracked`, ""];
	const foregroundLines = formatForegroundFleetLines(foregroundControls);
	if (foregroundLines.length) lines.push(...foregroundLines, "");
	const detachedForegroundLines = formatDetachedForegroundFleetLines(detachedForegroundRuns);
	if (detachedForegroundLines.length) lines.push(...detachedForegroundLines, "");
	const asyncLines = formatAsyncFleetLines(asyncRuns);
	if (asyncLines.length) lines.push(...asyncLines, "");
	lines.push("Commands:");
	lines.push("  Refresh fleet: subagent({ action: \"status\", view: \"fleet\" })");
	lines.push("  Tail run transcript: subagent({ action: \"status\", id: \"<run-id>\", view: \"transcript\" })");
	lines.push("  Tail child transcript: subagent({ action: \"status\", id: \"<run-id>\", index: 0, view: \"transcript\" })");

	return { content: [{ type: "text", text: lines.join("\n").trimEnd() }], details: { mode: "management", results: [] } };
}
