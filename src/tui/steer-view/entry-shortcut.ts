import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { SubagentState } from "../../shared/types.ts";
import type { SteerViewController } from "./open-view.ts";
import { hasActiveSteerViewTarget, type ListSteerViewTargetsOptions } from "./target-model.ts";

export function handleSubagentsPicker(
	input: string,
	ctx: ExtensionContext,
	state: SubagentState,
	controller: SteerViewController,
	keys: readonly KeyId[],
	targetOptions: ListSteerViewTargetsOptions = {},
): { consume: true } | undefined {
	if (!keys.some((key) => matchesKey(input, key))) return undefined;
	if (controller.modalOpen || ctx.ui.getEditorText().length !== 0) return undefined;
	if (!hasActiveSteerViewTarget(state, targetOptions)) return undefined;
	void controller.open(ctx).catch((error: unknown) => {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	});
	return { consume: true };
}
