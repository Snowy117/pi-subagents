import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { SubagentState } from "../../shared/types.ts";
import { createLocalRpcChannel, type ChildConversationChannel } from "../child-conversation/channel.ts";
import { RunPickerComponent } from "./run-picker.ts";
import { SteerViewComponent, type SteerViewResult } from "./steer-view-component.ts";
import { listSteerViewTargets, type ListSteerViewTargetsOptions, type SteerViewTarget } from "./target-model.ts";
import type { ResolveChildChannel } from "./child-channel.ts";

export interface SteerViewController {
	readonly modalOpen: boolean;
	open(ctx: ExtensionContext): Promise<void>;
	close(): void;
	dispose(): void;
}

export interface SteerViewControllerOptions extends ListSteerViewTargetsOptions {
	isStaleContextError?: (error: unknown) => boolean;
	trustedRoots?: (ctx: ExtensionContext) => string[];
	/** Optional host-editor routing mode; when a child channel can be resolved
	 *  the picker activates it instead of the full-screen overlay chat. */
	hostEditor?: import("./host-editor-mode.ts").HostEditorConversationHandle;
	/** Resolve (possible reopen/bridge) the child conversation channel; the
	 *  host-editor path uses it instead of a resident handle directly. */
	resolveChildChannel?: ResolveChildChannel;
	/** Synchronous picker predicate: is there a live resident for this target?
	 *  (Session-file reopenability is derived from the target itself.) */
	getResidentChild?: (target: SteerViewTarget) => import("../../runs/persistent/rpc-child-registry.ts").PersistentRpcChild | undefined;
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
		// Selectable: a live child (active/resident) or any target with a
		// persisted session the resolver can reopen (no continuity ⇒ hidden).
		const targets = listSteerViewTargets(_state, options).filter((target) =>
			target.active
			|| options.getResidentChild?.(target) !== undefined
			|| Boolean(target.sessionFile));
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
	const showChat = async (ctx: ExtensionContext, target: SteerViewTarget): Promise<SteerViewResult> => {
		// Host-editor routing mode: resolve the child conversation channel and
		// keep the real editor, routing submissions to the child; the widget
		// shows the transcript above the editor. Activation happens
		// synchronously; open() observes hostEditor.active and exits. When no
		// channel can be resolved (no resident, no bridge, no reopenable
		// session) the custom overlay is the explicit degraded surface.
		if (options.hostEditor && (options.resolveChildChannel || options.getResidentChild)) {
			// Re-selecting the active target is a no-op for host-editor mode.
			if (options.hostEditor.active && options.hostEditor.targetKey === target.key) {
				return { kind: "picker" };
			}
			// Switching target while host-editor mode is active: close the old
			// conversation first so the new selection routes to the new child.
			if (options.hostEditor.active && options.hostEditor.targetKey !== target.key) {
				options.hostEditor.close(ctx);
			}
			let channel: ChildConversationChannel | undefined;
			if (options.resolveChildChannel) {
				try {
					channel = await options.resolveChildChannel(ctx, target);
				} catch {
					// A resolver failure degrades to the overlay; it must not crash
					// the picker flow.
				}
			} else {
				// Backward-compatible pre-Phase-5 path: a caller that only wires
				// the synchronous resident getter keeps host-editor behavior.
				const resident = options.getResidentChild?.(target);
				channel = resident ? createLocalRpcChannel(resident) : undefined;
			}
			if (options.hostEditor.open(ctx, target, channel)) {
				ctx.ui.notify(`Conversation routed to ${target.agent} (child mode). Use /subagents exit to return.`, "info");
				return { kind: "picker" };
			}
		}
		return ctx.ui.custom<SteerViewResult>(
			(tui: TUI, theme: Theme, _kb, done) => {
				const component = new SteerViewComponent(tui, theme, withTrustedRoots(ctx, target), done, {
					refreshTarget: () => {
						const refreshed = listSteerViewTargets(_state, options).find((candidate) => candidate.key === target.key);
						return refreshed ? withTrustedRoots(ctx, refreshed) : undefined;
					},
					cwd: ctx.cwd,
					getToolsExpanded: () => {
						try {
							return ctx.ui.getToolsExpanded();
						} catch {
							// A stale UI context must not break the degraded surface.
							return false;
						}
					},
				});
				closeCurrent = () => done({ kind: "picker" });
				return component;
			},
			{ overlay: true, overlayOptions: FULL_OVERLAY },
		);
	};
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
					// Host-editor mode stays active after picker selection; the loop
					// exits and the input handler routes submissions until exit.
					if (options.hostEditor?.active) {
						return;
					}
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
