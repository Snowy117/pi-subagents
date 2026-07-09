import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENT_NAMES } from "../agents/agents.ts";
import type { ProfileKind, ProbeStatus, CostTier, QualityTier, LatencyTier, RecommendedRoleTier, ClassificationSource, ProviderModelCatalogModel, ProviderModelCatalogFile, SubagentProfileFile } from "./profile-types.ts";

type BuiltinAgentName = typeof BUILTIN_AGENT_NAMES[number];

function extractVersionScore(id: string): number {
	const match = id.match(/(\d+(?:\.\d+)?)/g);
	if (!match || match.length === 0) return 0;
	return Math.max(...match.map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value)));
}

function modelNameTokens(modelName: string): string[] {
	return modelName
		.toLowerCase()
		.replace(/([a-z])([0-9])/g, "$1 $2")
		.replace(/([0-9])([a-z])/g, "$1 $2")
		.split(/[^a-z0-9.]+/)
		.filter(Boolean);
}

function inferProfileBand(modelName: string): 0 | 1 | 2 | 3 | 4 {
	const tokens = new Set(modelNameTokens(modelName));
	if (["spark", "flash", "nano", "tiny", "instant"].some((token) => tokens.has(token))) return 0;
	if (["mini", "haiku", "small"].some((token) => tokens.has(token))) return 1;
	if (["opus", "max", "ultra", "pro"].some((token) => tokens.has(token))) return 4;
	if (["sonnet", "turbo", "plus"].some((token) => tokens.has(token))) return 3;
	return 2;
}

