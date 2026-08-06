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
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${parallelCount})`,
					0,
					0,
				);
			const agent = args.tasks?.[0]?.agent || "delegate";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", agent)}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme, context) {
			clearLegacyResultAnimationTimer(context);
			return renderSubagentResult(result, options, theme);
		},

	};

	pi.registerTool(tool);
}
