import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../shared/types.ts";
import type { SteerViewController } from "../../tui/steer-view/open-view.ts";
import type { HostEditorConversationHandle } from "../../tui/steer-view/host-editor-mode.ts";
import { exitSubagentView } from "../../tui/steer-view/exit-subagent-view.ts";

export function registerSlashCommands(
	pi: ExtensionAPI,
	state: SubagentState,
	steerView?: SteerViewController,
	hostEditor?: HostEditorConversationHandle,
): void {
	pi.registerCommand("subagents", {
		description: "Open the interactive subagent child viewer",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const trimmed = args.trim();
			if (trimmed === "exit" || trimmed === "close") {
				exitSubagentView(ctx, { hostEditor, steerView });
				return;
			}
			await steerView?.open(ctx);
		},
	});

}
