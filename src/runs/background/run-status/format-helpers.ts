import * as fs from "node:fs";
import { formatActivityLabel } from "../../../shared/status-format.ts";
import { type AsyncStatus, type ForegroundResumeRun, type NestedRunSummary } from "../../../shared/types.ts";
import { formatNestedRunStatusLines } from "../../shared/nested-render.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "../parallel-groups.ts";

export function hasExistingSessionFile(value: unknown): value is string {
	return typeof value === "string" && fs.existsSync(value);
}

export function formatResumeGuidance(runId: string | undefined, children: Array<{ agent?: unknown; sessionFile?: unknown }>, fallbackSessionFile?: unknown): string {
	const knownChildren = children
		.map((child, index) => ({ child, index }))
		.filter(({ child }) => typeof child.agent === "string");
	if (!runId || knownChildren.length === 0) return "Resume: unavailable; no child session file was persisted.";
	const singleSessionFile = knownChildren[0]?.child.sessionFile ?? fallbackSessionFile;
	if (children.length === 1 && knownChildren.length === 1 && hasExistingSessionFile(singleSessionFile)) {
		return `Revive: subagent({ action: "resume", id: "${runId}", message: "..." })`;
	}
	const childWithSession = knownChildren.find(({ child }) => hasExistingSessionFile(child.sessionFile));
	if (childWithSession) {
		return `Revive child: subagent({ action: "resume", id: "${runId}", index: ${childWithSession.index}, message: "..." })`;
	}
	return "Resume: unavailable; no child session file was persisted.";
}

export function stepLineLabel(status: AsyncStatus, index: number): string {
	const steps = status.steps ?? [];
	if (status.mode === "parallel") return `Agent ${index + 1}/${steps.length || 1}`;
	if (status.mode === "chain") {
		const chainStepCount = status.chainStepCount ?? (steps.length || 1);
		const groups = normalizeParallelGroups(status.parallelGroups, steps.length, chainStepCount);
		const group = groups.find((candidate) => index >= candidate.start && index < candidate.start + candidate.count);
		if (group) return `Step ${group.stepIndex + 1}/${chainStepCount} Agent ${index - group.start + 1}/${group.count}`;
		return `Step ${flatToLogicalStepIndex(index, chainStepCount, groups) + 1}/${chainStepCount}`;
	}
	return `Step ${index + 1}`;
}

export function nestedRunDisplayName(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return run.agents.join(", ");
	return run.id;
}

export function formatSteeringSummary(input: { steerCount?: number; lastSteerAt?: number }): string | undefined {
	const parts: string[] = [];
	if (input.steerCount !== undefined) parts.push(`${input.steerCount} steer${input.steerCount === 1 ? "" : "s"}`);
	if (typeof input.lastSteerAt === "number" && Number.isFinite(input.lastSteerAt)) parts.push(`last ${new Date(input.lastSteerAt).toISOString()}`);
	return parts.length ? parts.join(", ") : undefined;
}

export function rememberedForegroundChildOutput(child: ForegroundResumeRun["children"][number]): string {
	const outputPath = child.artifactPaths?.outputPath ?? child.savedOutputPath;
	if (outputPath && fs.existsSync(outputPath)) {
		try {
			const artifactOutput = fs.readFileSync(outputPath, "utf-8").trim();
			if (artifactOutput) return artifactOutput;
		} catch {
			// Fall back to the remembered snapshot below.
		}
	}
	return child.finalOutput ?? "";
}

export function formatRememberedForegroundStatus(run: ForegroundResumeRun): string {
	const lines = [
		`Run: ${run.runId}`,
		"State: remembered foreground",
		`Mode: ${run.mode}`,
		`Updated: ${new Date(run.updatedAt).toISOString()}`,
		`Cwd: ${run.cwd}`,
	];
	for (const child of run.children) {
		const output = rememberedForegroundChildOutput(child).trim().split(/\r?\n/).find((line) => line.trim());
		const parts = [
			`${child.index + 1}. ${child.agent} ${child.status}`,
			child.exitCode !== undefined ? `exit ${child.exitCode}` : undefined,
			child.detachedReason ? `detached: ${child.detachedReason}` : undefined,
			output ? `output: ${output.slice(0, 160)}` : undefined,
		].filter(Boolean);
		lines.push(parts.join(", "));
		if (child.sessionFile) lines.push(`  Session: ${child.sessionFile}`);
		if (child.transcriptPath) lines.push(`  Transcript: ${child.transcriptPath}`);
		if (child.artifactPaths?.outputPath) lines.push(`  Output: ${child.artifactPaths.outputPath}`);
		if (child.savedOutputPath && child.savedOutputPath !== child.artifactPaths?.outputPath) lines.push(`  Saved output: ${child.savedOutputPath}`);
		if (child.outputSaveError) lines.push(`  Output warning: ${child.outputSaveError}`);
		if (child.transcriptError) lines.push(`  Transcript warning: ${child.transcriptError}`);
	}
	lines.push("", `Status: subagent({ action: "status", id: "${run.runId}" })`);
	if (run.children.length === 1) lines.push(`Transcript: subagent({ action: "status", id: "${run.runId}", view: "transcript" })`);
	else lines.push(`Transcript: subagent({ action: "status", id: "${run.runId}", index: 0, view: "transcript" })`);
	const resumable = run.children.find((child) => child.status !== "detached" && hasExistingSessionFile(child.sessionFile));
	if (resumable) {
		lines.push(run.children.length === 1
			? `Revive: subagent({ action: "resume", id: "${run.runId}", message: "..." })`
			: `Revive child: subagent({ action: "resume", id: "${run.runId}", index: ${resumable.index}, message: "..." })`);
	} else if (run.children.some((child) => child.status === "detached")) {
		lines.push("Recovery: child detached for intercom coordination; status will show recovered output after the child exits when Pi can observe it.");
	} else {
		lines.push("Resume: unavailable; no child session file was persisted.");
	}
	return lines.join("\n");
}

