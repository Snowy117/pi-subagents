/**
 * Subagent recursion-depth and spawn-limit resolution: normalize config/env
 * overrides and resolve the effective limits enforced per run/session.
 */

import { DEFAULT_SUBAGENT_MAX_DEPTH, DEFAULT_MAX_SUBAGENT_SPAWNS_PER_SESSION } from "./constants.ts";

function normalizeNonNegativeInteger(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
	return normalizeNonNegativeInteger(value);
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
	return normalizeMaxSubagentDepth(process.env.PI_SUBAGENT_MAX_DEPTH)
		?? normalizeMaxSubagentDepth(configMaxDepth)
		?? DEFAULT_SUBAGENT_MAX_DEPTH;
}

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

export function checkSubagentDepth(configMaxDepth?: number): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	const blocked = Number.isFinite(depth) && depth >= maxDepth;
	return { blocked, depth, maxDepth };
}

export function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
	const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	return {
		PI_SUBAGENT_DEPTH: String(nextDepth),
		PI_SUBAGENT_MAX_DEPTH: String(normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth()),
	};
}

export function normalizeMaxSubagentSpawnsPerSession(value: unknown): number | undefined {
	return normalizeNonNegativeInteger(value);
}

export function resolveMaxSubagentSpawnsPerSession(configMaxSpawns?: number): number {
	return normalizeMaxSubagentSpawnsPerSession(process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION)
		?? normalizeMaxSubagentSpawnsPerSession(configMaxSpawns)
		?? DEFAULT_MAX_SUBAGENT_SPAWNS_PER_SESSION;
}
