import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENT_NAMES } from "../../agents/agents.ts";
import {
	DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS,
	applySubagentProfile,
	checkSubagentProfile,
	generateProfilesForProvider,
	listSubagentProfiles,
	readSubagentProfile,
	refreshProviderModelCatalog,
} from "../../profiles/profiles.ts";
import { findModelInfo, toModelInfo } from "../../shared/model-info.ts";
import type { SubagentState } from "../../shared/types.ts";
import { makeBuiltinAgentNameCompletions, makeProviderCompletions } from "./completions.ts";
import { runSlashSubagent } from "./slash-run.ts";
import { sendSlashText, withSlashStatus } from "./slash-helpers.ts";

function parseSingleRequiredArg(args: string, usage: string): { ok: true; value: string } | { ok: false; message: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length !== 1) return { ok: false, message: usage };
	return { ok: true, value: parts[0]! };
}

function getProfileWorkerModel(profile: { subagents?: { agentOverrides?: Record<string, { model?: string }> } }): string | undefined {
	const model = profile.subagents?.agentOverrides?.worker?.model;
	return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

export function registerProfileCommands(
	pi: ExtensionAPI,
	state: SubagentState,
): void {
	pi.registerCommand("subagents-models", {
		description: "Show runtime-loaded builtin subagent models",
		getArgumentCompletions: makeBuiltinAgentNameCompletions(),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await runSlashSubagent(pi, ctx, { action: "models" });
				return;
			}
			const parts = trimmed.split(/\s+/).filter(Boolean);
			if (parts.length !== 1) {
				ctx.ui.notify("Usage: /subagents-models [builtin-agent-name]", "error");
				return;
			}
			const agent = parts[0]!;
			if (!(BUILTIN_AGENT_NAMES as readonly string[]).includes(agent)) {
				ctx.ui.notify(`Unknown builtin agent: ${agent}`, "error");
				return;
			}
			await runSlashSubagent(pi, ctx, { action: "models", agent });
		},
	});

	pi.registerCommand("subagents-profiles", {
		description: "List saved subagent profiles",
		handler: async (_args, _ctx) => {
			const profiles = listSubagentProfiles();
			if (profiles.length === 0) {
				sendSlashText(pi, "Subagent profiles\n\nNo subagent profiles found in ~/.pi/agent/profiles/pi-subagents/");
				return;
			}
			sendSlashText(pi, `Subagent profiles\n\n${profiles.join("\n")}`);
		},
	});

	pi.registerCommand("subagents-load-profile", {
		description: "Load a subagent profile into ~/.pi/agent/settings.json",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			return listSubagentProfiles()
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
		},
		handler: async (args, ctx) => {
			const parsed = parseSingleRequiredArg(args, "Usage: /subagents-load-profile <name>");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(ctx, `Loading profile ${parsed.value}…`, async () => {
					const { profile } = readSubagentProfile(parsed.value);
					const workerModel = getProfileWorkerModel(profile);
					const result = applySubagentProfile(parsed.value);
					const lines = [
						`Loaded subagent profile: ${parsed.value}`,
						`Profile: ${result.filePath}`,
						`Updated: ${result.settingsPath}`,
					];

					if (workerModel && typeof pi.setModel === "function" && typeof ctx.modelRegistry?.find === "function" && typeof ctx.modelRegistry?.getAvailable === "function") {
						const shouldSwitch = await ctx.ui.confirm(
							"",
							`Profile loaded. Also switch this session to the profile worker model?\n\n${workerModel}`,
						);
						if (shouldSwitch) {
							const modelInfo = findModelInfo(workerModel, ctx.modelRegistry.getAvailable().map(toModelInfo));
							const model = modelInfo ? ctx.modelRegistry.find(modelInfo.provider, modelInfo.id) : undefined;
							if (!modelInfo || !model) {
								lines.push(`Could not switch current session model: '${workerModel}' is not available in the current model registry.`);
							} else {
								const success = await pi.setModel(model);
								if (success) lines.push(`Current session model switched to: ${modelInfo.fullId}`);
								else lines.push(`Could not switch current session model to '${workerModel}': no API key or provider access is available.`);
							}
						}
					} else if (workerModel) {
						lines.push(`Profile worker model: ${workerModel}`);
					}

					sendSlashText(pi, lines.join("\n"));
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("subagents-refresh-provider-models", {
		description: "Refresh the cached model catalog for one provider",
		getArgumentCompletions: makeProviderCompletions(state),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const force = /(?:^|\s)--force$/.test(trimmed) || /(?:^|\s)force$/.test(trimmed);
			const withoutForce = trimmed.replace(/(?:^|\s)(?:--force|force)$/, "").trim();
			const parsed = parseSingleRequiredArg(withoutForce, "Usage: /subagents-refresh-provider-models <provider> [--force]");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(ctx, `Refreshing provider models for ${parsed.value}…`, async () => {
					const result = await refreshProviderModelCatalog(pi, ctx, parsed.value, { force, maxAgeDays: DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS });
					const lines = [
						"Provider model catalog",
						`Provider: ${parsed.value}`,
						`Status: ${result.reused ? "fresh cache reused" : "refreshed"}`,
						`File: ${result.filePath}`,
						`Models: ${result.catalog.models.length}`,
						`Refreshed at: ${result.catalog.refreshedAt}`,
					];
					if (result.heuristicFallbackCount > 0) {
						lines.push(`Warning: ${result.heuristicFallbackCount} model${result.heuristicFallbackCount === 1 ? " was" : "s were"} classified with name heuristics fallback.`);
					}
					sendSlashText(pi, lines.join("\n"));
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("subagents-generate-profiles", {
		description: "Generate <provider>.quota and <provider>.quality subagent profiles",
		getArgumentCompletions: makeProviderCompletions(state),
		handler: async (args, ctx) => {
			const parsed = parseSingleRequiredArg(args, "Usage: /subagents-generate-profiles <provider>");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(ctx, `Generating profiles for ${parsed.value}…`, async () => {
					const result = await generateProfilesForProvider(pi, ctx, parsed.value, { maxAgeDays: DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS });
					const lines = [
						"Generated subagent profiles",
						`Provider: ${parsed.value}`,
						`Catalog: ${result.catalogPath}`,
						`Quota: ${result.quotaPath}`,
						`  cheap=${result.quotaModels.cheap}`,
						`  medium=${result.quotaModels.medium}`,
						`  strong=${result.quotaModels.strong}`,
						`Quality: ${result.qualityPath}`,
						`  cheap=${result.qualityModels.cheap}`,
						`  medium=${result.qualityModels.medium}`,
						`  strong=${result.qualityModels.strong}`,
					];
					if (result.selectedHeuristicFallbackCount > 0) {
						lines.push(`Warning: generated profiles depend on heuristic-only classification for ${result.selectedHeuristicFallbackCount} selected model${result.selectedHeuristicFallbackCount === 1 ? "" : "s"}.`);
					} else if (result.heuristicFallbackCount > 0) {
						lines.push(`Warning: provider catalog still contains ${result.heuristicFallbackCount} heuristic-classified model${result.heuristicFallbackCount === 1 ? "" : "s"}.`);
					}
					sendSlashText(pi, lines.join("\n"));
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("subagents-check-profile", {
		description: "Check whether a saved profile still points to usable models",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			return listSubagentProfiles()
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
		},
		handler: async (args, ctx) => {
			const parsed = parseSingleRequiredArg(args, "Usage: /subagents-check-profile <name>");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(ctx, `Checking profile ${parsed.value}…`, async () => {
					const result = await checkSubagentProfile(pi, ctx, parsed.value);
					const lines = [
						"Subagent profile check",
						`Profile: ${result.profileName}`,
						`File: ${result.filePath}`,
						"",
						...result.results.map((entry) => `${entry.agent} → ${entry.model} — registry ${entry.inRegistry ? "ok" : "missing"}; probe ${entry.probe.status}${entry.probe.message ? ` (${entry.probe.message.split(/\r?\n/, 1)[0]})` : ""}`),
					];
					sendSlashText(pi, lines.join("\n"));
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
