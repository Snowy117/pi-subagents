import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SubagentParamsLike } from "../../runs/foreground/subagent-executor.ts";
import { type ResolvedWaitToolConfig, waitForSubagents } from "../../runs/background/wait.ts";
import { type Details, type ExtensionConfig, type SubagentState } from "../../shared/types.ts";
import { renderSubagentResult, clearLegacyResultAnimationTimer } from "../../tui/render.ts";
import { SubagentParams, WaitParams } from "../schemas.ts";
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
	waitToolConfig: ResolvedWaitToolConfig;
	state: SubagentState;
	events: ExtensionAPI["events"];
	execute: ExecuteFn;
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
	const { config, waitToolConfig, state, events, execute } = options;

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
				const target = args.agent || args.chainName || "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
					0, 0,
				);
			}
			const isParallel = (args.tasks?.length ?? 0) > 0;
			const parallelCount = effectiveParallelTaskCount(args.tasks as Array<{ count?: unknown }> | undefined);
			const asyncLabel = args.async === true && args.clarify !== true ? theme.fg("warning", " [async]") : "";
			if (args.chain?.length)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}chain (${args.chain.length})${asyncLabel}`,
					0,
					0,
				);
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${parallelCount})${asyncLabel}`,
					0,
					0,
				);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
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

	const waitTool: ToolDefinition<typeof WaitParams, Details> = {
		name: "wait",
		label: "Wait",
		description: `Block until background (async) subagent runs started in this session finish, then return.

Use this after launching async subagents when you have no independent work left and must not end your turn — for example inside a skill that has to run to completion, or any non-interactive run (\`pi -p ...\`) where the whole task is a single turn and ending it would abandon the still-running children.

• { } — return as soon as the FIRST active run finishes (default). Ideal for a rolling fleet: launch N, wait, spawn a replacement for the one that finished, wait again — keeping N in flight.
• { all: true } — block until EVERY active run in this session is finished.
• { id: "..." } — wait for one specific run (id or prefix) to finish.
• { timeoutMs: 600000 } — stop waiting after N ms (the runs keep going regardless; default 30 min)

wait also returns when a run needs attention (a child that went idle or blocked for a decision), not only on completion — so a stuck child never stalls the loop; the summary names the run(s) to inspect/nudge/resume/interrupt. It wakes the instant a completion or control event arrives (subscribed to Pi's event bus, with a poll fallback that reconciles crashed runners), keeps the turn alive for normal notification delivery, and resolves early if the turn is aborted.${waitToolConfig.enabled ? "" : "\n\nConfigured behavior: wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED and returns immediately without blocking."}`,
		parameters: WaitParams,
		execute(_id, params, signal, _onUpdate, _ctx) {
			return waitForSubagents(params, signal, { state, events, enabled: waitToolConfig.enabled });
		},
	};
	pi.registerTool(waitTool);
}
