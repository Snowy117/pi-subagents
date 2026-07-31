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

export function createSteerViewRuntime(state: SubagentState, extensionConfig: ExtensionConfig): SteerViewRuntime {
	const config = resolveTuiConfig(extensionConfig);
	const controller = createSteerViewController(state, {
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
			terminalInputUnsubscribe = ctx.hasUI
				? ctx.ui.onTerminalInput((input) => handleSubagentsDown(input, ctx, state, controller, config))
				: undefined;
		},
		closeSession(): void {
			controller.close();
			cleanupSessionResources();
		},
		dispose(): void {
			controller.dispose();
			cleanupSessionResources();
		},
	};
}
