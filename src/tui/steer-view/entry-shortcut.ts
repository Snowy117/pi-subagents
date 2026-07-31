import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { SubagentState, TuiConfig } from "../../shared/types.ts";
import type { SteerViewController } from "./open-view.ts";
import { hasActiveSteerViewTarget, type ListSteerViewTargetsOptions } from "./target-model.ts";

export function handleSubagentsDown(
	input: string,
	ctx: ExtensionContext,
	state: SubagentState,
	controller: SteerViewController,
	config: TuiConfig,
	targetOptions: ListSteerViewTargetsOptions = {},
): { consume: true } | undefined {
	if (!config.openSubagentsOnDown || !matchesKey(input, Key.down)) return undefined;
	if (controller.modalOpen || ctx.ui.getEditorText().length !== 0) return undefined;
	if (!hasActiveSteerViewTarget(state, targetOptions)) return undefined;
	void controller.open(ctx).catch((error: unknown) => {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	});
	return { consume: true };
}
