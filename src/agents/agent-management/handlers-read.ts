/**
 * Read-only agent-management handlers: list, get, models.
 *
 * Includes the agent/chain/model detail formatters used only by these query
 * handlers.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type AgentConfig,
	type ChainConfig,
	type ChainStepConfig,
	BUILTIN_AGENT_NAMES,
	discoverAgentsAll,
	frontmatterNameForConfig,
} from "../agents.ts";
import { discoverAvailableSkills } from "../skills.ts";
import { buildProactiveSkillSubagentRecommendationLines } from "../proactive-skills.ts";
import { toModelInfo } from "../../shared/model-info.ts";
import { resolveSubagentModelOverride, type ParentModel } from "../../runs/shared/model-fallback.ts";
import type { Details } from "../../shared/types.ts";
import {
	allAgents,
	availableNames,
	findAgents,
	findChains,
	type ManagementContext,
	type ManagementParams,
	normalizeListScope,
	result,
} from "./helpers.ts";

export function formatAgentDetail(agent: AgentConfig): string {
	const tools = [...(agent.tools ?? []), ...(agent.mcpDirectTools ?? []).map((t) => `mcp:${t}`)];
	const lines: string[] = [`Agent: ${agent.name} (${agent.source})`, `Path: ${agent.filePath}`, `Description: ${agent.description}`];
	if (agent.packageName) {
		lines.push(`Local name: ${frontmatterNameForConfig(agent)}`);
		lines.push(`Package: ${agent.packageName}`);
	}
	if (agent.model) lines.push(`Model: ${agent.model}`);
	if (agent.fallbackModels?.length) lines.push(`Fallback models: ${agent.fallbackModels.join(", ")}`);
	if (tools.length) lines.push(`Tools: ${tools.join(", ")}`);
	if (agent.skills?.length) lines.push(`Skills: ${agent.skills.join(", ")}`);
	lines.push(`System prompt mode: ${agent.systemPromptMode}`);
	lines.push(`Inherit project context: ${agent.inheritProjectContext ? "true" : "false"}`);
	lines.push(`Inherit skills: ${agent.inheritSkills ? "true" : "false"}`);
	if (agent.defaultContext) lines.push(`Default context: ${agent.defaultContext}`);
	if (agent.source === "builtin") lines.push(`Disabled: ${agent.disabled ? "true" : "false"}`);
	if (agent.extensions !== undefined) lines.push(`Extensions: ${agent.extensions.length ? agent.extensions.join(", ") : "(none)"}`);
	if (agent.subagentOnlyExtensions !== undefined) lines.push(`Subagent-only extensions: ${agent.subagentOnlyExtensions.length ? agent.subagentOnlyExtensions.join(", ") : "(none)"}`);
	if (agent.thinking) lines.push(`Thinking: ${agent.thinking}`);
	if (agent.output) lines.push(`Output: ${agent.output}`);
	if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.maxSubagentDepth !== undefined) lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.completionGuard === false) lines.push("Completion guard: false");
	if (agent.toolBudget) lines.push(`Tool budget: ${JSON.stringify(agent.toolBudget)}`);
	if (agent.memory) lines.push(`Memory: ${agent.memory.scope} scope, path: ${agent.memory.path}`);
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

export function formatChainStepDetail(step: ChainStepConfig, index: number): string[] {
	const lines: string[] = [];
	if (step.expand || step.collect) {
		const parallel = step.parallel && !Array.isArray(step.parallel) && typeof step.parallel === "object" ? step.parallel as { agent?: unknown; task?: unknown; label?: unknown; outputSchema?: unknown } : undefined;
		const expand = step.expand && typeof step.expand === "object" ? step.expand as { from?: { output?: unknown; path?: unknown }; item?: unknown; key?: unknown; maxItems?: unknown; onEmpty?: unknown } : undefined;
		const collect = step.collect && typeof step.collect === "object" ? step.collect as { as?: unknown; outputSchema?: unknown } : undefined;
		lines.push(`${index + 1}. Dynamic fanout${typeof collect?.as === "string" ? ` -> ${collect.as}` : ""}`);
		if (expand?.from) lines.push(`   Expand: ${String(expand.from.output ?? "?")}${String(expand.from.path ?? "")}`);
		if (typeof expand?.item === "string") lines.push(`   Item variable: ${expand.item}`);
		if (typeof expand?.key === "string") lines.push(`   Key: ${expand.key}`);
		if (typeof expand?.maxItems === "number") lines.push(`   Max items: ${expand.maxItems}`);
		if (typeof expand?.onEmpty === "string") lines.push(`   On empty: ${expand.onEmpty}`);
		if (parallel?.agent) lines.push(`   Agent: ${String(parallel.agent)}`);
		if (typeof parallel?.label === "string") lines.push(`   Label: ${parallel.label}`);
		if (typeof parallel?.task === "string" && parallel.task.trim()) lines.push(`   Task: ${parallel.task}`);
		if (parallel?.outputSchema) lines.push("   Structured output: true");
		if (parallel && "toolBudget" in parallel) lines.push(`   Tool budget: ${JSON.stringify((parallel as { toolBudget?: unknown }).toolBudget)}`);
		if (collect?.outputSchema) lines.push("   Collect schema: true");
		if (step.concurrency !== undefined) lines.push(`   Concurrency: ${step.concurrency}`);
		if (step.failFast !== undefined) lines.push(`   Fail fast: ${step.failFast ? "true" : "false"}`);
		return lines;
	}
	lines.push(`${index + 1}. ${step.agent}`);
	if (step.task?.trim()) lines.push(`   Task: ${step.task}`);
	if (step.output === false) lines.push("   Output: false");
	else if (step.output) lines.push(`   Output: ${step.output}`);
	if (step.outputMode) lines.push(`   Output mode: ${step.outputMode}`);
	if (step.toolBudget) lines.push(`   Tool budget: ${JSON.stringify(step.toolBudget)}`);
	if (step.reads === false) lines.push("   Reads: false");
	else if (Array.isArray(step.reads) && step.reads.length > 0) lines.push(`   Reads: ${step.reads.join(", ")}`);
	if (step.model) lines.push(`   Model: ${step.model}`);
	if (step.skills === false) lines.push("   Skills: false");
	else if (Array.isArray(step.skills) && step.skills.length > 0) lines.push(`   Skills: ${step.skills.join(", ")}`);
	if (step.progress !== undefined) lines.push(`   Progress: ${step.progress ? "true" : "false"}`);
	return lines;
}

export function formatChainDetail(chain: ChainConfig): string {
	const lines: string[] = [`Chain: ${chain.name} (${chain.source})`, `Path: ${chain.filePath}`, `Description: ${chain.description}`];
	if (chain.packageName) {
		lines.push(`Local name: ${frontmatterNameForConfig(chain)}`);
		lines.push(`Package: ${chain.packageName}`);
	}
	lines.push("", "Steps:");
	for (let i = 0; i < chain.steps.length; i++) {
		lines.push(...formatChainStepDetail(chain.steps[i]!, i));
	}
	return lines.join("\n");
}

export function handleList(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const scope = normalizeListScope(params.agentScope) ?? "both";
	const d = discoverAgentsAll(ctx.cwd);
	const scopedAgents = allAgents(d).filter((a) => scope === "both" || a.source === "builtin" || a.source === "package" || a.source === scope).sort((a, b) => a.name.localeCompare(b.name));
	const agents = scopedAgents.filter((a) => !a.disabled);
	const chains = d.chains.filter((c) => scope === "both" || c.source === "package" || c.source === scope).sort((a, b) => a.name.localeCompare(b.name));
	const diagnostics = d.chainDiagnostics.filter((entry) => scope === "both" || entry.source === scope);
	const proactiveSuggestions = buildProactiveSkillSubagentRecommendationLines({
		agents,
		chains,
		config: ctx.config?.proactiveSkillSubagents,
		discoverAvailableSkills: () => discoverAvailableSkills(ctx.cwd),
	});
	const lines = [
		"Executable agents:",
		...(agents.length
			? agents.map((a) => `- ${a.name} (${a.source}${a.defaultContext ? `, context: ${a.defaultContext}` : ""}): ${a.description}`)
			: ["- (none)"]),
		"",
		"Chains:",
		...(chains.length ? chains.map((c) => `- ${c.name} (${c.source}): ${c.description}`) : ["- (none)"]),
		...(proactiveSuggestions.length ? ["", ...proactiveSuggestions] : []),
		...(diagnostics.length ? ["", "Chain diagnostics:", ...diagnostics.map((entry) => `- ${entry.filePath}: ${entry.error}`)] : []),
	];
	return result(lines.join("\n"));
}

export function formatModelSource(agent: AgentConfig, currentModel: ParentModel | undefined): string {
	if (agent.override && agent.model !== agent.override.base.model) {
		return `${agent.override.scope} override`;
	}
	if (agent.modelSource?.type === "subagents.defaultModel" && agent.model === agent.modelSource.model) {
		return `${agent.modelSource.scope} defaultModel`;
	}
	if (agent.model) return "builtin agent config";
	if (currentModel) return "inherits current session model";
	return "inherit requested, but no current session model is available";
}

export function handleModels(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const requestedAgent = params.agent?.trim();
	if (requestedAgent && !(BUILTIN_AGENT_NAMES as readonly string[]).includes(requestedAgent)) {
		return result(`Builtin agent '${requestedAgent}' not found. Available: ${BUILTIN_AGENT_NAMES.join(", ")}.`, true);
	}

	const discovered = discoverAgentsAll(ctx.cwd);
	const builtinByName = new Map(discovered.builtin.map((agent) => [agent.name, agent]));
	const availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const currentModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
	const preferredProvider = ctx.model?.provider;
	const names = requestedAgent ? [requestedAgent] : [...BUILTIN_AGENT_NAMES];

	if (requestedAgent) {
		const agent = builtinByName.get(requestedAgent);
		if (!agent) return result(`Builtin agent '${requestedAgent}' not found.`, true);
		const resolvedModel = resolveSubagentModelOverride(agent.model, currentModel, availableModels, preferredProvider);
		const lines = [
			"Builtin subagent model",
			"",
			`Agent: ${requestedAgent}`,
			"Effective model:",
			`  ${resolvedModel ?? "(unresolved)"}`,
			`Source: ${formatModelSource(agent, currentModel)}`,
		];
		if (agent.override) {
			lines.push("Override file:");
			lines.push(`  ${agent.override.path}`);
		}
		if (agent.model && resolvedModel && agent.model !== resolvedModel) {
			lines.push("Requested model setting:");
			lines.push(`  ${agent.model}`);
		}
		if (agent.disabled) lines.push("Disabled: true");
		lines.push("Current session model:");
		lines.push(`  ${currentModel ? `${currentModel.provider}/${currentModel.id}` : "(unavailable)"}`);
		return result(lines.join("\n"));
	}

	const lines = [
		"Builtin subagent models",
		"",
		"Current session model:",
		`  ${currentModel ? `${currentModel.provider}/${currentModel.id}` : "(unavailable)"}`,
		"",
	];

	for (const name of names) {
		const agent = builtinByName.get(name);
		if (!agent) {
			lines.push(name);
			lines.push("  model:");
			lines.push("    (builtin definition not found)");
			lines.push("  source: missing");
			lines.push("");
			continue;
		}
		const resolvedModel = resolveSubagentModelOverride(agent.model, currentModel, availableModels, preferredProvider);
		const source = `${formatModelSource(agent, currentModel)}${agent.disabled ? "; disabled" : ""}`;
		lines.push(name);
		lines.push("  model:");
		lines.push(`    ${resolvedModel ?? "(unresolved)"}`);
		lines.push(`  source: ${source}`);
		lines.push("");
	}

	return result(lines.join("\n"));
}

export function handleGet(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for get.", true);
	const hasBoth = Boolean(params.agent && params.chainName);
	const blocks: string[] = [];
	let anyFound = false;
	if (params.agent) {
		const matches = findAgents(params.agent, ctx.cwd, "both");
		if (!matches.length) {
			const msg = `Agent '${params.agent}' not found. Available: ${availableNames(ctx.cwd, "agent").join(", ") || "none"}.`;
			if (!hasBoth) return result(msg, true);
			blocks.push(msg);
		} else {
			anyFound = true;
			blocks.push(...matches.map(formatAgentDetail));
		}
	}
	if (params.chainName) {
		const matches = findChains(params.chainName, ctx.cwd, "both");
		if (!matches.length) {
			const msg = `Chain '${params.chainName}' not found. Available: ${availableNames(ctx.cwd, "chain").join(", ") || "none"}.`;
			if (!hasBoth) return result(msg, true);
			blocks.push(msg);
		} else {
			anyFound = true;
			blocks.push(...matches.map(formatChainDetail));
		}
	}
	return result(blocks.join("\n\n"), !anyFound);
}
