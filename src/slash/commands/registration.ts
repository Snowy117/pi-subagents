import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../shared/types.ts";
import { registerPromptWorkflowCommands } from "../prompt-workflows.ts";
import { runSlashSubagent } from "./slash-run.ts";
import { sendSlashText } from "./slash-helpers.ts";
import { buildSubagentCostReport } from "./usage-report.ts";
import { registerExecutionCommands } from "./execution-commands.ts";
import { registerProfileCommands } from "./profile-commands.ts";

export function registerSlashCommands(
	pi: ExtensionAPI,
	state: SubagentState,
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

	registerPromptWorkflowCommands({
		pi,
		run: (params, ctx) => runSlashSubagent(pi, ctx, params),
	});

	registerProfileCommands(pi, state);
}
