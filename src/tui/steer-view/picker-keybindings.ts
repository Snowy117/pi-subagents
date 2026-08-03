import * as fs from "node:fs";
import * as path from "node:path";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../shared/utils.ts";

export const SUBAGENTS_OPEN_PICKER_ACTION = "subagents.openPicker";
const BASE_KEYS = new Set([
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear", "home", "end", "pageUp", "pageDown", "up", "down", "left", "right",
	"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
	..."abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;'./!@#$%^&*()_+|~{}:<>?",
]);
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isValidKeyId(value: unknown): value is KeyId {
	if (typeof value !== "string" || value.length === 0) return false;
	const pieces = value.split("+");
	const key = pieces.at(-1);
	if (!key || !BASE_KEYS.has(key)) return false;
	const modifiers = pieces.slice(0, -1);
	return modifiers.length <= 4 && modifiers.every((modifier, index) => MODIFIERS.has(modifier) && modifiers.indexOf(modifier) === index);
}

export interface PickerKeybindingReader {
	keys(): readonly KeyId[];
	matches(input: string): boolean;
}

export interface PickerKeybindingOptions {
	agentDir?: string;
	fs?: Pick<typeof fs, "existsSync" | "readFileSync">;
	onError?: (error: unknown) => void;
}

export function readPickerKeys(options: PickerKeybindingOptions = {}): KeyId[] {
	const fsApi = options.fs ?? fs;
	const filePath = path.join(options.agentDir ?? getAgentDir(), "keybindings.json");
	if (!fsApi.existsSync(filePath)) return [];
	try {
		const parsed = JSON.parse(fsApi.readFileSync(filePath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		const value = (parsed as Record<string, unknown>)[SUBAGENTS_OPEN_PICKER_ACTION];
		if (value === undefined || value === null) return [];
		const values = Array.isArray(value) ? value : [value];
		if (!Array.isArray(value) && typeof value !== "string") return [];
		if (!values.every(isValidKeyId)) return [];
		return [...new Set(values)];
	} catch (error) {
		options.onError?.(error);
		return [];
	}
}

export function createPickerKeybindingReader(options: PickerKeybindingOptions = {}): PickerKeybindingReader {
	const keys = readPickerKeys(options);
	return { keys: () => keys, matches: (input) => keys.some((key) => matchesKey(input, key)) };
}
