import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { SubagentState } from "../../shared/types.ts";
import { RunPickerComponent } from "./run-picker.ts";
import { SteerViewComponent, type SteerViewResult } from "./steer-view-component.ts";
import { listSteerViewTargets, type ListSteerViewTargetsOptions, type SteerViewTarget } from "./target-model.ts";

export interface SteerViewController {
	readonly modalOpen: boolean;
	open(ctx: ExtensionContext): Promise<void>;
	close(): void;
	dispose(): void;
}

export interface SteerViewControllerOptions extends ListSteerViewTargetsOptions {
	isStaleContextError?: (error: unknown) => boolean;
	trustedRoots?: (ctx: ExtensionContext) => string[];
}

const FULL_OVERLAY = { anchor: "center" as const, width: "100%" as const, maxHeight: "100%" as const, margin: 0 };

export function createSteerViewController(
	_state: SubagentState,
	options: SteerViewControllerOptions = {},
): SteerViewController {
	let modalOpen = false;
	let disposed = false;
	let cancelEpoch = 0;
	let closeCurrent: (() => void) | undefined;
	const showPicker = async (ctx: ExtensionContext): Promise<SteerViewTarget | undefined> => {
		const targets = listSteerViewTargets(_state, options).filter((target) => target.active);
		if (targets.length === 0) {
			ctx.ui.notify("No active subagent children to view.", "info");
			return undefined;
		}
		return ctx.ui.custom<SteerViewTarget | undefined>(
			(_tui: TUI, theme: Theme, _kb, done) => {
				closeCurrent = () => done(undefined);
				return new RunPickerComponent(targets, theme, done);
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: 88, maxHeight: "80%" } },
		);
	};
	const withTrustedRoots = (ctx: ExtensionContext, target: SteerViewTarget): SteerViewTarget => ({
		...target,
		trustedRoots: [...new Set([...(target.trustedRoots ?? []), ...(options.trustedRoots?.(ctx) ?? [])])],
	});
	const showChat = async (ctx: ExtensionContext, target: SteerViewTarget): Promise<SteerViewResult> =>
		ctx.ui.custom<SteerViewResult>(
			(tui: TUI, theme: Theme, _kb, done) => {
				const component = new SteerViewComponent(tui, theme, withTrustedRoots(ctx, target), done, {
					refreshTarget: () => {
						const refreshed = listSteerViewTargets(_state, options).find((candidate) => candidate.key === target.key);
						return refreshed ? withTrustedRoots(ctx, refreshed) : undefined;
					},
				});
				closeCurrent = () => done({ kind: "picker" });
				return component;
			},
			{ overlay: true, overlayOptions: FULL_OVERLAY },
		);
	return {
		get modalOpen() { return modalOpen; },
		async open(ctx: ExtensionContext): Promise<void> {
			if (modalOpen || disposed || !ctx.hasUI) return;
			modalOpen = true;
			const openEpoch = cancelEpoch;
			try {
				let target = await showPicker(ctx);
				while (target && !disposed && openEpoch === cancelEpoch) {
					const result = await showChat(ctx, target);
					if (openEpoch !== cancelEpoch) return;
					if (result.kind === "slash") {
						ctx.ui.setEditorText(result.text);
						return;
					}
					target = await showPicker(ctx);
				}
			} catch (error) {
				if (!options.isStaleContextError?.(error)) throw error;
			} finally {
				closeCurrent = undefined;
				modalOpen = false;
			}
		},
		close(): void {
			cancelEpoch++;
			closeCurrent?.();
			closeCurrent = undefined;
		},
		dispose(): void {
			disposed = true;
			this.close();
		},
	};
}
