import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { CostSummary, ModelAttempt, TokenUsage, Usage } from "../../../shared/types.ts";
import type { RunnerStatusStep } from "./types.ts";

export function findLatestSessionFile(sessionDir: string): string | null {
	try {
		const files = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(sessionDir, f));
		if (files.length === 0) return null;
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return files[0] ?? null;
	} catch {
		// Session lookup is optional metadata.
		return null;
	}
}

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function tokenUsageFromAttempts(attempts: ModelAttempt[] | undefined): TokenUsage | null {
	if (!attempts || attempts.length === 0) return null;
	let input = 0;
	let output = 0;
	for (const attempt of attempts) {
		input += attempt.usage?.input ?? 0;
		output += attempt.usage?.output ?? 0;
	}
	const total = input + output;
	return total > 0 ? { input, output, total } : null;
}

export function costSummaryFromAttempts(attempts: ModelAttempt[] | undefined): CostSummary | undefined {
	if (!attempts || attempts.length === 0) return undefined;
	let inputTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	for (const attempt of attempts) {
		inputTokens += attempt.usage?.input ?? 0;
		outputTokens += attempt.usage?.output ?? 0;
		costUsd += attempt.usage?.cost ?? 0;
	}
	return inputTokens > 0 || outputTokens > 0 || costUsd > 0
		? { inputTokens, outputTokens, costUsd }
		: undefined;
}

export function appendRecentStepOutput(step: RunnerStatusStep, lines: string[]): void {
	const nonEmpty = lines.filter((line) => line.trim());
	if (nonEmpty.length === 0) return;
	step.recentOutput ??= [];
	step.recentOutput.push(...nonEmpty);
	if (step.recentOutput.length > 50) {
		step.recentOutput.splice(0, step.recentOutput.length - 50);
	}
}

export function isTerminalAssistantStop(message: Message): boolean {
	const stopReason = (message as { stopReason?: string }).stopReason;
	const hasToolCall = Array.isArray(message.content)
		&& message.content.some((part) => (part as { type?: string }).type === "toolCall");
	return stopReason === "stop" && !hasToolCall;
}

export function resetStepLiveDetail(step: RunnerStatusStep): void {
	step.currentTool = undefined;
	step.currentToolArgs = undefined;
	step.currentToolStartedAt = undefined;
	step.currentPath = undefined;
	step.recentTools = [];
	step.recentOutput = [];
}