interface ModelClassificationInput {
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

interface NumericStats {
	min: number;
	max: number;
}

interface ClassificationContext {
	cost?: NumericStats;
	contextWindow?: NumericStats;
	maxTokens?: NumericStats;
}

function combinedCost(cost: ModelClassificationInput["cost"]): number | undefined {
	if (!cost) return undefined;
	const values = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	if (values.length === 0) return undefined;
	return values.reduce((sum, value) => sum + value, 0);
}

function collectStats(values: Array<number | undefined>): NumericStats | undefined {
	const filtered = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	if (filtered.length === 0) return undefined;
	return { min: Math.min(...filtered), max: Math.max(...filtered) };
}

function normalize(value: number | undefined, stats: NumericStats | undefined): number | undefined {
	if (value === undefined || !stats) return undefined;
	if (stats.max <= stats.min) return 0.5;
	return (value - stats.min) / (stats.max - stats.min);
}

export function buildClassificationContext(models: ModelClassificationInput[]): ClassificationContext {
	return {
		cost: collectStats(models.map((model) => combinedCost(model.cost))),
		contextWindow: collectStats(models.map((model) => model.contextWindow)),
		maxTokens: collectStats(models.map((model) => model.maxTokens)),
	};
}

function rankToCostTier(rank: number): CostTier {
	if (rank <= 0.33) return "cheap";
	if (rank <= 0.66) return "medium";
	return "expensive";
}

function scoreToQualityTier(score: number): QualityTier {
	if (score <= 0.33) return "weak";
	if (score <= 0.66) return "medium";
	return "strong";
}

function qualityTierToRoleTier(quality: QualityTier, cost: CostTier): RecommendedRoleTier {
	if (quality === "strong") return "strong";
	if (quality === "medium") return cost === "cheap" ? "cheap" : "medium";
	return "cheap";
}

function agentsForRoleTier(roleTier: RecommendedRoleTier): BuiltinAgentName[] {
	if (roleTier === "cheap") return ["scout", "delegate"];
	if (roleTier === "medium") return ["planner", "context-builder", "researcher"];
	return ["worker", "reviewer", "oracle"];
}

export function classifyModel(input: ModelClassificationInput, context: ClassificationContext): {
	profileRank: number;
	costTier: CostTier;
	qualityTier: QualityTier;
	latencyTier: LatencyTier;
	recommendedRoleTier: RecommendedRoleTier;
	recommendedAgents: BuiltinAgentName[];
	classificationSources: ClassificationSource[];
} {
	const modelName = input.name?.trim() || input.id;
	const tokens = new Set(modelNameTokens(modelName));
	const band = inferProfileBand(modelName);
	const versionScore = extractVersionScore(input.id);
	const costNorm = normalize(combinedCost(input.cost), context.cost);
	const contextNorm = normalize(input.contextWindow, context.contextWindow);
	const maxTokensNorm = normalize(input.maxTokens, context.maxTokens);
	const hasOfficialMetadata = costNorm !== undefined || contextNorm !== undefined || maxTokensNorm !== undefined;
	const classificationSources: ClassificationSource[] = hasOfficialMetadata
		? ["official-metadata", "heuristic-name"]
		: ["heuristic-name"];
	const heuristicBase = band / 4;
	const qualitySignals = [
		heuristicBase,
		...(contextNorm !== undefined ? [contextNorm] : []),
		...(maxTokensNorm !== undefined ? [maxTokensNorm] : []),
		...(input.reasoning === true ? [1] : []),
		...(input.reasoning === false ? [0] : []),
	];
	const latencyHintsFast = tokens.has("highspeed") || tokens.has("flash") || tokens.has("instant") || tokens.has("turbo");
	const latencyHintsSlow = tokens.has("pro") || tokens.has("ultra") || tokens.has("opus") || tokens.has("max");
	let qualityScore = qualitySignals.reduce((sum, value) => sum + value, 0) / qualitySignals.length;
	if (latencyHintsFast) {
		qualityScore -= 0.2;
	}
	qualityScore = Math.max(0, Math.min(1, qualityScore));
	const costTier = costNorm !== undefined
		? rankToCostTier(costNorm)
		: band === 0 ? "cheap" : band >= 3 ? "expensive" : "medium";
	const qualityTier = scoreToQualityTier(qualityScore);
	const latencyTier: LatencyTier = latencyHintsFast
		? "fast"
		: latencyHintsSlow
			? "slow"
			: costNorm !== undefined
				? (costNorm <= 0.33 ? "fast" : costNorm <= 0.66 ? "medium" : "slow")
				: (band <= 1 ? "fast" : band >= 3 ? "slow" : "medium");
	const recommendedRoleTier = qualityTierToRoleTier(qualityTier, costTier);
	const latencyPenalty = latencyHintsFast ? 125 : 0;
	const profileRank = Math.round((qualityScore * 100) * 10) + Math.round(versionScore * 25) - latencyPenalty;
	return {
		profileRank,
		costTier,
		qualityTier,
		latencyTier,
		recommendedRoleTier,
		recommendedAgents: agentsForRoleTier(recommendedRoleTier),
		classificationSources,
	};
}

function resolveProbeStatus(text: string, timedOut: boolean): ProbeStatus {
	if (timedOut) return "timeout";
	if (!text) return "error";
	if (/(unauthori[sz]ed|forbidden|api key|auth|billing|credit|quota)/i.test(text)) return "auth";
	if (/(not found|unknown model|model unavailable|model disabled|unsupported model|unavailable)/i.test(text)) return "unavailable";
	return "error";
}

export async function probeModel(
	pi: Pick<ExtensionAPI, "exec"> | { exec?: ExtensionAPI["exec"] },
	ctx: Pick<ExtensionContext, "cwd">,
	fullId: string,
): Promise<{ status: ProbeStatus; message?: string }> {
	if (typeof pi.exec !== "function") {
		return { status: "skipped", message: "pi.exec is unavailable in this runtime." };
	}
	const result = await pi.exec("pi", ["-p", "--model", fullId, "--no-tools", 'Reply with exactly "OK".'], {
		cwd: os.tmpdir(),
		timeout: 45_000,
	} as Record<string, unknown>);
	const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
	const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
	const combined = [stderr, stdout].filter(Boolean).join("\n").trim();
	if (result.code === 0) return { status: "ok", message: stdout || "Probe succeeded." };
	return { status: resolveProbeStatus(combined, result.killed === true), message: combined || `Probe exited with code ${result.code ?? "unknown"}.` };
}

function roundIndex(count: number, position: number): number {
	if (count <= 1) return 0;
	return Math.max(0, Math.min(count - 1, Math.round((count - 1) * position)));
}

function profilePositions(kind: ProfileKind): { cheap: number; medium: number; strong: number } {
	return kind === "quota"
		? { cheap: 0, medium: 1 / 3, strong: 2 / 3 }
		: { cheap: 1 / 3, medium: 2 / 3, strong: 1 };
}

export function pickTierModels(models: ProviderModelCatalogModel[], kind: ProfileKind): { cheap: string; medium: string; strong: string } {
	if (models.length === 0) throw new Error("No provider models are available for profile generation.");
	const selectionPool = kind === "quota" && models.length > 1
		? models.slice(0, -1)
		: models;
	const positions = profilePositions(kind);
	return {
		cheap: selectionPool[roundIndex(selectionPool.length, positions.cheap)]!.fullId,
		medium: selectionPool[roundIndex(selectionPool.length, positions.medium)]!.fullId,
		strong: selectionPool[roundIndex(selectionPool.length, positions.strong)]!.fullId,
	};
}

function observedCombinedCost(model: ProviderModelCatalogModel): number | undefined {
	return combinedCost(model.observed.cost);
}

function dominatesModel(a: ProviderModelCatalogModel, b: ProviderModelCatalogModel): boolean {
	const costA = observedCombinedCost(a);
	const costB = observedCombinedCost(b);
	if (costA === undefined || costB === undefined) return false;
	if (costA > costB) return false;
	if (a.derived.profileRank < b.derived.profileRank) return false;
	if ((a.observed.reasoning === true ? 1 : 0) < (b.observed.reasoning === true ? 1 : 0)) return false;
	if ((a.observed.contextWindow ?? 0) < (b.observed.contextWindow ?? 0)) return false;
	if ((a.observed.maxTokens ?? 0) < (b.observed.maxTokens ?? 0)) return false;
	return costA < costB
		|| a.derived.profileRank > b.derived.profileRank
		|| (a.observed.reasoning === true && b.observed.reasoning !== true)
		|| (a.observed.contextWindow ?? 0) > (b.observed.contextWindow ?? 0)
		|| (a.observed.maxTokens ?? 0) > (b.observed.maxTokens ?? 0);
}

export function filterDominatedModels(models: ProviderModelCatalogModel[]): ProviderModelCatalogModel[] {
	return models.filter((candidate, index) => !models.some((other, otherIndex) => otherIndex !== index && dominatesModel(other, candidate)));
}

export function buildProfileFile(kind: ProfileKind, models: { cheap: string; medium: string; strong: string }): SubagentProfileFile {
	return {
		subagents: {
			agentOverrides: {
				scout: { model: models.cheap },
				delegate: { model: models.cheap },
				planner: { model: models.medium },
				"context-builder": { model: models.medium },
				researcher: { model: models.medium },
				worker: { model: models.strong },
				reviewer: { model: models.strong },
				oracle: { model: models.strong },
			},
		},
	};
}

export function catalogModelIsUsable(model: ProviderModelCatalogModel): boolean {
	return model.observed.availableInRegistry && model.observed.probe.status !== "unavailable" && model.observed.probe.status !== "auth" && model.observed.probe.status !== "timeout" && model.observed.probe.status !== "error";
}

export function modelUsesHeuristicClassification(model: ProviderModelCatalogModel): boolean {
	return model.derived.classificationSources.includes("heuristic-name")
		&& !model.derived.classificationSources.includes("official-metadata");
}

export function warningLineForHeuristicFallback(): string {
	return "Classification fell back to name heuristics.";
}

export function countHeuristicFallbackModels(catalog: ProviderModelCatalogFile): number {
	return catalog.models.filter(modelUsesHeuristicClassification).length;
}
