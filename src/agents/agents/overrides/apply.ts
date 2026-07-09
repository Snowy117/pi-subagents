/**
 * Builtin and custom agent override application logic.
 *
 * Merges settings-derived overrides onto discovered agent configs, including
 * default-model assignment, bulk disable/thinking handling, and per-agent
 * builtin/custom override application. The four entry points
 * (resolveSubagentDefaultModel, applySubagentDefaultModel, applyBuiltinOverrides,
 * applyCustomAgentOverrides) are consumed by the discovery orchestration.
 */

import { agentFrontmatterFields } from "../types.ts";
import type { AgentConfig, AgentModelSourceInfo, BuiltinAgentOverrideBase, BuiltinAgentOverrideConfig, SubagentSettings } from "../types.ts";

function splitToolList(rawTools: string[] | undefined): { tools?: string[]; mcpDirectTools?: string[] } {
	const mcpDirectTools: string[] = [];
	const tools: string[] = [];
	for (const tool of rawTools ?? []) {
		if (tool.startsWith("mcp:")) {
			mcpDirectTools.push(tool.slice(4));
		} else {
			tools.push(tool);
		}
	}
	return {
		...(tools.length > 0 ? { tools } : {}),
		...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
	};
}

function cloneOverrideBase(agent: AgentConfig): BuiltinAgentOverrideBase {
	return {
		model: agent.model,
		fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		defaultContext: agent.defaultContext,
		disabled: agent.disabled,
		systemPrompt: agent.systemPrompt,
		skills: agent.skills ? [...agent.skills] : undefined,
		tools: agent.tools ? [...agent.tools] : undefined,
		mcpDirectTools: agent.mcpDirectTools ? [...agent.mcpDirectTools] : undefined,
		subagentOnlyExtensions: agent.subagentOnlyExtensions ? [...agent.subagentOnlyExtensions] : undefined,
		completionGuard: agent.completionGuard,
		toolBudget: agent.toolBudget,
	};
}

export function resolveSubagentDefaultModel(
	userSettings: SubagentSettings,
	projectSettings: SubagentSettings,
	userSettingsPath: string,
	projectSettingsPath: string | null,
): AgentModelSourceInfo | undefined {
	if (projectSettingsPath && projectSettings.defaultModel !== undefined) {
		return { type: "subagents.defaultModel", scope: "project", path: projectSettingsPath, model: projectSettings.defaultModel };
	}
	return userSettings.defaultModel !== undefined
		? { type: "subagents.defaultModel", scope: "user", path: userSettingsPath, model: userSettings.defaultModel }
		: undefined;
}

export function applySubagentDefaultModel(agents: AgentConfig[], defaultModel: AgentModelSourceInfo | undefined): AgentConfig[] {
	if (!defaultModel) return agents;
	return agents.map((agent) => {
		if (agent.model !== undefined) return agent;
		const next = { ...agent, model: defaultModel.model, modelSource: defaultModel };
		const frontmatterFields = agentFrontmatterFields.get(agent);
		if (frontmatterFields) agentFrontmatterFields.set(next, frontmatterFields);
		return next;
	});
}

