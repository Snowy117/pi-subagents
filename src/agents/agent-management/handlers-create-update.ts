/**
 * Agent-management create/update handlers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type AgentConfig,
	type ChainConfig,
	type ChainStepConfig,
	buildRuntimeName,
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
	discoverAgentsAll,
	frontmatterNameForConfig,
} from "../agents.ts";
import { serializeAgent } from "../agent-serializer.ts";
import { serializeChain, serializeJsonChain } from "../chain-serializer.ts";
import { getProjectConfigDir } from "../../shared/utils.ts";
import type { Details } from "../../shared/types.ts";
import {
	asDisambiguationScope,
	chainStepWarnings,
	configObject,
	fallbackModelsWarning,
	findAgents,
	findChains,
	hasKey,
	modelWarning,
	nameExistsInScope,
	parsePackageConfig,
	renamePath,
	resolveTarget,
	result,
	sanitizeName,
	skillsWarning,
	unknownChainAgents,
	type ManagementContext,
	type ManagementParams,
	type ManagementScope,
} from "./helpers.ts";
import {
	applyAgentConfig,
	editableAgentConfig,
	parseStepList,
	preservedAgentFrontmatterFields,
} from "./config-editing.ts";

export function handleCreate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return result(parsedConfig.error, true);
	const cfg = parsedConfig.value;
	if (!cfg) return result("config required for create.", true);
	if (typeof cfg.name !== "string" || !cfg.name.trim()) return result("config.name is required and must be a non-empty string.", true);
	if (typeof cfg.description !== "string" || !cfg.description.trim()) return result("config.description is required and must be a non-empty string.", true);
	const name = sanitizeName(cfg.name);
	if (!name) return result("config.name is invalid after sanitization. Use letters, numbers, spaces, or hyphens.", true);
	const parsedPackage = parsePackageConfig(cfg.package);
	if (parsedPackage.error) return result(parsedPackage.error, true);
	const runtimeName = buildRuntimeName(name, parsedPackage.packageName);
	const scopeRaw = cfg.scope ?? "user";
	if (scopeRaw !== "user" && scopeRaw !== "project") return result("config.scope must be 'user' or 'project'.", true);
	const scope = scopeRaw as ManagementScope;
	const isChain = hasKey(cfg, "steps");
	const d = discoverAgentsAll(ctx.cwd);
	const projectConfigDir = getProjectConfigDir(ctx.cwd);
	const targetDir = isChain
		? scope === "user" ? d.userChainDir : d.projectChainDir ?? path.join(projectConfigDir, "chains")
		: scope === "user" ? d.userDir : d.projectDir ?? path.join(projectConfigDir, "agents");
	fs.mkdirSync(targetDir, { recursive: true });
	if (nameExistsInScope(ctx.cwd, scope, runtimeName)) return result(`Name '${runtimeName}' already exists in ${scope} scope. Use update instead.`, true);
	const targetPath = path.join(targetDir, isChain ? `${runtimeName}.chain.md` : `${runtimeName}.md`);
	if (fs.existsSync(targetPath)) return result(`File already exists at ${targetPath} but is not a valid ${isChain ? "chain" : "agent"} definition. Remove or rename it first.`, true);
	const warnings: string[] = [];
	if (!isChain && d.builtin.some((a) => a.name === runtimeName)) warnings.push(`Note: this shadows the builtin agent '${runtimeName}'.`);
	if (isChain) {
		const parsed = parseStepList(cfg.steps);
		if (parsed.error) return result(parsed.error, true);
		const chain: ChainConfig = { name: runtimeName, localName: name, packageName: parsedPackage.packageName, description: cfg.description.trim(), source: scope, filePath: targetPath, steps: parsed.steps! };
		fs.writeFileSync(targetPath, serializeChain(chain), "utf-8");
		const missing = unknownChainAgents(ctx.cwd, chain.steps);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		warnings.push(...chainStepWarnings(ctx, chain.steps));
		return result([`Created chain '${runtimeName}' at ${targetPath}.`, ...warnings].join("\n"));
	}
	const agent: AgentConfig = {
		name: runtimeName,
		localName: name,
		packageName: parsedPackage.packageName,
		description: cfg.description.trim(),
		source: scope,
		filePath: targetPath,
		systemPrompt: "",
		systemPromptMode: defaultSystemPromptMode(name),
		inheritProjectContext: defaultInheritProjectContext(name),
		inheritSkills: defaultInheritSkills(),
	};
	const applyError = applyAgentConfig(agent, cfg);
	if (applyError) return result(applyError, true);
	const mw = modelWarning(ctx, agent.model);
	if (mw) warnings.push(mw);
	const fmw = fallbackModelsWarning(ctx, agent.fallbackModels);
	if (fmw) warnings.push(fmw);
	const sw = skillsWarning(ctx.cwd, agent.skills);
	if (sw) warnings.push(sw);
	fs.writeFileSync(targetPath, serializeAgent(agent), "utf-8");
	return result([`Created agent '${runtimeName}' at ${targetPath}.`, ...warnings].join("\n"));
}

export function handleUpdate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for update.", true);
	if (params.agent && params.chainName) return result("Specify either 'agent' or 'chainName', not both.", true);
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return result(parsedConfig.error, true);
	const cfg = parsedConfig.value;
	if (!cfg) return result("config required for update.", true);
	const warnings: string[] = [];
	if (params.agent) {
		const scopeHint = asDisambiguationScope(params.agentScope);
		const targetOrError = resolveTarget("agent", params.agent, findAgents(params.agent, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
		if ("content" in targetOrError) return targetOrError;
		const target = targetOrError;
		const updated = editableAgentConfig(target);
		const oldName = target.name;
		if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || !cfg.name.trim())) return result("config.name must be a non-empty string when provided.", true);
		if (hasKey(cfg, "description") && (typeof cfg.description !== "string" || !cfg.description.trim())) return result("config.description must be a non-empty string when provided.", true);
		let newLocalName = target.localName ?? frontmatterNameForConfig(target);
		if (hasKey(cfg, "name")) {
			newLocalName = sanitizeName(cfg.name as string);
			if (!newLocalName) return result("config.name is invalid after sanitization.", true);
		}
		let newPackageName = target.packageName;
		if (hasKey(cfg, "package")) {
			const parsedPackage = parsePackageConfig(cfg.package);
			if (parsedPackage.error) return result(parsedPackage.error, true);
			newPackageName = parsedPackage.packageName;
		}
		const applyError = applyAgentConfig(updated, cfg);
		if (applyError) return result(applyError, true);
		const preserveFrontmatterFields = preservedAgentFrontmatterFields(target, cfg);
		updated.localName = newLocalName;
		updated.packageName = newPackageName;
		updated.name = buildRuntimeName(newLocalName, newPackageName);
		if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
		if (hasKey(cfg, "model")) {
			const mw = modelWarning(ctx, updated.model);
			if (mw) warnings.push(mw);
		}
		if (hasKey(cfg, "fallbackModels")) {
			const fmw = fallbackModelsWarning(ctx, updated.fallbackModels);
			if (fmw) warnings.push(fmw);
		}
		if (hasKey(cfg, "skills")) {
			const sw = skillsWarning(ctx.cwd, updated.skills);
			if (sw) warnings.push(sw);
		}
		if (updated.name !== oldName) {
			const renamed = renamePath("agent", target.filePath, updated.name, target.source, ctx.cwd);
			if (renamed.error) return result(renamed.error, true);
			updated.filePath = renamed.filePath!;
		}
		fs.writeFileSync(updated.filePath, serializeAgent(updated, { preserveFrontmatterFields }), "utf-8");
		if (updated.name !== oldName) {
			const refs = discoverAgentsAll(ctx.cwd).chains.filter((c) => c.steps.some((s) => s.agent === oldName)).map((c) => `${c.name} (${c.source})`);
			if (refs.length) warnings.push(`Warning: chains still reference '${oldName}': ${refs.join(", ")}.`);
		}
		const headline = updated.name === oldName
			? `Updated agent '${updated.name}' at ${updated.filePath}.`
			: `Updated agent '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
		return result([headline, ...warnings].join("\n"));
	}
	const scopeHint = asDisambiguationScope(params.agentScope);
	const targetOrError = resolveTarget("chain", params.chainName!, findChains(params.chainName!, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
	if ("content" in targetOrError) return targetOrError;
	const target = targetOrError;
	const updated: ChainConfig = { ...target, steps: [...target.steps] };
	const oldName = target.name;
	if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || !cfg.name.trim())) return result("config.name must be a non-empty string when provided.", true);
	if (hasKey(cfg, "description") && (typeof cfg.description !== "string" || !cfg.description.trim())) return result("config.description must be a non-empty string when provided.", true);
	let newLocalName = target.localName ?? frontmatterNameForConfig(target);
	if (hasKey(cfg, "name")) {
		newLocalName = sanitizeName(cfg.name as string);
		if (!newLocalName) return result("config.name is invalid after sanitization.", true);
	}
	let newPackageName = target.packageName;
	if (hasKey(cfg, "package")) {
		const parsedPackage = parsePackageConfig(cfg.package);
		if (parsedPackage.error) return result(parsedPackage.error, true);
		newPackageName = parsedPackage.packageName;
	}
	let parsedSteps: ChainStepConfig[] | undefined;
	if (hasKey(cfg, "steps")) {
		const parsed = parseStepList(cfg.steps);
		if (parsed.error) return result(parsed.error, true);
		parsedSteps = parsed.steps!;
	}
	updated.localName = newLocalName;
	updated.packageName = newPackageName;
	updated.name = buildRuntimeName(newLocalName, newPackageName);
	if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
	if (parsedSteps) {
		updated.steps = parsedSteps;
		const missing = unknownChainAgents(ctx.cwd, updated.steps);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		warnings.push(...chainStepWarnings(ctx, updated.steps));
	}
	if (updated.name !== oldName) {
		const renamed = renamePath("chain", target.filePath, updated.name, target.source, ctx.cwd);
		if (renamed.error) return result(renamed.error, true);
		updated.filePath = renamed.filePath!;
	}
	fs.writeFileSync(updated.filePath, updated.filePath.endsWith(".chain.json") ? serializeJsonChain(updated) : serializeChain(updated), "utf-8");
	const headline = updated.name === oldName
		? `Updated chain '${updated.name}' at ${updated.filePath}.`
		: `Updated chain '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
	return result([headline, ...warnings].join("\n"));
}
