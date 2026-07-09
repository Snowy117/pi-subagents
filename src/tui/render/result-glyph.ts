import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Details } from "../../shared/types.ts";
import { progressRunningSeed, runningGlyph } from "./glyph-animation.ts";
import { firstOutputLine, hasEmptyTextOutputWithoutOutputTarget } from "./output-target.ts";

export function isDoneResult(result: Details["results"][number]): boolean {
	const status = result.progress?.status;
	if (status === "completed") return true;
	if (status === "running" || status === "pending") return false;
	if (result.interrupted || result.detached) return false;
	return result.exitCode === 0;
}

export function resultStatusLine(result: Details["results"][number], output: string): string {
	if (result.detached) return result.detachedReason ? `Detached: ${result.detachedReason}` : "Detached";
	if (result.interrupted) return "Paused";
	if (result.exitCode !== 0) return `Error: ${result.error ?? (firstOutputLine(output) || `exit ${result.exitCode}`)}`;
	if (result.acceptance?.status && result.acceptance.status !== "not-required") return `Done · acceptance: ${result.acceptance.status}`;
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return "Done (no text output)";
	return "Done";
}

export function resultGlyph(result: Details["results"][number], output: string, theme: Theme, running = result.progress?.status === "running", seed = progressRunningSeed(result.progress ?? result.progressSummary), frame?: number): string {
	if (running) {
		if (frame !== undefined) return theme.fg("accent", runningGlyph((seed ?? 0) + frame));
		return theme.fg("accent", runningGlyph(seed));
	}
	if (result.detached) return theme.fg("warning", "■");
	if (result.interrupted) return theme.fg("warning", "■");
	if (result.exitCode !== 0) return theme.fg("error", "✗");
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return theme.fg("warning", "✓");
	return theme.fg("success", "✓");
}
