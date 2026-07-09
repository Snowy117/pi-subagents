/**
 * Agent-management lifecycle handlers: delete, eject, disable, enable, reset.
 *
 * Also hosts the action dispatcher handleManagementAction that routes every
 * management action to the appropriate handler across the handler modules.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	discoverAgentsAll,
	mergeBuiltinAgentOverride,
	removeBuiltinAgentOverride,
	removeBuiltinAgentOverrideFields,
} from "../agents.ts";
import { getProjectConfigDir } from "../../shared/utils.ts";
import type { Details } from "../../shared/types.ts";
import {
	actionScope,
	asDisambiguationScope,
	availableNames,
	findAgents,
	findChains,
	type ManagementAction,
	type ManagementContext,
	type ManagementParams,
	nameExistsInScope,
	pickEffectiveAgent,
	resolveTarget,
	result,
	sanitizeName,
} from "./helpers.ts";
import { handleCreate, handleUpdate } from "./handlers-create-update.ts";
import { handleGet, handleList, handleModels } from "./handlers-read.ts";

export function handleDelete(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for delete.", true);
	if (params.agent && params.chainName) return result("Specify either 'agent' or 'chainName', not both.", true);
	const scopeHint = asDisambiguationScope(params.agentScope);
	if (params.agent) {
		const targetOrError = resolveTarget("agent", params.agent, findAgents(params.agent, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
		if ("content" in targetOrError) return targetOrError;
		const target = targetOrError;
		fs.unlinkSync(target.filePath);
		const refs = discoverAgentsAll(ctx.cwd).chains.filter((c) => c.steps.some((s) => s.agent === target.name)).map((c) => `${c.name} (${c.source})`);
		const lines = [`Deleted agent '${target.name}' at ${target.filePath}.`];
		if (refs.length) lines.push(`Warning: chains reference deleted agent '${target.name}': ${refs.join(", ")}.`);
		return result(lines.join("\n"));
	}
	const targetOrError = resolveTarget("chain", params.chainName!, findChains(params.chainName!, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
	if ("content" in targetOrError) return targetOrError;
	const target = targetOrError;
	fs.unlinkSync(target.filePath);
	return result(`Deleted chain '${target.name}' at ${target.filePath}.`);
}

export function handleEject(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for eject.", true);
	const raw = params.agent.trim();
	const sanitized = sanitizeName(raw);
	const parsedScope = actionScope(params.agentScope, "eject");
	if (parsedScope.error) return parsedScope.error;
	const scope = parsedScope.scope!;
	const d = discoverAgentsAll(ctx.cwd);
	const source = [...d.package, ...d.builtin].find((a) => a.name === raw || a.name === sanitized);
	if (!source) {
		return result(`Agent '${raw}' not found or is not a bundled/package agent. eject copies a builtin or package agent to ${scope} scope so it can be customized. Available: ${availableNames(ctx.cwd, "agent").join(", ") || "none"}.`, true);
	}
	const runtimeName = source.name;
	const existingCustom = (scope === "user" ? d.user : d.project).find((a) => a.name === runtimeName);
	if (existingCustom) {
		return result(`Agent '${runtimeName}' is already a custom ${scope} agent at ${existingCustom.filePath}. Edit it with { action: "update", agent: "${runtimeName}" } or delete it first.`, true);
	}
	if (nameExistsInScope(ctx.cwd, scope, runtimeName)) {
		return result(`An agent or chain named '${runtimeName}' already exists in ${scope} scope. Remove or rename it first.`, true);
	}
	const projectConfigDir = getProjectConfigDir(ctx.cwd);
	const targetDir = scope === "user" ? d.userDir : d.projectDir ?? path.join(projectConfigDir, "agents");
	fs.mkdirSync(targetDir, { recursive: true });
	const targetPath = path.join(targetDir, `${runtimeName}.md`);
	if (fs.existsSync(targetPath)) {
		return result(`File already exists at ${targetPath} but is not a valid agent definition. Remove or rename it first.`, true);
	}
	let content: string;
	try {
		content = fs.readFileSync(source.filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(`Failed to read source agent at ${source.filePath}: ${message}`, true);
	}
	fs.writeFileSync(targetPath, content, "utf-8");
	return result(`Ejected agent '${runtimeName}' from ${source.source} to ${scope} scope at ${targetPath}. Edit it there to customize; it shadows the bundled ${source.source} agent of the same name.`);
}

export function handleDisable(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for disable.", true);
	const raw = params.agent.trim();
	const parsedScope = actionScope(params.agentScope, "disable");
	if (parsedScope.error) return parsedScope.error;
	const scope = parsedScope.scope!;
	const d = discoverAgentsAll(ctx.cwd);
	if (scope === "project" && d.projectSettingsPath === null) {
		return result("Project override is not available here: no project config root (.pi or .agents) was found above the cwd. Use agentScope: 'user' or run from inside a project.", true);
	}
	const effective = pickEffectiveAgent(d, raw);
	if (!effective) {
		return result(`Agent '${raw}' not found. Available: ${availableNames(ctx.cwd, "agent").join(", ") || "none"}.`, true);
	}
	const runtimeName = effective.name;
	const settingsPath = mergeBuiltinAgentOverride(ctx.cwd, runtimeName, scope, { disabled: true });
	const after = pickEffectiveAgent(discoverAgentsAll(ctx.cwd), raw);
	if (after?.disabled === true) {
		return result(`Disabled agent '${runtimeName}' via ${scope} settings override at ${settingsPath}. It is now hidden from runtime discovery and { action: "list" }.`);
	}
	return result(`Wrote a disabled override for '${runtimeName}' at ${settingsPath}, but the agent is still enabled. A higher-precedence ${after?.override?.scope ?? "project"} override is likely winning. Try agentScope: '${after?.override?.scope ?? "project"}'.`, true);
}

export function handleEnable(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for enable.", true);
	const raw = params.agent.trim();
	const parsedScope = actionScope(params.agentScope, "enable");
	if (parsedScope.error) return parsedScope.error;
	const scope = parsedScope.scope!;
	const d = discoverAgentsAll(ctx.cwd);
	if (scope === "project" && d.projectSettingsPath === null) {
		return result("Project override is not available here: no project config root (.pi or .agents) was found above the cwd. Use agentScope: 'user' or run from inside a project.", true);
	}
	const effective = pickEffectiveAgent(d, raw);
	if (!effective) {
		return result(`Agent '${raw}' not found. Available: ${availableNames(ctx.cwd, "agent").join(", ") || "none"}.`, true);
	}
	const runtimeName = effective.name;
	const { path: settingsPath, removed } = removeBuiltinAgentOverrideFields(ctx.cwd, runtimeName, scope, ["disabled"]);
	const after = pickEffectiveAgent(discoverAgentsAll(ctx.cwd), raw);
	if (after && after.disabled !== true) {
		if (removed) return result(`Enabled agent '${runtimeName}' (removed disabled override at ${settingsPath}).`);
		return result(`Agent '${runtimeName}' is already enabled.`);
	}
	if (after?.override?.scope && after.override.scope !== scope) {
		return result(`Agent '${runtimeName}' is still disabled via a ${after.override.scope} scope override at ${after.override.path}. Specify agentScope: '${after.override.scope}' to enable it.`, true);
	}
	return result(`Agent '${runtimeName}' is still disabled after removing the ${scope} disabled override. It may be hidden via subagents.disableBuiltins in ${after?.override?.scope ?? scope} settings at ${after?.override?.path ?? settingsPath}.`, true);
}

export function handleReset(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for reset.", true);
	const raw = params.agent.trim();
	const sanitized = sanitizeName(raw);
	const parsedScope = actionScope(params.agentScope, "reset");
	if (parsedScope.error) return parsedScope.error;
	const scope = parsedScope.scope!;
	const d = discoverAgentsAll(ctx.cwd);
	if (scope === "project" && d.projectSettingsPath === null) {
		return result("Project override is not available here: no project config root (.pi or .agents) was found above the cwd. Use agentScope: 'user' or run from inside a project.", true);
	}
	const bundled = [...d.package, ...d.builtin].find((a) => a.name === raw || a.name === sanitized);
	if (!bundled) {
		const custom = [...d.user, ...d.project].find((a) => a.name === raw || a.name === sanitized);
		if (custom) {
			return result(`Agent '${raw}' has no bundled default to reset to. Use { action: "delete", agent: "${custom.name}" } to remove the custom ${custom.source} agent.`, true);
		}
		return result(`Agent '${raw}' not found. Available: ${availableNames(ctx.cwd, "agent").join(", ") || "none"}.`, true);
	}
	const runtimeName = bundled.name;
	const custom = (scope === "user" ? d.user : d.project).find((a) => a.name === raw || a.name === sanitized);
	const lines: string[] = [];
	if (custom) {
		fs.unlinkSync(custom.filePath);
		lines.push(`Deleted custom ${scope} agent file at ${custom.filePath}.`);
	}
	const overrideRemoval = removeBuiltinAgentOverride(ctx.cwd, runtimeName, scope);
	if (overrideRemoval.removed) lines.push(`Removed ${scope} settings override at ${overrideRemoval.path}.`);
	if (lines.length === 0) {
		const otherScope = scope === "user" ? "project" : "user";
		const otherCustom = (otherScope === "user" ? d.user : d.project).find((a) => a.name === raw || a.name === sanitized);
		const hasOtherOverride = bundled.override?.scope === otherScope;
		const note = (otherCustom || hasOtherOverride)
			? ` Customization exists in ${otherScope} scope; specify agentScope: '${otherScope}' to reset it.`
			: "";
		return result(`Agent '${runtimeName}' has no ${scope} customization to reset.${note} It is at its bundled ${bundled.source} default.`);
	}
	lines.push(`Reset agent '${runtimeName}' to its bundled ${bundled.source} default.`);
	return result(lines.join("\n"));
}

export function handleManagementAction(action: string, params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	switch (action as ManagementAction) {
		case "list": return handleList(params, ctx);
		case "get": return handleGet(params, ctx);
		case "models": return handleModels(params, ctx);
		case "create": return handleCreate(params, ctx);
		case "update": return handleUpdate(params, ctx);
		case "delete": return handleDelete(params, ctx);
		case "eject": return handleEject(params, ctx);
		case "disable": return handleDisable(params, ctx);
		case "enable": return handleEnable(params, ctx);
		case "reset": return handleReset(params, ctx);
		default: return result(`Unknown action: ${action}`, true);
	}
}
