import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "../shared/utils.ts";
import { findModelInfo, getSupportedThinkingLevels, splitKnownThinkingSuffix, toModelInfo } from "../shared/model-info.ts";
import { DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS } from "./profile-types.ts";
import type { SubagentProfileFile, ProviderModelCatalogFile, ProviderModelCatalogModel, ProfileCheckResult, ProbeStatus } from "./profile-types.ts";
import { buildClassificationContext, classifyModel, probeModel, warningLineForHeuristicFallback, countHeuristicFallbackModels, catalogModelIsUsable, filterDominatedModels, pickTierModels, buildProfileFile, modelUsesHeuristicClassification } from "./model-classification.ts";
import { readJsonObjectFile, writeJsonFile, normalizeProfileName, normalizeProviderName, validateSubagentProfile, getUserSettingsPath, readSettingsFile } from "./profile-io.ts";

function resolveProfilePath(name: string): string {
	const dir = ensureSubagentProfilesDir();
	return path.join(dir, `${normalizeProfileName(name)}.json`);
}

export function getSubagentProfilesRootDir(): string {
	return path.join(getAgentDir(), "profiles", "pi-subagents");
}

export function getSubagentProfilesDir(): string {
	return getSubagentProfilesRootDir();
}

export function ensureSubagentProfilesDir(): string {
	const dir = getSubagentProfilesDir();
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function getProviderModelsDir(): string {
	return path.join(getSubagentProfilesRootDir(), "providers");
}

export function ensureProviderModelsDir(): string {
	const dir = getProviderModelsDir();
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function getProviderModelsPath(provider: string): string {
	return path.join(ensureProviderModelsDir(), `${normalizeProviderName(provider)}.models.json`);
}

export function listSubagentProfiles(): string[] {
	const dir = ensureSubagentProfilesDir();
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name.slice(0, -5))
		.sort((a, b) => a.localeCompare(b));
}

export function readSubagentProfile(name: string): { filePath: string; profile: SubagentProfileFile } {
	const filePath = resolveProfilePath(name);
	if (!fs.existsSync(filePath)) throw new Error(`Profile not found: ${name}`);
	const parsed = readJsonObjectFile(filePath);
	return { filePath, profile: validateSubagentProfile(filePath, parsed) };
}

export function applySubagentProfile(name: string): { filePath: string; settingsPath: string } {
	const { filePath, profile } = readSubagentProfile(name);
	const settingsPath = getUserSettingsPath();
	const settings = readSettingsFile(settingsPath);
	settings.subagents = profile.subagents;
	writeJsonFile(settingsPath, settings);
	return { filePath, settingsPath };
}

export function readProviderModelCatalog(provider: string): ProviderModelCatalogFile | null {
	const filePath = getProviderModelsPath(provider);
	if (!fs.existsSync(filePath)) return null;
	return readJsonObjectFile(filePath) as unknown as ProviderModelCatalogFile;
}

export function isProviderModelCatalogStale(catalog: ProviderModelCatalogFile, maxAgeDays = DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS): boolean {
	const refreshedAt = Date.parse(catalog.refreshedAt);
	if (!Number.isFinite(refreshedAt)) return true;
	const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
	return Date.now() - refreshedAt > maxAgeMs;
}

export async function refreshProviderModelCatalog(
	pi: Pick<ExtensionAPI, "exec"> | { exec?: ExtensionAPI["exec"] },
	ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">,
	provider: string,
	options: { force?: boolean; maxAgeDays?: number; probe?: boolean } = {},
): Promise<{ filePath: string; catalog: ProviderModelCatalogFile; reused: boolean; heuristicFallbackCount: number }> {
	const normalizedProvider = normalizeProviderName(provider);
	const maxAgeDays = options.maxAgeDays ?? DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS;
	const filePath = getProviderModelsPath(normalizedProvider);
	if (!options.force) {
		const existing = readProviderModelCatalog(normalizedProvider);
		if (existing && !isProviderModelCatalogStale(existing, maxAgeDays)) {
			return { filePath, catalog: existing, reused: true, heuristicFallbackCount: countHeuristicFallbackModels(existing) };
		}
	}

	const availableModels = ctx.modelRegistry.getAvailable().filter((model) => model.provider === normalizedProvider);
	if (availableModels.length === 0) {
		throw new Error(`No models found in the current registry for provider '${normalizedProvider}'.`);
	}

	const observedModels = [] as Array<{
		rawModel: typeof availableModels[number];
		modelRecord: Record<string, unknown> & { provider: string; id: string; name?: string };
		fullId: string;
		probe: { status: ProbeStatus; message?: string };
	}>;
	for (const rawModel of availableModels) {
		const modelRecord = rawModel as Record<string, unknown> & { provider: string; id: string; name?: string };
		const fullId = `${modelRecord.provider}/${modelRecord.id}`;
		const probe = options.probe === false
			? { status: "skipped" as const, message: "Live probing disabled." }
			: await probeModel(pi, ctx, fullId);
		observedModels.push({ rawModel, modelRecord, fullId, probe });
	}
	const classificationContext = buildClassificationContext(observedModels.map(({ modelRecord }) => ({
		id: modelRecord.id,
		...(typeof modelRecord.name === "string" ? { name: modelRecord.name } : {}),
		...(typeof modelRecord.reasoning === "boolean" ? { reasoning: modelRecord.reasoning } : {}),
		...(typeof modelRecord.contextWindow === "number" ? { contextWindow: modelRecord.contextWindow } : {}),
		...(typeof modelRecord.maxTokens === "number" ? { maxTokens: modelRecord.maxTokens } : {}),
		...(modelRecord.cost && typeof modelRecord.cost === "object" ? { cost: modelRecord.cost as ProviderModelCatalogModel["observed"]["cost"] } : {}),
	})));
	const models: ProviderModelCatalogModel[] = [];
	for (const { rawModel, modelRecord, fullId, probe } of observedModels) {
		const classification = classifyModel({
			id: modelRecord.id,
			...(typeof modelRecord.name === "string" ? { name: modelRecord.name } : {}),
			...(typeof modelRecord.reasoning === "boolean" ? { reasoning: modelRecord.reasoning } : {}),
			...(typeof modelRecord.contextWindow === "number" ? { contextWindow: modelRecord.contextWindow } : {}),
			...(typeof modelRecord.maxTokens === "number" ? { maxTokens: modelRecord.maxTokens } : {}),
			...(modelRecord.cost && typeof modelRecord.cost === "object" ? { cost: modelRecord.cost as ProviderModelCatalogModel["observed"]["cost"] } : {}),
		}, classificationContext);
		const warnings = classification.classificationSources.includes("heuristic-name") && !classification.classificationSources.includes("official-metadata")
			? [warningLineForHeuristicFallback()]
			: [];
		models.push({
			id: modelRecord.id,
			fullId,
			observed: {
				availableInRegistry: true,
				...(typeof modelRecord.name === "string" ? { name: modelRecord.name } : {}),
				...(typeof modelRecord.reasoning === "boolean" ? { reasoning: modelRecord.reasoning } : {}),
				thinkingLevels: getSupportedThinkingLevels(toModelInfo(rawModel)).map((level) => level),
				...(typeof modelRecord.contextWindow === "number" ? { contextWindow: modelRecord.contextWindow } : {}),
				...(typeof modelRecord.maxTokens === "number" ? { maxTokens: modelRecord.maxTokens } : {}),
				...(modelRecord.cost && typeof modelRecord.cost === "object" ? { cost: modelRecord.cost as ProviderModelCatalogModel["observed"]["cost"] } : {}),
				probe: {
					status: probe.status,
					checkedAt: new Date().toISOString(),
					...(probe.message ? { message: probe.message } : {}),
				},
			},
			derived: classification,
			warnings,
			notes: [],
		});
	}
	models.sort((a, b) => a.derived.profileRank - b.derived.profileRank || a.fullId.localeCompare(b.fullId));
	const catalog: ProviderModelCatalogFile = {
		provider: normalizedProvider,
		refreshedAt: new Date().toISOString(),
		maxAgeDays,
		sources: ["runtime-registry", ...(options.probe === false ? [] : ["live-probe"]), "heuristic-classifier"],
		models,
	};
	writeJsonFile(filePath, catalog);
	return { filePath, catalog, reused: false, heuristicFallbackCount: countHeuristicFallbackModels(catalog) };
}

export async function generateProfilesForProvider(
	pi: Pick<ExtensionAPI, "exec"> | { exec?: ExtensionAPI["exec"] },
	ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">,
	provider: string,
	options: { maxAgeDays?: number; forceRefresh?: boolean; probe?: boolean } = {},
): Promise<{ quotaPath: string; qualityPath: string; catalogPath: string; quotaModels: { cheap: string; medium: string; strong: string }; qualityModels: { cheap: string; medium: string; strong: string }; heuristicFallbackCount: number; selectedHeuristicFallbackCount: number }> {
	const normalizedProvider = normalizeProviderName(provider);
	const { filePath: catalogPath, catalog, heuristicFallbackCount } = await refreshProviderModelCatalog(pi, ctx, normalizedProvider, {
		maxAgeDays: options.maxAgeDays,
		force: options.forceRefresh,
		probe: options.probe,
	});
	const usableModels = catalog.models.filter(catalogModelIsUsable);
	const profileModels = filterDominatedModels(usableModels);
	if (profileModels.length === 0) {
		throw new Error(`Provider '${normalizedProvider}' has no usable models after filtering.`);
	}
	const quotaModels = pickTierModels(profileModels, "quota");
	const qualityModels = pickTierModels(profileModels, "quality");
	const dir = ensureSubagentProfilesDir();
	const quotaPath = path.join(dir, `${normalizedProvider}.quota.json`);
	const qualityPath = path.join(dir, `${normalizedProvider}.quality.json`);
	writeJsonFile(quotaPath, buildProfileFile("quota", quotaModels));
	writeJsonFile(qualityPath, buildProfileFile("quality", qualityModels));
	const selectedModels = new Set([...Object.values(quotaModels), ...Object.values(qualityModels)]);
	const selectedHeuristicFallbackCount = profileModels.filter((model) => selectedModels.has(model.fullId) && modelUsesHeuristicClassification(model)).length;
	return { quotaPath, qualityPath, catalogPath, quotaModels, qualityModels, heuristicFallbackCount, selectedHeuristicFallbackCount };
}

export async function checkSubagentProfile(
	pi: Pick<ExtensionAPI, "exec"> | { exec?: ExtensionAPI["exec"] },
	ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">,
	name: string,
): Promise<ProfileCheckResult> {
	const { filePath, profile } = readSubagentProfile(name);
	const availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const entries = Object.entries(profile.subagents.agentOverrides)
		.filter(([, value]) => typeof value?.model === "string" && value.model.trim())
		.map(([agent, value]) => ({ agent, model: value.model!.trim() }));
	const probeCache = new Map<string, { status: ProbeStatus; message?: string }>();
	const results: ProfileCheckResult["results"] = [];
	for (const entry of entries) {
		const modelInfo = findModelInfo(entry.model, availableModels);
		const { thinkingSuffix } = splitKnownThinkingSuffix(entry.model);
		const probeModelId = modelInfo ? `${modelInfo.fullId}${thinkingSuffix}` : entry.model;
		let probe = probeCache.get(probeModelId);
		if (!probe) {
			probe = await probeModel(pi, ctx, probeModelId);
			probeCache.set(probeModelId, probe);
		}
		results.push({
			agent: entry.agent,
			model: entry.model,
			inRegistry: modelInfo !== undefined,
			probe,
		});
	}
	return { profileName: name, filePath, results };
}
