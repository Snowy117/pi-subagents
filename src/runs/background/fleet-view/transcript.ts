import * as fs from "node:fs";
import * as path from "node:path";
import { formatModelThinking } from "../../../shared/formatters.ts";
import {
	type AsyncJobStep,
	type AsyncStatus,
	type NestedRunSummary,
	type SubagentRunMode,
} from "../../../shared/types.ts";
import { readStatus } from "../../../shared/utils.ts";
import { formatActivityFacts } from "./fleet.ts";
import { readContainedTextTail, readSessionTranscriptTail, transcriptLineLimit } from "./transcript-tail.ts";

interface TranscriptOptions {
	index?: number;
	lines?: number;
	sessionRoots?: string[];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function resolveMaybeRelative(asyncDir: string, filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	return path.resolve(asyncDir, filePath);
}

function validateTranscriptIndex(index: number | undefined, steps: AsyncJobStep[]): number | undefined {
	if (index === undefined) return undefined;
	if (!Number.isInteger(index)) throw new Error("Transcript index must be an integer.");
	if (index < 0 || index >= steps.length) throw new Error(`Transcript index ${index} is out of range for ${steps.length} child step${steps.length === 1 ? "" : "s"}.`);
	return index;
}

function selectTranscriptStep(status: AsyncStatus, options: TranscriptOptions): { index?: number; step?: AsyncJobStep; hint?: string } {
	const steps = status.steps ?? [];
	let selectedIndex = validateTranscriptIndex(options.index, steps);
	if (selectedIndex === undefined) {
		if (status.state === "running" && typeof status.currentStep === "number" && status.currentStep >= 0 && status.currentStep < steps.length) {
			selectedIndex = status.currentStep;
		} else if (steps.length === 1) {
			selectedIndex = 0;
		}
	}
	const step = selectedIndex !== undefined ? steps[selectedIndex] : undefined;
	const hint = options.index === undefined && steps.length > 1
		? `Tip: pass index to inspect a specific child transcript (${steps.map((candidate, index) => `${index}=${candidate.agent}`).join(", ")}).`
		: undefined;
	return { index: selectedIndex, step, hint };
}

function stepStateLine(mode: SubagentRunMode, index: number | undefined, step: AsyncJobStep | undefined): string | undefined {
	if (index === undefined || !step) return undefined;
	const modelThinking = formatModelThinking(step.model, step.thinking);
	const parts = [
		`${mode === "parallel" ? "Agent" : "Step"}: ${index} (${step.agent})`,
		step.status,
		formatActivityFacts(step),
		modelThinking,
		step.error ? `error: ${step.error}` : undefined,
	].filter(Boolean);
	return parts.join(" | ");
}

function appendKnownArtifacts(lines: string[], input: { outputPaths: string[]; sessionFile?: string; eventsPath?: string; logPath?: string; resultPath?: string }): void {
	const artifacts: string[] = [];
	for (const outputPath of input.outputPaths) artifacts.push(`Output: ${outputPath}`);
	if (input.sessionFile) artifacts.push(`Session: ${input.sessionFile}`);
	if (input.eventsPath) artifacts.push(`Events: ${input.eventsPath}`);
	if (input.logPath) artifacts.push(`Log: ${input.logPath}`);
	if (input.resultPath) artifacts.push(`Result: ${input.resultPath}`);
	if (!artifacts.length) return;
	lines.push("Artifacts:");
	for (const artifact of artifacts) lines.push(`  ${artifact}`);
}

function appendTranscriptBody(lines: string[], sourceLabel: string, sourceLines: string[], truncated: boolean): void {
	lines.push(`${sourceLabel}${truncated ? " (tail truncated)" : ""}:`);
	if (sourceLines.length === 0) {
		lines.push("  (no transcript lines available yet)");
		return;
	}
	for (const line of sourceLines) lines.push(`  ${line}`);
}

export function formatAsyncRunTranscript(status: AsyncStatus, asyncDir: string, options: TranscriptOptions = {}): string {
	const lineLimit = transcriptLineLimit(options.lines);
	const selected = selectTranscriptStep(status, options);
	const stepOutputPath = selected.index !== undefined ? path.join(asyncDir, `output-${selected.index}.log`) : undefined;
	const runOutputPath = resolveMaybeRelative(asyncDir, status.outputFile);
	const logPath = path.join(asyncDir, `subagent-log-${status.runId}.md`);
	const outputPaths = selected.index !== undefined
		? uniqueStrings([stepOutputPath, runOutputPath && stepOutputPath && path.resolve(runOutputPath) === path.resolve(stepOutputPath) ? runOutputPath : undefined])
		: uniqueStrings([runOutputPath]);
	const sessionFile = selected.index !== undefined ? selected.step?.sessionFile : status.sessionFile;
	const eventsPath = path.join(asyncDir, "events.jsonl");

	const lines = [
		`Run: ${status.runId}`,
		`State: ${status.state}`,
		`Mode: ${status.mode}`,
		stepStateLine(status.mode, selected.index, selected.step),
		selected.hint,
	].filter((line): line is string => Boolean(line));
	appendKnownArtifacts(lines, { outputPaths, sessionFile, eventsPath: fs.existsSync(eventsPath) ? eventsPath : undefined, logPath: fs.existsSync(logPath) ? logPath : undefined });

	const warnings: string[] = [];
	let transcriptLines: string[] = [];
	let transcriptSource = "Transcript tail";
	let truncated = false;
	for (const outputPath of outputPaths) {
		const tail = readContainedTextTail(outputPath, lineLimit, [asyncDir], "output");
		if (tail.error) warnings.push(`Output read failed for ${tail.path}: ${tail.error}`);
		if (tail.lines.length === 0) continue;
		transcriptLines = tail.lines;
		transcriptSource = `Transcript tail from ${tail.path}`;
		truncated = tail.truncated;
		break;
	}
	if (transcriptLines.length === 0 && selected.step?.recentOutput?.length) {
		transcriptLines = selected.step.recentOutput.slice(-lineLimit);
		transcriptSource = "Recent output from status.json";
	}
	if (transcriptLines.length === 0 && sessionFile) {
		const sessionTail = readSessionTranscriptTail(sessionFile, lineLimit, options.sessionRoots ?? []);
		transcriptLines = sessionTail.lines;
		warnings.push(...sessionTail.warnings);
		if (transcriptLines.length > 0) transcriptSource = `Session transcript tail from ${sessionFile}`;
	}

	if (warnings.length) {
		lines.push("Warnings:");
		for (const warning of warnings) lines.push(`  ${warning}`);
	}
	appendTranscriptBody(lines, transcriptSource, transcriptLines, truncated);
	return lines.join("\n");
}

export function formatNestedRunTranscript(run: NestedRunSummary, options: TranscriptOptions = {}): string {
	if (run.asyncDir) {
		const status = readStatus(run.asyncDir);
		if (status) return formatAsyncRunTranscript(status, run.asyncDir, options);
	}
	const lineLimit = transcriptLineLimit(options.lines);
	const lines = [
		`Nested run: ${run.id}`,
		`State: ${run.state}`,
		run.mode ? `Mode: ${run.mode}` : undefined,
		run.agent ? `Agent: ${run.agent}` : run.agents?.length ? `Agents: ${run.agents.join(", ")}` : undefined,
	].filter((line): line is string => Boolean(line));
	appendKnownArtifacts(lines, { outputPaths: [], sessionFile: run.sessionFile });
	if (!run.sessionFile) {
		appendTranscriptBody(lines, "Transcript tail", [], false);
		return lines.join("\n");
	}
	const sessionTail = readSessionTranscriptTail(run.sessionFile, lineLimit, options.sessionRoots ?? []);
	if (sessionTail.warnings.length) {
		lines.push("Warnings:");
		for (const warning of sessionTail.warnings) lines.push(`  ${warning}`);
	}
	appendTranscriptBody(lines, `Session transcript tail from ${run.sessionFile}`, sessionTail.lines, false);
	return lines.join("\n");
}

export function formatAsyncResultTranscript(data: {
	id?: string;
	runId?: string;
	state?: string;
	success?: boolean;
	summary?: string;
	output?: string;
	sessionFile?: string;
	agent?: string;
	exitCode?: number | null;
	results?: Array<{ agent?: string; output?: string; summary?: string; sessionFile?: string; state?: string; success?: boolean; exitCode?: number | null }>;
}, resultPath: string, options: TranscriptOptions = {}): string {
	const lineLimit = transcriptLineLimit(options.lines);
	const runId = data.runId ?? data.id ?? path.basename(resultPath, ".json");
	const children = Array.isArray(data.results)
		? data.results
		: data.agent
			? [{ agent: data.agent, output: data.output, summary: data.summary, sessionFile: data.sessionFile, state: data.state, success: data.success, exitCode: data.exitCode }]
			: [];
	let index = options.index;
	if (index !== undefined && !Number.isInteger(index)) throw new Error("Transcript index must be an integer.");
	if (index === undefined && children.length === 1) index = 0;
	if (index !== undefined && (index < 0 || index >= children.length)) throw new Error(`Transcript index ${index} is out of range for ${children.length} result child${children.length === 1 ? "" : "ren"}.`);
	const child = index !== undefined ? children[index] : undefined;
	const output = index !== undefined
		? child?.output ?? child?.summary ?? (children.length === 1 ? data.output ?? data.summary : undefined) ?? ""
		: data.output ?? data.summary ?? "";
	const transcriptLines = output.split(/\r?\n/).slice(-lineLimit);
	const sessionFile = child?.sessionFile ?? data.sessionFile;
	const lines = [
		`Run: ${runId}`,
		`State: ${data.state ?? (data.success ? "complete" : "failed")}`,
		index !== undefined && child ? `Child: ${index} (${child.agent ?? "subagent"})` : undefined,
		index === undefined && children.length > 1 ? `Tip: pass index to inspect a specific child transcript (${children.map((candidate, childIndex) => `${childIndex}=${candidate.agent ?? "subagent"}`).join(", ")}).` : undefined,
	].filter((line): line is string => Boolean(line));
	appendKnownArtifacts(lines, { outputPaths: [], sessionFile, resultPath });
	appendTranscriptBody(lines, "Result transcript tail", transcriptLines.filter((line) => line.trim()), output.split(/\r?\n/).length > lineLimit);
	return lines.join("\n");
}
