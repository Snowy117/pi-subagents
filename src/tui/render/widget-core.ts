import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatModelThinking } from "../../shared/formatters.ts";
import type { AsyncJobStep } from "../../shared/types.ts";
import { runningGlyph } from "./glyph-animation.ts";

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

export function modelThinkingBadge(theme: Theme, model?: string, thinking?: string): string {
	const label = formatModelThinking(model, thinking);
	return label ? theme.fg("dim", ` (${label})`) : "";
}
