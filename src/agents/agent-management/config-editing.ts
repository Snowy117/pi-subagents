/**
 * Agent/chain config editing helpers.
 *
 * Projects edited config onto an agent target, computes preserved
 * frontmatter fields, and parses step lists / tool lists / config objects.
 */

import * as fs from "node:fs";
import { parseFrontmatter } from "../frontmatter.ts";
import { validateToolBudgetConfig } from "../../runs/shared/tool-budget.ts";
import type { AgentConfig, ChainStepConfig } from "../agents.ts";
import type { ToolBudgetConfig } from "../../shared/types.ts";
import { hasKey, parseCsv } from "./helpers.ts";

export function editableAgentConfig(agent: AgentConfig): AgentConfig {
	const base = agent.override?.base;
	if (!base) return { ...agent };

	return {
		...agent,
		model: base.model,
		fallbackModels: base.fallbackModels ? [...base.fallbackModels] : undefined,
		thinking: base.thinking,
		systemPromptMode: base.systemPromptMode,
		inheritProjectContext: base.inheritProjectContext,
		inheritSkills: base.inheritSkills,
		defaultContext: base.defaultContext,
		disabled: base.disabled,
		systemPrompt: base.systemPrompt,
		skills: base.skills ? [...base.skills] : undefined,
		tools: base.tools ? [...base.tools] : undefined,
		mcpDirectTools: base.mcpDirectTools ? [...base.mcpDirectTools] : undefined,
		subagentOnlyExtensions: base.subagentOnlyExtensions ? [...base.subagentOnlyExtensions] : undefined,
		completionGuard: base.completionGuard,
		override: undefined,
	};
}

export function readAgentFrontmatterFields(filePath: string): Set<string> {
	try {
		const { frontmatter } = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
		return new Set(Object.keys(frontmatter));
	} catch {
		return new Set();
	}
}

export function preservedAgentFrontmatterFields(agent: AgentConfig, cfg: Record<string, unknown>): Set<string> {
	const fields = readAgentFrontmatterFields(agent.filePath);
	const changed = (...names: string[]) => {
		for (const name of names) fields.delete(name);
	};

	if (hasKey(cfg, "name")) changed("name");
	if (hasKey(cfg, "package")) changed("package");
	if (hasKey(cfg, "description")) changed("description");
	if (hasKey(cfg, "systemPrompt")) changed("systemPrompt");
	if (hasKey(cfg, "model")) changed("model");
	if (hasKey(cfg, "fallbackModels")) changed("fallbackModels");
	if (hasKey(cfg, "tools")) changed("tools");
	if (hasKey(cfg, "skills")) changed("skill", "skills");
	if (hasKey(cfg, "extensions")) changed("extensions");
	if (hasKey(cfg, "subagentOnlyExtensions")) changed("subagentOnlyExtensions");
	if (hasKey(cfg, "thinking")) {
		changed("thinking");
		if (cfg.thinking === "off") fields.add("thinking");
	}
	if (hasKey(cfg, "systemPromptMode")) {
		changed("systemPromptMode");
		fields.add("systemPromptMode");
	}
	if (hasKey(cfg, "inheritProjectContext")) {
		changed("inheritProjectContext");
		fields.add("inheritProjectContext");
	}
	if (hasKey(cfg, "inheritSkills")) {
		changed("inheritSkills");
		fields.add("inheritSkills");
	}
	if (hasKey(cfg, "defaultContext")) changed("defaultContext");
	if (hasKey(cfg, "output")) changed("output");
	if (hasKey(cfg, "reads")) changed("defaultReads");
	if (hasKey(cfg, "progress")) changed("defaultProgress");
	if (hasKey(cfg, "maxSubagentDepth")) changed("maxSubagentDepth");
	if (hasKey(cfg, "completionGuard")) {
		changed("completionGuard");
		if (cfg.completionGuard === true) fields.add("completionGuard");
	}
	if (hasKey(cfg, "toolBudget")) changed("toolBudget");

	return fields;
}

