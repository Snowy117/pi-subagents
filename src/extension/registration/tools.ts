import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SubagentParamsLike } from "../../runs/foreground/subagent-executor.ts";
import { type Details, type ExtensionConfig, type SubagentState } from "../../shared/types.ts";
import { renderSubagentResult, clearLegacyResultAnimationTimer } from "../../tui/render.ts";
import { SubagentParams } from "../schemas.ts";
import { buildSubagentToolDescription } from "../tool-description.ts";

type ExecuteFn = (
	id: string,
	params: SubagentParamsLike,
	signal: AbortSignal,
	onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
	ctx: ExtensionContext,
) => Promise<AgentToolResult<Details>>;

interface RegisterSubagentToolsOptions {
	config: ExtensionConfig;
	execute: ExecuteFn;
}

export function resolveCallerDetachPolicy(args: { async?: boolean }, config: Pick<ExtensionConfig, "asyncByDefault" | "forceTopLevelAsync">): boolean {
	if (config.forceTopLevelAsync === true) return true;
	if (args.async !== undefined) return args.async === true;
	return config.asyncByDefault === true;
}

// Drives the inline running-indicator braille animation for foreground subagent
// results. Foreground runs receive progress only on child events, so the glyph
// (derived from progress fields) would freeze between events. While a result is
// running we tick a frame counter + invalidate() every 80ms so renderSubagentResult
// can blend the frame into runningGlyph and produce a smooth spinner.
function subagentResultIsRunning(result: { details?: Details }): boolean {
	return result.details?.progress?.some((entry) => entry.status === "running")
		|| result.details?.results.some((entry) => entry.progress?.status === "running")
		|| false;
}

function ensureSubagentResultAnimation(context: { state: Record<string, unknown>; invalidate?: () => void }): void {
	const state = context.state as { subagentResultAnimationTimer?: ReturnType<typeof setInterval>; frame?: number };
	if (state.subagentResultAnimationTimer) return;
	if (typeof context.invalidate !== "function") return;
	if (state.frame === undefined) state.frame = 0;
	state.subagentResultAnimationTimer = setInterval(() => {
		state.frame = ((state.frame ?? 0) + 1) % 10;
		try {
			context.invalidate();
		} catch {}
	}, 80);
}

export function registerSubagentTools(pi: ExtensionAPI, options: RegisterSubagentToolsOptions): void {
	const { config, execute } = options;

	function effectiveParallelTaskCount(tasks: Array<{ count?: unknown }> | undefined): number {
		if (!tasks || tasks.length === 0) return 0;
		return tasks.reduce((total, task) => {
			const count = typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
			return total + count;
		}, 0);
	}

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		description: buildSubagentToolDescription(config),
		parameters: SubagentParams,

		execute(id, params, signal, onUpdate, ctx) {
			return execute(id, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			if (args.action) {
				const target = args.id || "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
					0, 0,
				);
			}
			const parallelCount = effectiveParallelTaskCount(args.tasks as Array<{ count?: unknown }> | undefined);
			const isParallel = parallelCount > 1;
			const asyncLabel = resolveCallerDetachPolicy(args, config) ? theme.fg("warning", " [async]") : "";
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${parallelCount})${asyncLabel}`,
					0,
					0,
				);
			const agent = args.tasks?.[0]?.agent || "delegate";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", agent)}${asyncLabel}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme, context) {
			if (subagentResultIsRunning(result)) {
				ensureSubagentResultAnimation(context);
			} else {
				clearLegacyResultAnimationTimer(context);
			}
			const frame = (context.state as { frame?: number } | undefined)?.frame ?? 0;
			return renderSubagentResult(result, options, theme, frame);
		},

	};

	pi.registerTool(tool);
}
