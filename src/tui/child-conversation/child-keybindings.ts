/**
 * Child-mode keybinding resolution for the 7 app-level actions the viewer
 * intercepts while child mode is active (R1b / Q5=A).
 *
 * Resolution funnels through the SAME `KeybindingsManager` the main agent
 * uses — the pi-tui global singleton from `getKeybindings()`, initialized by
 * pi-coding-agent's InteractiveMode with the full KEYBINDINGS table, the user
 * `<agentDir>/keybindings.json` (defaults / remaps / legacy-name migration /
 * `[]` removal), and any extension prototype patches such as the leader-key
 * plugin's pending-gated `matches`. Hand-written `matchesKey` loops are
 * intentionally absent: a local reimplementation would drift from the main
 * view (e.g. resolving `"leader+m"` as a bare `m` and swallowing typed
 * letters), while the shared singleton is patched once for every consumer
 * (editor, CustomEditor, this key route).
 *
 * `CHILD_APP_DEFAULT_KEYS` is retained as the mirror table of the pi defaults
 * for the 7 actions — used by tests and documentation, and as the fallback
 * resolution source only when the global manager is unavailable (never
 * crash).
 */

import { getKeybindings, matchesKey, type Keybinding, type KeybindingsManager, type KeyId } from "@earendil-works/pi-tui";
import type * as fs from "node:fs";

export type ChildAppAction =
	| "interrupt"
	| "thinking.cycle"
	| "model.cycleForward"
	| "model.cycleBackward"
	| "model.select"
	| "tools.expand"
	| "thinking.toggle";

export const CHILD_APP_DEFAULT_KEYS: Record<ChildAppAction, string[]> = {
	interrupt: ["escape"],
	"thinking.cycle": ["shift+tab"],
	"model.cycleForward": ["ctrl+p"],
	"model.cycleBackward": ["shift+ctrl+p"],
	"model.select": ["ctrl+l"],
	"tools.expand": ["ctrl+o"],
	"thinking.toggle": ["ctrl+t"],
};

/** pi keybinding ids for the 7 child-mode actions (the `app.*` names from the
 *  pi runtime's KEYBINDINGS table). */
export const CHILD_APP_ACTION_IDS: Record<ChildAppAction, Keybinding> = {
	interrupt: "app.interrupt",
	"thinking.cycle": "app.thinking.cycle",
	"model.cycleForward": "app.model.cycleForward",
	"model.cycleBackward": "app.model.cycleBackward",
	"model.select": "app.model.select",
	"tools.expand": "app.tools.expand",
	"thinking.toggle": "app.thinking.toggle",
};

/** Resolution order: interrupt first, then the rest (matches the main-agent
 *  CustomEditor priority; no default-key overlaps exist — only user
 *  conflicts, where the first matching action wins). */
const CHILD_APP_ORDER: ChildAppAction[] = [
	"interrupt",
	"thinking.cycle",
	"model.cycleForward",
	"model.cycleBackward",
	"model.select",
	"tools.expand",
	"thinking.toggle",
];

export interface ChildKeybindings {
	/** Resolve a raw terminal input to the child action it maps to, or
	 *  undefined when no action matches. */
	actionForKey(data: string): ChildAppAction | undefined;
	/** Keys currently bound to the given action (empty when removed). */
	keysFor(action: ChildAppAction): string[];
	clearCache(): void;
}

export interface ChildKeybindingsOptions {
	/** Test injection: an isolated KeybindingsManager. When omitted, resolution
	 *  uses the pi-tui global singleton (`getKeybindings()`) — the same
	 *  instance the main agent's editor and CustomEditor resolve through. */
	manager?: KeybindingsManager;
	/** Accepted for source compatibility with the pre-manager implementation;
	 *  unused by the manager-backed resolution (the manager owns loading and
	 *  migration of `<agentDir>/keybindings.json`). */
	agentDir?: string;
	/** Accepted for source compatibility; unused by the manager-backed
	 *  resolution. */
	fs?: Pick<typeof fs, "existsSync" | "readFileSync">;
}

export function createChildKeybindings(options: ChildKeybindingsOptions = {}): ChildKeybindings {
	const manager = options.manager ?? getKeybindings();
	const managerUsable = typeof manager?.matches === "function" && typeof manager?.getKeys === "function";

	return {
		actionForKey(data: string): ChildAppAction | undefined {
			if (managerUsable) {
				for (const action of CHILD_APP_ORDER) {
					if (manager.matches(data, CHILD_APP_ACTION_IDS[action])) return action;
				}
				return undefined;
			}
			// Fallback: no usable manager (never crash) — resolve the mirror table.
			for (const action of CHILD_APP_ORDER) {
				for (const key of CHILD_APP_DEFAULT_KEYS[action]) {
					if (matchesKey(data, key as KeyId)) return action;
				}
			}
			return undefined;
		},
		keysFor(action) {
			if (managerUsable) return manager.getKeys(CHILD_APP_ACTION_IDS[action]);
			return [...CHILD_APP_DEFAULT_KEYS[action]];
		},
		clearCache() {
			// No-op: the global manager is authoritative and live; pi owns
			// loading and reloading keybindings.json.
		},
	};
}
