/**
 * Child-mode keybinding resolution for the 7 app-level actions the viewer
 * intercepts while child mode is active (R1b / Q5=A).
 *
 * The effective keys per action are the merge of pi's built-in defaults with
 * user overrides from `<agentDir>/keybindings.json` (with legacy-name
 * migration), exactly as the main agent reads them. Actions with empty
 * effective keys (user removed) are never intercepted.
 *
 * Because `KeybindingsManager` is exported only as a compile-time type from
 * the package root, this small module reimplements the merge — it is stable
 * because the defaults and the legacy migration map are a small fixed contract
 * (see `dist/core/keybindings.js` in the pinned package).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../shared/utils.ts";

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

const CHILD_APP_ACTION_IDS: Record<ChildAppAction, string> = {
	interrupt: "app.interrupt",
	"thinking.cycle": "app.thinking.cycle",
	"model.cycleForward": "app.model.cycleForward",
	"model.cycleBackward": "app.model.cycleBackward",
	"model.select": "app.model.select",
	"tools.expand": "app.tools.expand",
	"thinking.toggle": "app.thinking.toggle",
};

/** Legacy name → new name mapping (mirrors KEYBINDING_NAME_MIGRATIONS in the
 *  pi package for the 7 actions this module tracks). */
const LEGACY_MIGRATION: Record<string, string> = {
	interrupt: "app.interrupt",
	cycleThinkingLevel: "app.thinking.cycle",
	cycleModelForward: "app.model.cycleForward",
	cycleModelBackward: "app.model.cycleBackward",
	selectModel: "app.model.select",
	expandTools: "app.tools.expand",
	toggleThinking: "app.thinking.toggle",
};

/** Normalize a raw user-binding value to a string array, or undefined when
 *  the value is invalid (pi parity: invalid values are dropped and the action
 *  keeps its default). An explicit `[]` is a valid removal. */
function normalizeKeys(value: unknown): string[] | undefined {
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
	return undefined;
}

/** Read the raw keybindings.json, apply legacy-name migration (when both the
 *  legacy and the new name are present, legacy is skipped — pi parity), and
 *  return the migrated configuration as a Map (prototype-safe for hostile
 *  keys like `__proto__`). */
function loadMigratedConfig(fsImpl: Pick<typeof fs, "existsSync" | "readFileSync">, agentDir: string): Map<string, unknown> {
	const configPath = path.join(agentDir, "keybindings.json");
	let raw: Record<string, unknown> = {};
	try {
		if (fsImpl.existsSync(configPath)) {
			raw = JSON.parse(fsImpl.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
		}
	} catch {
		// Malformed file → ignore; defaults stay.
		return new Map();
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
	const rawKeys = Object.keys(raw);
	const migrated = new Map<string, unknown>();
	for (const key of rawKeys) {
		const legacyTarget = LEGACY_MIGRATION[key];
		const isLegacy = legacyTarget !== undefined;
		if (isLegacy && rawKeys.includes(legacyTarget)) continue;
		migrated.set(legacyTarget ?? key, raw[key]);
	}
	return migrated;
}

export interface ChildKeybindings {
	/** Resolve a raw terminal input to the child action it maps to, or
	 *  undefined when no action matches. */
	actionForKey(data: string): ChildAppAction | undefined;
	/** Keys currently bound to the given action (empty when removed). */
	keysFor(action: ChildAppAction): string[];
	clearCache(): void;
}

export interface ChildKeybindingsOptions {
	agentDir?: string;
	fs?: Pick<typeof fs, "existsSync" | "readFileSync">;
	now?: () => number;
	ttlMs?: number;
}

export function createChildKeybindings(options: ChildKeybindingsOptions = {}): ChildKeybindings {
	const agentDir = options.agentDir ?? getAgentDir();
	const fsImpl = options.fs ?? fs;
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? 30_000;
	let cached: { at: number; keys: Map<string, string[]> } | undefined;

	const load = (): Map<string, string[]> => {
		const effective = new Map<string, string[]>();
		for (const [action, keys] of Object.entries(CHILD_APP_DEFAULT_KEYS)) {
			effective.set(CHILD_APP_ACTION_IDS[action as ChildAppAction], keys);
		}
		const migrated = loadMigratedConfig(fsImpl, agentDir);
		for (const actionId of effective.keys()) {
			if (migrated.has(actionId)) {
				const userKeys = normalizeKeys(migrated.get(actionId));
				if (userKeys === undefined) continue;
				effective.set(actionId, userKeys);
			}
		}
		return effective;
	};

	const ensureLoaded = (): Map<string, string[]> => {
		if (cached && now() - cached.at < ttlMs) return cached.keys;
		const keys = load();
		cached = { at: now(), keys };
		return keys;
	};

	const idToAction = new Map<string, ChildAppAction>();
	for (const [action, id] of Object.entries(CHILD_APP_ACTION_IDS)) {
		idToAction.set(id, action as ChildAppAction);
	}

	return {
		actionForKey(data: string): ChildAppAction | undefined {
			const keys = ensureLoaded();
			for (const [actionId, keyList] of keys) {
				if (keyList.length === 0) continue;
				const action = idToAction.get(actionId);
				if (!action) continue;
				for (const key of keyList) {
					if (matchesKey(data, key as KeyId)) return action;
				}
			}
			return undefined;
		},
		keysFor(action) {
			return ensureLoaded().get(CHILD_APP_ACTION_IDS[action]) ?? [];
		},
		clearCache() {
			cached = undefined;
		},
	};
}