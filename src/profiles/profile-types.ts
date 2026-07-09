import { BUILTIN_AGENT_NAMES } from "../agents/agents.ts";

export const DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS = 7;

type BuiltinAgentName = typeof BUILTIN_AGENT_NAMES[number];
export type ProfileKind = "quota" | "quality";
export type ProbeStatus = "ok" | "unavailable" | "auth" | "timeout" | "error" | "skipped";
export type CostTier = "cheap" | "medium" | "expensive";
export type QualityTier = "weak" | "medium" | "strong";
export type LatencyTier = "fast" | "medium" | "slow";
export type RecommendedRoleTier = "cheap" | "medium" | "strong";

interface ProfileAgentOverride {
	model?: string;
}

export interface SubagentProfileFile {
	subagents: {
		agentOverrides: Record<string, ProfileAgentOverride>;
	};
}

export type ClassificationSource = "official-metadata" | "heuristic-name";

export interface ProviderModelCatalogModel {
	id: string;
	fullId: string;
	observed: {
		availableInRegistry: boolean;
		name?: string;
		reasoning?: boolean;
		thinkingLevels: string[];
		contextWindow?: number;
		maxTokens?: number;
		cost?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
		};
		probe: {
			status: ProbeStatus;
			checkedAt: string;
			message?: string;
		};
	};
	derived: {
		profileRank: number;
		costTier: CostTier;
		qualityTier: QualityTier;
		latencyTier: LatencyTier;
		recommendedRoleTier: RecommendedRoleTier;
		recommendedAgents: BuiltinAgentName[];
		classificationSources: ClassificationSource[];
	};
	warnings: string[];
	notes: string[];
}

export interface ProviderModelCatalogFile {
	provider: string;
	refreshedAt: string;
	maxAgeDays: number;
	sources: string[];
	models: ProviderModelCatalogModel[];
}

export interface ProfileCheckResult {
	profileName: string;
	filePath: string;
	results: Array<{
		agent: string;
		model: string;
		inRegistry: boolean;
		probe: { status: ProbeStatus; message?: string };
	}>;
}
