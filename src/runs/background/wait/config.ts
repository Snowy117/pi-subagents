import { type WaitToolConfig } from "../../../shared/types.ts";

export const WAIT_TOOL_ENABLED_ENV = "PI_SUBAGENT_WAIT_TOOL_ENABLED";

export interface ResolvedWaitToolConfig {
	enabled: boolean;
}

const WAIT_TOOL_TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const WAIT_TOOL_FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

function parseWaitToolEnabledEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (WAIT_TOOL_TRUE_VALUES.has(normalized)) return true;
	if (WAIT_TOOL_FALSE_VALUES.has(normalized)) return false;
	throw new Error(`${WAIT_TOOL_ENABLED_ENV} must be one of true/false, 1/0, yes/no, on/off, or enabled/disabled.`);
}

function configWaitToolEnabled(config: unknown): boolean | undefined {
	if (config === undefined) return undefined;
	if (typeof config === "boolean") return config;
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error("config.waitTool must be a boolean or an object with optional enabled boolean.");
	}
	const enabled = (config as { enabled?: unknown }).enabled;
	if (enabled === undefined) return undefined;
	if (typeof enabled !== "boolean") throw new Error("config.waitTool.enabled must be a boolean.");
	return enabled;
}

export function resolveWaitToolConfig(config?: WaitToolConfig, env: Record<string, string | undefined> = process.env): ResolvedWaitToolConfig {
	return {
		enabled: parseWaitToolEnabledEnv(env[WAIT_TOOL_ENABLED_ENV]) ?? configWaitToolEnabled(config) ?? true,
	};
}
