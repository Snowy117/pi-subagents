import { KeybindingsManager, type KeybindingDefinitions, type KeybindingsConfig, type KeyId } from "@earendil-works/pi-tui";
import { CHILD_APP_ACTION_IDS, CHILD_APP_DEFAULT_KEYS, type ChildAppAction } from "../../src/tui/child-conversation/child-keybindings.ts";

/**
 * Legacy name → new name mapping (mirrors KEYBINDING_NAME_MIGRATIONS in the
 * pi package for the 7 actions the child keybindings module tracks).
 */
const LEGACY_MIGRATION: Record<string, string> = {
	interrupt: "app.interrupt",
	cycleThinkingLevel: "app.thinking.cycle",
	cycleModelForward: "app.model.cycleForward",
	cycleModelBackward: "app.model.cycleBackward",
	selectModel: "app.model.select",
	expandTools: "app.tools.expand",
	toggleThinking: "app.thinking.toggle",
};

/**
 * Mirrors the pi runtime's migrateKeybindingsConfig + toKeybindingsConfig for
 * the 7 child-mode actions: legacy names migrate to their app.* ids (skipped
 * when the new name is also present); string values pass through; string
 * arrays pass through; any other value is dropped so the action keeps its
 * default.
 */
export function toChildKeybindingsConfig(raw: Record<string, unknown>): KeybindingsConfig {
	const config: KeybindingsConfig = {};
	const rawKeys = Object.keys(raw);
	for (const [key, value] of Object.entries(raw)) {
		const nextKey = LEGACY_MIGRATION[key] ?? key;
		if (nextKey !== key && rawKeys.includes(nextKey)) continue;
		if (typeof value === "string") config[nextKey] = value;
		else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) config[nextKey] = value as string[];
	}
	return config;
}

/**
 * Build an isolated pi-tui KeybindingsManager for the 7 child-mode actions:
 * definitions from CHILD_APP_DEFAULT_KEYS, user bindings from a raw config
 * (the shape of a parsed keybindings.json) via the pi parser rules.
 */
export function makeChildKeybindingsManager(userBindings: Record<string, unknown> = {}): KeybindingsManager {
	const definitions: KeybindingDefinitions = {};
	for (const [action, id] of Object.entries(CHILD_APP_ACTION_IDS)) {
		definitions[id] = { defaultKeys: CHILD_APP_DEFAULT_KEYS[action as ChildAppAction] as KeyId[] };
	}
	return new KeybindingsManager(definitions, toChildKeybindingsConfig(userBindings));
}
