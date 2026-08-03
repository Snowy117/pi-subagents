import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostEditorConversationHandle } from "./host-editor-mode.ts";
import type { SteerViewController } from "./open-view.ts";

export function exitSubagentView(
	ctx: ExtensionContext,
	options: { hostEditor?: HostEditorConversationHandle; steerView?: SteerViewController; notify?: boolean },
): void {
	options.hostEditor?.close(ctx);
	options.steerView?.close();
	if (options.notify !== false) {
		ctx.ui.notify("Child conversation mode closed; editor input returns to the parent.", "info");
	}
}
