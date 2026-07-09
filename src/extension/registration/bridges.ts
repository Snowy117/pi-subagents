import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Details, SubagentState } from "../../shared/types.ts";
import type { SubagentParamsLike } from "../../runs/foreground/subagent-executor.ts";
import { registerSlashSubagentBridge } from "../../slash/slash-bridge.ts";
import { registerPromptTemplateDelegationBridge } from "../../slash/prompt-template-bridge.ts";
import { registerSubagentRpcBridge } from "../rpc.ts";

type ExecuteFn = (
	id: string,
	params: SubagentParamsLike,
	signal: AbortSignal,
	onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
	ctx: ExtensionContext,
) => Promise<AgentToolResult<Details>>;

export function createSubagentBridges(
	events: ExtensionAPI["events"],
	state: SubagentState,
	execute: ExecuteFn,
): {
	executeSubagentCollapsed: ExecuteFn;
	slashBridge: ReturnType<typeof registerSlashSubagentBridge>;
	promptTemplateBridge: ReturnType<typeof registerPromptTemplateDelegationBridge>;
	rpcBridge: ReturnType<typeof registerSubagentRpcBridge>;
} {
	const executeSubagentCollapsed: ExecuteFn = (id, params, signal, onUpdate, ctx) => {
		if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
		return execute(id, params, signal, onUpdate, ctx);
	};

	const slashBridge = registerSlashSubagentBridge({
		events,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) =>
			executeSubagentCollapsed(id, params, signal, onUpdate, ctx),
	});

	const promptTemplateBridge = registerPromptTemplateDelegationBridge({
		events,
		getContext: () => state.lastUiContext,
		execute: async (requestId, request, signal, ctx, onUpdate) => {
			if (request.tasks && request.tasks.length > 0) {
				return executeSubagentCollapsed(
					requestId,
					{
						tasks: request.tasks,
						context: request.context,
						cwd: request.cwd,
						worktree: request.worktree,
						async: false,
						clarify: false,
					},
					signal,
					onUpdate,
					ctx,
				);
			}
			return executeSubagentCollapsed(
				requestId,
				{
					agent: request.agent,
					task: request.task,
					context: request.context,
					cwd: request.cwd,
					model: request.model,
					async: false,
					clarify: false,
				},
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	const rpcBridge = registerSubagentRpcBridge({
		events,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) => execute(id, params, signal, onUpdate, ctx),
	});

	return { executeSubagentCollapsed, slashBridge, promptTemplateBridge, rpcBridge };
}
