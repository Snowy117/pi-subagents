/**
 * Agent-management foundation helpers.
 *
 * Shared action types, result builder, config/param parsing, agent/chain
 * lookup, validation warnings, and target resolution. Exported for use by
 * the handler submodules; the public barrel re-exports only the handlers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type AgentScope,
	type AgentSource,
	type ChainConfig,
	type ChainStepConfig,
	discoverAgentsAll,
	parsePackageName,
} from "../agents.ts";
import { discoverAvailableSkills } from "../skills.ts";
import type { Details, ExtensionConfig } from "../../shared/types.ts";

export type ManagementAction = "list" | "get" | "models" | "create" | "update" | "delete" | "eject" | "disable" | "enable" | "reset";
export type ManagementScope = "user" | "project";
export type ManagementContext = Pick<ExtensionContext, "cwd" | "modelRegistry"> & { model?: ExtensionContext["model"]; config?: ExtensionConfig };

export interface ManagementParams {
	action?: string;
	agent?: string;
	chainName?: string;
	agentScope?: string;
	config?: unknown;
}

export function result(text: string, isError = false): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], isError, details: { mode: "management", results: [] } };
}

export function parseCsv(value: string): string[] {
	return [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
}

export function configObject(config: unknown): { value?: Record<string, unknown>; error?: string } {
	let val = config;
	if (typeof val === "string") {
		try {
			val = JSON.parse(val);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { error: `config must be valid JSON: ${message}` };
		}
	}
	if (!val || typeof val !== "object" || Array.isArray(val)) return {};
	return { value: val as Record<string, unknown> };
}

export function hasKey(obj: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

export function asDisambiguationScope(scope: unknown): ManagementScope | undefined {
	if (scope === "user" || scope === "project") return scope;
	return undefined;
}

export function actionScope(scope: unknown, action: ManagementAction): { scope?: ManagementScope; error?: AgentToolResult<Details> } {
	if (scope === undefined) return { scope: "user" };
	const parsed = asDisambiguationScope(scope);
	return parsed ? { scope: parsed } : { error: result(`agentScope must be 'user' or 'project' for ${action}.`, true) };
}

export function normalizeListScope(scope: unknown): AgentScope | undefined {
	if (scope === undefined) return "both";
	if (scope === "user" || scope === "project" || scope === "both") return scope;
	return undefined;
}

export function sanitizeName(name: string): string {
	return name.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

export function parsePackageConfig(value: unknown): { packageName?: string; error?: string } {
	return parsePackageName(value, "config.package");
}

export function allAgents(d: { builtin: AgentConfig[]; package: AgentConfig[]; user: AgentConfig[]; project: AgentConfig[] }): AgentConfig[] {
	return [...d.builtin, ...d.package, ...d.user, ...d.project];
}

export function availableNames(cwd: string, kind: "agent" | "chain"): string[] {
	const d = discoverAgentsAll(cwd);
	const items = kind === "agent" ? allAgents(d) : d.chains;
	return [...new Set(items.map((x) => x.name))].sort((a, b) => a.localeCompare(b));
}

export function findAgents(name: string, cwd: string, scope: AgentScope = "both"): AgentConfig[] {
	const d = discoverAgentsAll(cwd);
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	return allAgents(d)
		.filter((a) => (scope === "both" || a.source === scope) && (a.name === raw || a.name === sanitized))
		.sort((a, b) => a.source.localeCompare(b.source));
}

export function findChains(name: string, cwd: string, scope: AgentScope = "both"): ChainConfig[] {
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	return discoverAgentsAll(cwd).chains
		.filter((c) => (scope === "both" || c.source === scope) && (c.name === raw || c.name === sanitized))
		.sort((a, b) => a.source.localeCompare(b.source));
}

export const AGENT_SOURCE_PRECEDENCE: Record<AgentSource, number> = { builtin: 0, package: 1, user: 2, project: 3 };

// Returns the highest-precedence agent for a name (project > user > package > builtin,
// matching mergeAgentsForScope for "both"), including disabled agents so disable/enable/reset
// can locate agents that runtime discovery filters out.
export function pickEffectiveAgent(d: ReturnType<typeof discoverAgentsAll>, name: string): AgentConfig | undefined {
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	const matches = allAgents(d).filter((a) => a.name === raw || a.name === sanitized);
	if (matches.length === 0) return undefined;
	return matches.reduce((best, agent) => (AGENT_SOURCE_PRECEDENCE[agent.source] > AGENT_SOURCE_PRECEDENCE[best.source] ? agent : best));
}

export function nameExistsInScope(cwd: string, scope: ManagementScope, name: string, excludePath?: string): boolean {
	const d = discoverAgentsAll(cwd);
	for (const a of scope === "user" ? d.user : d.project) {
		if (a.name === name && a.filePath !== excludePath) return true;
	}
	for (const c of d.chains) {
		if (c.source === scope && c.name === name && c.filePath !== excludePath) return true;
	}
	return false;
}

export function isMutableSource(source: AgentSource): source is ManagementScope {
	return source === "user" || source === "project";
}

export function unknownChainAgents(cwd: string, steps: ChainStepConfig[]): string[] {
	const d = discoverAgentsAll(cwd);
	const known = new Set(allAgents(d).map((a) => a.name));
	return [...new Set(steps.map((s) => s.agent).filter((a) => !known.has(a)))].sort((a, b) => a.localeCompare(b));
}

export function chainStepWarnings(ctx: ManagementContext, steps: ChainStepConfig[]): string[] {
	const warnings: string[] = [];
	const available = new Set(discoverAvailableSkills(ctx.cwd).map((s) => s.name));
	for (let i = 0; i < steps.length; i++) {
		const s = steps[i]!;
		if (s.model) {
			const found = ctx.modelRegistry.getAvailable().some((m) => `${m.provider}/${m.id}` === s.model || m.id === s.model);
			if (!found) warnings.push(`Warning: step ${i + 1} (${s.agent}): model '${s.model}' is not in the current model registry.`);
		}
		if (Array.isArray(s.skills) && s.skills.length > 0) {
			const missing = s.skills.filter((sk) => !available.has(sk));
			if (missing.length) warnings.push(`Warning: step ${i + 1} (${s.agent}): skills not found: ${missing.join(", ")}.`);
		}
	}
	return warnings;
}

export function modelWarning(ctx: ManagementContext, model: string | undefined): string | undefined {
	if (!model) return undefined;
	const found = ctx.modelRegistry.getAvailable().some((m) => `${m.provider}/${m.id}` === model || m.id === model);
	return found ? undefined : `Warning: model '${model}' is not in the current model registry.`;
}

export function fallbackModelsWarning(ctx: ManagementContext, fallbackModels: string[] | undefined): string | undefined {
	if (!fallbackModels || fallbackModels.length === 0) return undefined;
	const available = new Set(ctx.modelRegistry.getAvailable().flatMap((m) => [`${m.provider}/${m.id}`, m.id]));
	const missing = fallbackModels.filter((model) => !available.has(model));
	return missing.length ? `Warning: fallback models not in the current model registry: ${missing.join(", ")}.` : undefined;
}

export function skillsWarning(cwd: string, skills: string[] | undefined): string | undefined {
	if (!skills || skills.length === 0) return undefined;
	const available = new Set(discoverAvailableSkills(cwd).map((s) => s.name));
	const missing = skills.filter((s) => !available.has(s));
	return missing.length ? `Warning: skills not found: ${missing.join(", ")}.` : undefined;
}

export function resolveTarget<T extends { source: AgentSource; filePath: string }>(
	kind: "agent" | "chain",
	name: string,
	matches: T[],
	cwd: string,
	scopeHint?: string,
): T | AgentToolResult<Details> {
	const mutable = matches.filter((m): m is T & { source: ManagementScope } => isMutableSource(m.source));
	if (mutable.length === 0) {
		if (matches.length > 0) {
			return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' is read-only and cannot be modified. Create a same-named ${kind} in user or project scope to override it.`, true);
		}
		const available = availableNames(cwd, kind);
		return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' not found. Available: ${available.join(", ") || "none"}.`, true);
	}
	if (mutable.length === 1) return mutable[0]!;
	const scope = asDisambiguationScope(scopeHint);
	if (!scope) {
		const paths = mutable.map((m) => `${m.source}: ${m.filePath}`).join("\n");
		return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' exists in both scopes. Specify agentScope: 'user' or 'project'.\n${paths}`, true);
	}
	const scoped = mutable.filter((m) => m.source === scope);
	if (scoped.length === 0) return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' not found in scope '${scope}'.`, true);
	if (scoped.length > 1) return result(`Multiple ${kind}s named '${name}' found in scope '${scope}': ${scoped.map((m) => m.filePath).join(", ")}`, true);
	return scoped[0]!;
}

export function renamePath(
	kind: "agent" | "chain",
	currentPath: string,
	newName: string,
	scope: ManagementScope,
	cwd: string,
): { filePath?: string; error?: string } {
	if (nameExistsInScope(cwd, scope, newName, currentPath)) return { error: `Name '${newName}' already exists in ${scope} scope.` };
	const ext = kind === "agent" ? ".md" : currentPath.endsWith(".chain.json") ? ".chain.json" : ".chain.md";
	const filePath = path.join(path.dirname(currentPath), `${newName}${ext}`);
	if (fs.existsSync(filePath) && filePath !== currentPath) {
		return { error: `File already exists at ${filePath} but is not a valid ${kind} definition. Remove or rename it first.` };
	}
	fs.renameSync(currentPath, filePath);
	return { filePath };
}
