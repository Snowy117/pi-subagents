import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../shared/types.ts";
import { registerPromptWorkflowCommands } from "../prompt-workflows.ts";
import { runSlashSubagent } from "./slash-run.ts";
import { sendSlashText } from "./slash-helpers.ts";
import { buildSubagentCostReport } from "./usage-report.ts";
import { registerExecutionCommands } from "./execution-commands.ts";
import { registerProfileCommands } from "./profile-commands.ts";
import type { SteerViewController } from "../../tui/steer-view/open-view.ts";
import type { HostEditorConversationHandle } from "../../tui/steer-view/host-editor-mode.ts";

export function registerSlashCommands(
	pi: ExtensionAPI,
	state: SubagentState,
	steerView?: SteerViewController,
	hostEditor?: HostEditorConversationHandle,
): void {
	registerExecutionCommands(pi, state);

	pi.registerCommand("subagent-cost", {
		description: "Show parent and subagent child usage cost for this session",
		handler: async (_args, ctx) => {
			sendSlashText(pi, buildSubagentCostReport(ctx));
		},
	});

	pi.registerCommand("subagents-doctor", {
		description: "Show subagent diagnostics",
		handler: async (_args, ctx) => {
			await runSlashSubagent(pi, ctx, { action: "doctor" });
		},
	});

	pi.registerCommand("subagents-fleet", {
		description: "Show active subagent fleet status and transcript commands",
		handler: async (_args, ctx) => {
			await runSlashSubagent(pi, ctx, { action: "status", view: "fleet" });
		},
	});

	pi.registerCommand("subagents", {
		description: "Open the interactive subagent child viewer",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const trimmed = args.trim();
			if (trimmed === "exit" || trimmed === "close") {
				hostEditor?.close(ctx);
				steerView?.close();
				ctx.ui.notify("Child conversation mode closed; editor input returns to the parent.", "info");
				return;
			}
			await steerView?.open(ctx);
		},
	});

	registerPromptWorkflowCommands({
		pi,
		run: (params, ctx) => runSlashSubagent(pi, ctx, params),
	});

	registerProfileCommands(pi, state);
}