export function parseStepList(raw: unknown): { steps?: ChainStepConfig[]; error?: string } {
	if (!Array.isArray(raw)) return { error: "config.steps must be an array." };
	if (raw.length === 0) return { error: "config.steps must include at least one step." };
	const steps: ChainStepConfig[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `config.steps[${i}] must be an object.` };
		const s = item as Record<string, unknown>;
		if (typeof s.agent !== "string" || !s.agent.trim()) return { error: `config.steps[${i}].agent must be a non-empty string.` };
		const step: ChainStepConfig = { agent: s.agent.trim(), task: typeof s.task === "string" ? s.task : "" };
		if (hasKey(s, "phase")) {
			if (typeof s.phase === "string") step.phase = s.phase;
			else return { error: `config.steps[${i}].phase must be a string.` };
		}
		if (hasKey(s, "label")) {
			if (typeof s.label === "string") step.label = s.label;
			else return { error: `config.steps[${i}].label must be a string.` };
		}
		if (hasKey(s, "as")) {
			if (typeof s.as === "string") step.as = s.as;
			else return { error: `config.steps[${i}].as must be a string.` };
		}
		if (hasKey(s, "outputSchema")) {
			if (typeof s.outputSchema === "string") step.outputSchema = s.outputSchema;
			else return { error: `config.steps[${i}].outputSchema must be a schema file path string for saved chains.` };
		}
		if (hasKey(s, "output")) {
			if (s.output === false) step.output = false;
			else if (typeof s.output === "string") step.output = s.output;
			else return { error: `config.steps[${i}].output must be a string or false.` };
		}
		if (hasKey(s, "outputMode")) {
			if (s.outputMode === "inline" || s.outputMode === "file-only") step.outputMode = s.outputMode;
			else return { error: `config.steps[${i}].outputMode must be 'inline' or 'file-only'.` };
		}
		if (hasKey(s, "reads")) {
			if (s.reads === false) step.reads = false;
			else if (Array.isArray(s.reads)) step.reads = s.reads.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
			else return { error: `config.steps[${i}].reads must be an array or false.` };
		}
		if (hasKey(s, "model")) {
			if (typeof s.model === "string") step.model = s.model;
			else return { error: `config.steps[${i}].model must be a string.` };
		}
		if (hasKey(s, "skills")) {
			if (s.skills === false) step.skills = false;
			else if (Array.isArray(s.skills)) step.skills = s.skills.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
			else return { error: `config.steps[${i}].skills must be an array or false.` };
		}
		if (hasKey(s, "progress")) {
			if (typeof s.progress === "boolean") step.progress = s.progress;
			else return { error: `config.steps[${i}].progress must be a boolean.` };
		}
		if (hasKey(s, "toolBudget")) {
			const validation = validateToolBudgetConfig(s.toolBudget, `config.steps[${i}].toolBudget`);
			if (validation.error) return { error: validation.error };
			step.toolBudget = s.toolBudget as ChainStepConfig["toolBudget"];
		}
		steps.push(step);
	}
	return { steps };
}

export function parseTools(raw: string): { tools?: string[]; mcpDirectTools?: string[] } {
	const tools: string[] = [];
	const mcpDirectTools: string[] = [];
	for (const item of parseCsv(raw)) {
		if (item.startsWith("mcp:")) {
			const direct = item.slice(4).trim();
			if (direct) mcpDirectTools.push(direct);
		} else tools.push(item);
	}
	return { tools: tools.length ? tools : undefined, mcpDirectTools: mcpDirectTools.length ? mcpDirectTools : undefined };
}

