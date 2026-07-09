/** Agent discovery and configuration — barrel re-export hub for the agents/ submodules. */

export {
	type AgentConfig,
	type AgentDefaultContext,
	type AgentMemoryConfig,
	type AgentMemoryScope,
	type AgentModelSourceInfo,
	type AgentScope,
	type AgentSource,
	BUILTIN_AGENT_NAMES,
	type BuiltinAgentOverrideBase,
	type ChainConfig,
	type ChainDiscoveryDiagnostic,
	type ChainStepConfig,
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
} from "./agents/types.ts";

export { findNearestProjectRoot } from "./agents/project-root.ts";

export {
	buildBuiltinOverrideConfig,
	mergeBuiltinAgentOverride,
	removeBuiltinAgentOverride,
	removeBuiltinAgentOverrideFields,
	saveBuiltinAgentOverride,
} from "./agents/overrides/config.ts";

export { EXTRA_AGENT_DIRS_ENV, discoverAgents, discoverAgentsAll } from "./agents/discovery.ts";

export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";