function applyBuiltinOverride(
	agent: AgentConfig,
	override: BuiltinAgentOverrideConfig,
	meta: { scope: "user" | "project"; path: string },
): AgentConfig {
	const next: AgentConfig = {
		...agent,
		override: { ...meta, base: cloneOverrideBase(agent) },
	};

	if (override.model !== undefined) next.model = override.model === false ? undefined : override.model;
	if (override.fallbackModels !== undefined) {
		next.fallbackModels = override.fallbackModels === false ? undefined : [...override.fallbackModels];
	}
	if (override.thinking !== undefined) next.thinking = override.thinking === false ? undefined : override.thinking;
	if (override.systemPromptMode !== undefined) next.systemPromptMode = override.systemPromptMode;
	if (override.inheritProjectContext !== undefined) next.inheritProjectContext = override.inheritProjectContext;
	if (override.inheritSkills !== undefined) next.inheritSkills = override.inheritSkills;
	if (override.defaultContext !== undefined) next.defaultContext = override.defaultContext === false ? undefined : override.defaultContext;
	if (override.disabled !== undefined) next.disabled = override.disabled;
	if (override.systemPrompt !== undefined) next.systemPrompt = override.systemPrompt;
	if (override.skills !== undefined) next.skills = override.skills === false ? undefined : [...override.skills];
	if (override.tools !== undefined) {
		const { tools, mcpDirectTools } = splitToolList(override.tools === false ? [] : override.tools);
		next.tools = tools;
		next.mcpDirectTools = mcpDirectTools;
	}
	if (override.subagentOnlyExtensions !== undefined) {
		next.subagentOnlyExtensions = override.subagentOnlyExtensions === false ? undefined : [...override.subagentOnlyExtensions];
	}
	if (override.completionGuard !== undefined) next.completionGuard = override.completionGuard;
	if (override.toolBudget !== undefined) next.toolBudget = override.toolBudget === false ? undefined : override.toolBudget;

	return next;
}

function clearBuiltinThinking(agent: AgentConfig, meta: { scope: "user" | "project"; path: string }): AgentConfig {
	if (agent.thinking === undefined) return agent;
	return {
		...agent,
		thinking: undefined,
		override: agent.override ?? { ...meta, base: cloneOverrideBase(agent) },
	};
}

export function applyBuiltinOverrides(
	builtinAgents: AgentConfig[],
	userSettings: SubagentSettings,
	projectSettings: SubagentSettings,
	userSettingsPath: string,
	projectSettingsPath: string | null,
): AgentConfig[] {
	const projectBulkDisabled = projectSettings.disableBuiltins === true && projectSettingsPath !== null;
	const userBulkDisabled = projectSettings.disableBuiltins === undefined && userSettings.disableBuiltins === true;
	const projectThinkingConfigured = projectSettings.disableThinking !== undefined && projectSettingsPath !== null;
	const disableThinking = projectThinkingConfigured ? projectSettings.disableThinking === true : userSettings.disableThinking === true;
	const disableThinkingMeta = projectThinkingConfigured
		? { scope: "project" as const, path: projectSettingsPath! }
		: { scope: "user" as const, path: userSettingsPath };

	const applyGlobalThinking = (agent: AgentConfig, hasExplicitThinkingOverride: boolean): AgentConfig => {
		if (!disableThinking || hasExplicitThinkingOverride) return agent;
		return clearBuiltinThinking(agent, disableThinkingMeta);
	};

	return builtinAgents.map((agent) => {
		const projectOverride = projectSettings.overrides[agent.name];
		if (projectOverride && projectSettingsPath) {
			return applyGlobalThinking(
				applyBuiltinOverride(agent, projectOverride, { scope: "project", path: projectSettingsPath }),
				projectOverride.thinking !== undefined,
			);
		}

		if (projectBulkDisabled && projectSettingsPath) {
			return applyGlobalThinking(
				applyBuiltinOverride(agent, { disabled: true }, { scope: "project", path: projectSettingsPath }),
				false,
			);
		}

		const userOverride = userSettings.overrides[agent.name];
		if (userOverride) {
			return applyGlobalThinking(
				applyBuiltinOverride(agent, userOverride, { scope: "user", path: userSettingsPath }),
				!projectThinkingConfigured && userOverride.thinking !== undefined,
			);
		}

		if (userBulkDisabled) {
			return applyGlobalThinking(
				applyBuiltinOverride(agent, { disabled: true }, { scope: "user", path: userSettingsPath }),
				false,
			);
		}

		return applyGlobalThinking(agent, false);
	});
}

