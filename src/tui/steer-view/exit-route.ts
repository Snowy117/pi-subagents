import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Keybinding } from "@earendil-works/pi-tui";

export interface SubagentExitRoute {
	handleInput(input: string): { consume: true } | undefined;
}

export function createSubagentExitRoute(options: {
	ctx: ExtensionContext;
	isActive: () => boolean;
	isEditableHostChild: () => boolean;
	close: (ctx: ExtensionContext) => void;
	manager?: ReturnType<typeof getKeybindings>;
}): SubagentExitRoute {
	const manager = options.manager ?? getKeybindings();
	const matches = (input: string, action: Keybinding): boolean => {
		try { return manager.matches(input, action); } catch { return false; }
	};
	return {
		handleInput(input) {
			if (!options.isActive()) return undefined;
			const text = options.ctx.ui.getEditorText();
			if (matches(input, "app.exit")) {
				if (text.length !== 0) return undefined;
				options.close(options.ctx);
				return { consume: true };
			}
			if (matches(input, "tui.input.submit")) {
				if (!options.isEditableHostChild()) return undefined;
				const command = text.trim();
				if (command === "/quit" || command === "/exit") {
					options.ctx.ui.setEditorText("");
					options.close(options.ctx);
					return { consume: true };
				}
			}
			return undefined;
		},
	};
}
