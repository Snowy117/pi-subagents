import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveTuiConfig } from "../../extension/config.ts";
import { expandTilde, getSubagentSessionRoot, isStaleExtensionContextError } from "../../extension/registration/session-paths.ts";
import { cleanupForegroundLiveChildren } from "../../runs/foreground/foreground-live-registry.ts";
import type { ExtensionConfig, SubagentState } from "../../shared/types.ts";
import { handleSubagentsDown } from "./entry-shortcut.ts";
import { createSteerViewController, type SteerViewController } from "./open-view.ts";

export interface SteerViewRuntime {
	controller: SteerViewController;
	startSession(ctx: ExtensionContext): void;
	closeSession(): void;
	dispose(): void;
}

export interface SteerViewRuntimeOptions {
	hostEditor?: import("./host-editor-mode.ts").HostEditorConversationHandle;
	hostEditorResolver?: import("./child-channel.ts").ResolveChildChannel;
	getResidentChild?: (target: import("./target-model.ts").SteerViewTarget) => import("../../runs/persistent/rpc-child-registry.ts").PersistentRpcChild | undefined;
	/** Optional child-mode app-level key router (R1b); registered with
	 *  onTerminalInput while the session is active, gated internally on child
	 *  mode being active. */
	keyRoute?: import("./child-key-route.ts").ChildKeyRoute;
}

export function createSteerViewRuntime(state: SubagentState, extensionConfig: ExtensionConfig, options: SteerViewRuntimeOptions = {}): SteerViewRuntime {
	const config = resolveTuiConfig(extensionConfig);
	const controller = createSteerViewController(state, {
		hostEditor: options.hostEditor,
		resolveChildChannel: options.hostEditorResolver,
		getResidentChild: options.getResidentChild,
		isStaleContextError: isStaleExtensionContextError,
		trustedRoots: (ctx) => {
			const roots = extensionConfig.defaultSessionDir ? [path.resolve(expandTilde(extensionConfig.defaultSessionDir))] : [];
			const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
			if (sessionFile) roots.push(getSubagentSessionRoot(sessionFile));
			return roots;
		},
	});
	let terminalInputUnsubscribe: (() => void) | undefined;
	const unsubscribeTerminalInput = (): void => {
		terminalInputUnsubscribe?.();
		terminalInputUnsubscribe = undefined;
	};
	const cleanupSessionResources = (): void => {
		unsubscribeTerminalInput();
		cleanupForegroundLiveChildren(state.foregroundLiveChildren, fs);
	};
	return {
		controller,
		startSession(ctx): void {
			controller.close();
			unsubscribeTerminalInput();
			const handlers: Array<(input: string) => { consume?: boolean } | undefined> = [];
			if (ctx.hasUI) {
				handlers.push((input) => handleSubagentsDown(input, ctx, state, controller, config));
				if (options.keyRoute) handlers.push((input) => options.keyRoute?.handleInput(input));
			}
			// Terminal listeners run in registration order; each returns undefined
			// when it does not own the input so the editor still receives it.
			terminalInputUnsubscribe = handlers.length > 0
				? ctx.ui.onTerminalInput((input) => {
					for (const handler of handlers) {
						const result = handler(input);
						if (result) return result;
					}
					return undefined;
				})
				: undefined;
		},
		closeSession(): void {
			controller.close();
			cleanupSessionResources();
		},
		dispose(): void {
			controller.dispose();
			options.keyRoute?.dispose();
			cleanupSessionResources();
		},
	};
}
