import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import type { ExtensionConfig, TuiConfig } from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";

export function getConfigPath(): string {
	return path.join(getAgentDir(), "extensions", "subagent", "config.json");
}

export const DEFAULT_TUI_CONFIG: TuiConfig = { openSubagentsOnDown: true };

export interface ResolvedPersistentChildConfig {
	enabled: boolean;
	idleEvictionMs: number;
	maxResidentChildren: number;
}

export const DEFAULT_PERSISTENT_CHILD_CONFIG: ResolvedPersistentChildConfig = {
	enabled: true,
	idleEvictionMs: 15 * 60 * 1000,
	maxResidentChildren: 4,
};

export function resolvePersistentChildConfig(config: ExtensionConfig): ResolvedPersistentChildConfig {
	const raw = config.persistentChildren;
	const enabled = typeof raw === "object" && raw !== null
		? raw.enabled !== false
		: typeof raw === "boolean"
			? raw
			: DEFAULT_PERSISTENT_CHILD_CONFIG.enabled;
	const eviction = typeof raw === "object" && raw !== null ? raw.eviction : undefined;
	return {
		enabled,
		idleEvictionMs: typeof eviction?.idleMs === "number" && eviction.idleMs > 0
			? eviction.idleMs
			: DEFAULT_PERSISTENT_CHILD_CONFIG.idleEvictionMs,
		maxResidentChildren: typeof eviction?.maxResidentChildren === "number" && eviction.maxResidentChildren > 0
			? eviction.maxResidentChildren
			: DEFAULT_PERSISTENT_CHILD_CONFIG.maxResidentChildren,
	};
}

export function resolveTuiConfig(config: ExtensionConfig): TuiConfig {
	return {
		openSubagentsOnDown: typeof config.tui?.openSubagentsOnDown === "boolean"
			? config.tui.openSubagentsOnDown
			: DEFAULT_TUI_CONFIG.openSubagentsOnDown,
	};
}

function readConfigForUpdate(configPath = getConfigPath()): ExtensionConfig {
	if (!fs.existsSync(configPath)) return {};
	const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Subagent config at '${configPath}' must be a JSON object`);
	}
	return parsed as ExtensionConfig;
}

export function saveConfig(config: ExtensionConfig, configPath = getConfigPath()): void {
	writeAtomicJson(configPath, config);
}

export function updateConfig(updater: (config: ExtensionConfig) => ExtensionConfig): ExtensionConfig {
	const configPath = getConfigPath();
	const next = updater(readConfigForUpdate(configPath));
	saveConfig(next, configPath);
	return next;
}

export function loadConfig(): ExtensionConfig {
	const configPath = getConfigPath();
	try {
		return readConfigForUpdate(configPath);
	} catch (error) {
		console.error(`Failed to load subagent config from '${configPath}':`, error);
	}
	return {};
}