export function formatRememberedForegroundTranscript(run: ForegroundResumeRun, options: { index?: number; lines?: number }): string {
	let index = options.index;
	if (index !== undefined && !Number.isInteger(index)) throw new Error("Transcript index must be an integer.");
	if (index === undefined && run.children.length === 1) index = 0;
	if (index === undefined) return `Transcript view requires index for foreground run '${run.runId}' with ${run.children.length} children.`;
	if (index < 0 || index >= run.children.length) throw new Error(`Transcript index ${index} is out of range for ${run.children.length} foreground children.`);
	const child = run.children[index]!;
	const lineLimit = Math.max(1, Math.min(options.lines ?? 80, 1000));
	const outputLines = rememberedForegroundChildOutput(child).split(/\r?\n/).filter((line) => line.trim()).slice(-lineLimit);
	const lines = [
		`Run: ${run.runId}`,
		`State: ${child.status}`,
		`Child: ${index} (${child.agent})`,
		child.sessionFile ? `Session: ${child.sessionFile}` : undefined,
		child.transcriptPath ? `Transcript: ${child.transcriptPath}` : undefined,
		child.artifactPaths?.outputPath ? `Output: ${child.artifactPaths.outputPath}` : undefined,
		child.savedOutputPath && child.savedOutputPath !== child.artifactPaths?.outputPath ? `Saved output: ${child.savedOutputPath}` : undefined,
		child.outputSaveError ? `Output warning: ${child.outputSaveError}` : undefined,
	].filter((line): line is string => Boolean(line));
	lines.push("Result transcript tail:");
	if (outputLines.length === 0) lines.push("  (no recovered final output available yet)");
	else for (const line of outputLines) lines.push(`  ${line}`);
	return lines.join("\n");
}

export function formatNestedExactStatus(rootRunId: string, run: NestedRunSummary): string {
	const lines = [
		`Nested run: ${run.id}`,
		`Root: ${rootRunId}`,
		`Parent: ${run.parentRunId}${run.parentStepIndex !== undefined ? ` step ${run.parentStepIndex + 1}` : ""}`,
		`State: ${run.state}`,
		run.activityState || run.lastActivityAt ? `Activity: ${formatActivityLabel(run.lastActivityAt, run.activityState)}` : undefined,
		run.mode ? `Mode: ${run.mode}` : undefined,
		`Agent: ${nestedRunDisplayName(run)}`,
		run.currentStep !== undefined ? `Progress: step ${run.currentStep + 1}/${run.chainStepCount ?? run.steps?.length ?? 1}` : undefined,
		run.turnBudget ? `Turn budget: ${run.turnBudget.turnCount}/${run.turnBudget.maxTurns}+${run.turnBudget.graceTurns} (${run.turnBudget.outcome})` : undefined,
		run.asyncDir ? `Dir: ${run.asyncDir}` : undefined,
		run.sessionFile ? `Session: ${run.sessionFile}` : undefined,
		run.error ? `Error: ${run.error}` : undefined,
	].filter((line): line is string => Boolean(line));
	if (run.path.length) {
		lines.push(`Path: ${run.path.map((part) => `${part.runId}${part.stepIndex !== undefined ? `:${part.stepIndex + 1}` : ""}${part.agent ? `:${part.agent}` : ""}`).join(" > ")} > ${run.id}`);
	}
	if (run.steps?.length) {
		lines.push("Steps:");
		for (const [index, step] of run.steps.entries()) {
			const activity = step.status === "running" ? formatActivityLabel(step.lastActivityAt, step.activityState) : undefined;
			const budget = step.turnBudget ? `, turn budget: ${step.turnBudget.turnCount}/${step.turnBudget.maxTurns}+${step.turnBudget.graceTurns} (${step.turnBudget.outcome})` : "";
			lines.push(`  ${index + 1}. ${step.agent} ${step.status}${activity ? `, ${activity}` : ""}${budget}${step.error ? `, error: ${step.error}` : ""}`);
			lines.push(...formatNestedRunStatusLines(step.children, { indent: "    ", commandHints: true }));
		}
	}
	lines.push(...formatNestedRunStatusLines(run.children, { indent: "  ", commandHints: true }));
	lines.push("Commands:", `  Status: subagent({ action: "status", id: "${run.id}" })`, `  Interrupt: subagent({ action: "interrupt", id: "${run.id}" })`, `  Resume: subagent({ action: "resume", id: "${run.id}", message: "..." })`, `  Steer: subagent({ action: "steer", id: "${run.id}", message: "..." })`, `  Root status: subagent({ action: "status", id: "${rootRunId}" })`);
	return lines.join("\n");
}