function customAgentHasFrontmatterField(agent: AgentConfig, ...fields: string[]): boolean {
	const frontmatterFields = agentFrontmatterFields.get(agent);
	return frontmatterFields ? fields.some((field) => frontmatterFields.has(field)) : false;
}

function applyCustomAgentOverride(
	agent: AgentConfig,
	override: BuiltinAgentOverrideConfig,
	meta: { scope: "user" | "project"; path: string },
): AgentConfig {
	let next: AgentConfig | undefined;
	let anyFilled = false;

	const mutable = (): AgentConfig => {
		next ??= { ...agent };
		return next;
	};

	const fill = <K extends keyof AgentConfig>(
		field: K,
		frontmatterFields: string[],
		value: AgentConfig[K],
	): void => {
		if (customAgentHasFrontmatterField(agent, ...frontmatterFields)) return;
		mutable()[field] = value;
		anyFilled = true;
	};

	if (override.model !== undefined) {
		fill("model", ["model"], override.model === false ? undefined : override.model);
	}
	if (override.fallbackModels !== undefined) {
		fill(
			"fallbackModels",
			["fallbackModels"],
			override.fallbackModels === false ? undefined : [...override.fallbackModels],
		);
	}
	if (override.thinking !== undefined) {
		fill("thinking", ["thinking"], override.thinking === false ? undefined : override.thinking);
	}
	if (override.systemPromptMode !== undefined) {
		fill("systemPromptMode", ["systemPromptMode"], override.systemPromptMode);
	}
	if (override.inheritProjectContext !== undefined) {
		fill("inheritProjectContext", ["inheritProjectContext"], override.inheritProjectContext);
	}
	if (override.inheritSkills !== undefined) {
		fill("inheritSkills", ["inheritSkills"], override.inheritSkills);
	}
	if (override.defaultContext !== undefined) {
		fill("defaultContext", ["defaultContext"], override.defaultContext === false ? undefined : override.defaultContext);
	}
	if (override.disabled !== undefined && agent.disabled === undefined) {
		mutable().disabled = override.disabled;
		anyFilled = true;
	}
	if (override.skills !== undefined) {
		fill("skills", ["skill", "skills"], override.skills === false ? undefined : [...override.skills]);
	}
	if (override.tools !== undefined && !customAgentHasFrontmatterField(agent, "tools")) {
		const { tools, mcpDirectTools } = splitToolList(override.tools === false ? [] : override.tools);
		const target = mutable();
		target.tools = tools;
		target.mcpDirectTools = mcpDirectTools;
		anyFilled = true;
	}
	if (override.subagentOnlyExtensions !== undefined) {
		fill(
			"subagentOnlyExtensions",
			["subagentOnlyExtensions"],
			override.subagentOnlyExtensions === false ? undefined : [...override.subagentOnlyExtensions],
		);
	}
	if (override.completionGuard !== undefined) {
		fill("completionGuard", ["completionGuard"], override.completionGuard);
	}
	if (override.toolBudget !== undefined) {
		fill("toolBudget", ["toolBudget"], override.toolBudget === false ? undefined : override.toolBudget);
	}

	if (!anyFilled || !next) return agent;
	next.override = { ...meta, base: cloneOverrideBase(agent) };
	return next;
}

export function applyCustomAgentOverrides(
	agents: AgentConfig[],
	userSettings: SubagentSettings,
	projectSettings: SubagentSettings,
	userSettingsPath: string,
	projectSettingsPath: string | null,
): AgentConfig[] {
	return agents.map((agent) => {
		const projectOverride = projectSettings.overrides[agent.name];
		if (projectOverride && projectSettingsPath) {
			return applyCustomAgentOverride(agent, projectOverride, { scope: "project", path: projectSettingsPath });
		}

		const userOverride = userSettings.overrides[agent.name];
		if (userOverride) {
			return applyCustomAgentOverride(agent, userOverride, { scope: "user", path: userSettingsPath });
		}

		return agent;
	});
}
