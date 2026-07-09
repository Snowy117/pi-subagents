import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatTokens, formatDuration } from "../../shared/formatters.ts";
import type { AgentProgress, Details } from "../../shared/types.ts";

export function themeBold(theme: Theme, text: string): string {
	return ((theme as { bold?: (value: string) => string }).bold?.(text)) ?? text;
}

export function statJoin(theme: Theme, parts: string[]): string {
	return parts.filter(Boolean).map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `);
}

export function formatTokenStat(tokens: number): string {
	return `${formatTokens(tokens)} token`;
}

export function formatToolUseStat(count: number): string {
	return `${count} tool use${count === 1 ? "" : "s"}`;
}

export function formatTotalCostStat(totalCost: Details["totalCost"] | undefined): string {
	if (!totalCost || (totalCost.inputTokens === 0 && totalCost.outputTokens === 0 && totalCost.costUsd === 0)) return "";
	const parts: string[] = [];
	if (totalCost.inputTokens) parts.push(`in:${formatTokens(totalCost.inputTokens)}`);
	if (totalCost.outputTokens) parts.push(`out:${formatTokens(totalCost.outputTokens)}`);
	if (totalCost.costUsd) parts.push(`$${totalCost.costUsd.toFixed(4)}`);
	return parts.join(" ");
}

export function formatProgressStats(theme: Theme, progress: Pick<AgentProgress, "toolCount" | "tokens" | "durationMs"> | undefined, includeDuration = true): string {
	if (!progress) return "";
	const parts: string[] = [];
	if (progress.toolCount > 0) parts.push(formatToolUseStat(progress.toolCount));
	if (progress.tokens > 0) parts.push(formatTokenStat(progress.tokens));
	if (includeDuration && progress.durationMs > 0) parts.push(formatDuration(progress.durationMs));
	return statJoin(theme, parts);
}