export function applyAgentConfig(target: AgentConfig, cfg: Record<string, unknown>): string | undefined {
	if (hasKey(cfg, "systemPrompt")) {
		if (cfg.systemPrompt === false || cfg.systemPrompt === "") target.systemPrompt = "";
		else if (typeof cfg.systemPrompt === "string") target.systemPrompt = cfg.systemPrompt;
		else return "config.systemPrompt must be a string or false when provided.";
	}
	if (hasKey(cfg, "model")) {
		if (cfg.model === false || cfg.model === "") target.model = undefined;
		else if (typeof cfg.model === "string") target.model = cfg.model.trim() || undefined;
		else return "config.model must be a string or false when provided.";
	}
	if (hasKey(cfg, "fallbackModels")) {
		if (cfg.fallbackModels === false || cfg.fallbackModels === "") target.fallbackModels = undefined;
		else if (typeof cfg.fallbackModels === "string") {
			const models = parseCsv(cfg.fallbackModels);
			target.fallbackModels = models.length ? models : undefined;
		} else if (Array.isArray(cfg.fallbackModels)) {
			const models = cfg.fallbackModels
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter(Boolean);
			target.fallbackModels = models.length ? [...new Set(models)] : undefined;
		} else return "config.fallbackModels must be a comma-separated string, string array, or false when provided.";
	}
	if (hasKey(cfg, "tools")) {
		if (cfg.tools === false || cfg.tools === "") { target.tools = undefined; target.mcpDirectTools = undefined; }
		else if (typeof cfg.tools === "string") { const parsed = parseTools(cfg.tools); target.tools = parsed.tools; target.mcpDirectTools = parsed.mcpDirectTools; }
		else return "config.tools must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "skills")) {
		if (cfg.skills === false || cfg.skills === "") target.skills = undefined;
		else if (typeof cfg.skills === "string") { const skills = parseCsv(cfg.skills); target.skills = skills.length ? skills : undefined; }
		else return "config.skills must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "extensions")) {
		if (cfg.extensions === false) target.extensions = undefined;
		else if (cfg.extensions === "") target.extensions = [];
		else if (typeof cfg.extensions === "string") target.extensions = parseCsv(cfg.extensions);
		else return "config.extensions must be a comma-separated string, empty string, or false when provided.";
	}
	if (hasKey(cfg, "subagentOnlyExtensions")) {
		if (cfg.subagentOnlyExtensions === false) target.subagentOnlyExtensions = undefined;
		else if (cfg.subagentOnlyExtensions === "") target.subagentOnlyExtensions = [];
		else if (typeof cfg.subagentOnlyExtensions === "string") target.subagentOnlyExtensions = parseCsv(cfg.subagentOnlyExtensions);
		else return "config.subagentOnlyExtensions must be a comma-separated string, empty string, or false when provided.";
	}
	if (hasKey(cfg, "thinking")) {
		if (cfg.thinking === false || cfg.thinking === "") target.thinking = undefined;
		else if (typeof cfg.thinking === "string") target.thinking = cfg.thinking.trim() || undefined;
		else return "config.thinking must be a string or false when provided.";
	}
	if (hasKey(cfg, "systemPromptMode")) {
		if (cfg.systemPromptMode === "append" || cfg.systemPromptMode === "replace") target.systemPromptMode = cfg.systemPromptMode;
		else return "config.systemPromptMode must be 'append' or 'replace' when provided.";
	}
	if (hasKey(cfg, "inheritProjectContext")) {
		if (typeof cfg.inheritProjectContext !== "boolean") return "config.inheritProjectContext must be a boolean when provided.";
		target.inheritProjectContext = cfg.inheritProjectContext;
	}
	if (hasKey(cfg, "inheritSkills")) {
		if (typeof cfg.inheritSkills !== "boolean") return "config.inheritSkills must be a boolean when provided.";
		target.inheritSkills = cfg.inheritSkills;
	}
	if (hasKey(cfg, "defaultContext")) {
		if (cfg.defaultContext === false || cfg.defaultContext === "") target.defaultContext = undefined;
		else if (cfg.defaultContext === "fresh" || cfg.defaultContext === "fork") target.defaultContext = cfg.defaultContext;
		else return "config.defaultContext must be 'fresh', 'fork', or false when provided.";
	}
	if (hasKey(cfg, "output")) {
		if (cfg.output === false || cfg.output === "") target.output = undefined;
		else if (typeof cfg.output === "string") target.output = cfg.output;
		else return "config.output must be a string or false when provided.";
	}
	if (hasKey(cfg, "reads")) {
		if (cfg.reads === false || cfg.reads === "") target.defaultReads = undefined;
		else if (typeof cfg.reads === "string") {
			const reads = parseCsv(cfg.reads);
			target.defaultReads = reads.length ? reads : undefined;
		} else return "config.reads must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "progress")) {
		if (typeof cfg.progress !== "boolean") return "config.progress must be a boolean when provided.";
		target.defaultProgress = cfg.progress;
	}
	if (hasKey(cfg, "maxSubagentDepth")) {
		if (cfg.maxSubagentDepth === false || cfg.maxSubagentDepth === "") target.maxSubagentDepth = undefined;
		else if (typeof cfg.maxSubagentDepth === "number" && Number.isInteger(cfg.maxSubagentDepth) && cfg.maxSubagentDepth >= 0) {
			target.maxSubagentDepth = cfg.maxSubagentDepth;
		} else return "config.maxSubagentDepth must be an integer >= 0 or false when provided.";
	}
	if (hasKey(cfg, "completionGuard")) {
		if (typeof cfg.completionGuard !== "boolean") return "config.completionGuard must be a boolean when provided.";
		target.completionGuard = cfg.completionGuard;
	}
	if (hasKey(cfg, "toolBudget")) {
		if (cfg.toolBudget === false || cfg.toolBudget === "") target.toolBudget = undefined;
		else {
			const validation = validateToolBudgetConfig(cfg.toolBudget, "config.toolBudget");
			if (validation.error) return validation.error;
			target.toolBudget = cfg.toolBudget as ToolBudgetConfig;
		}
	}
	return undefined;
}
