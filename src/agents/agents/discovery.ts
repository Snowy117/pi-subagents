/**
 * Top-level agent and chain discovery orchestration.
 *
 * Builds the effective agent/chain set for a scope by combining builtin,
 * package, user, and project sources with settings-driven overrides and
 * default-model assignment.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../../shared/utils.ts";
import { mergeAgentsForScope } from "../agent-selection.ts";
import { EMPTY_SUBAGENT_SETTINGS } from "./types.ts";
import type { AgentConfig, AgentDiscoveryResult, AgentScope, ChainConfig, ChainDiscoveryDiagnostic } from "./types.ts";
import { getProjectAgentSettingsPath, getUserAgentSettingsPath, readSubagentSettings } from "./overrides/settings.ts";
import { applyBuiltinOverrides, applyCustomAgentOverrides, applySubagentDefaultModel, resolveSubagentDefaultModel } from "./overrides/apply.ts";
import { collectPackageSubagentPaths } from "./package-discovery.ts";
import { loadAgentsFromDir, loadChainsFromDir, resolveNearestProjectAgentDirs, resolveNearestProjectChainDirs } from "./loading.ts";

function getUserChainDir(): string {
	return path.join(getAgentDir(), "chains");
}

const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "agents");

export const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

// Additional read-only directories to scan for agent definitions, supplied by the
// launcher via PI_SUBAGENT_EXTRA_AGENT_DIRS (PATH-style, split on os/path delimiter).
// Lets a hermetic wrapper (e.g. a Nix-store install) expose bundled agents without
// copying or symlinking them into the writable agent dir. Loaded as "user" source,
// at lower precedence than agents the user placed in their own agent dir.
function extraUserAgentDirs(): string[] {
	const raw = process.env[EXTRA_AGENT_DIRS_ENV];
	if (!raw) return [];
	return raw
		.split(path.delimiter)
		.map((dir) => dir.trim())
		.filter((dir) => dir.length > 0);
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDirOld = path.join(getAgentDir(), "agents");
	const userDirNew = path.join(os.homedir(), ".agents");
	const { readDirs: projectAgentDirs, preferredDir: projectAgentsDir } = resolveNearestProjectAgentDirs(cwd);
	const userSettingsPath = getUserAgentSettingsPath();
	const projectSettingsPath = getProjectAgentSettingsPath(cwd);
	const userSettings = scope === "project" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(userSettingsPath);
	const projectSettings = scope === "user" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(projectSettingsPath);
	const defaultModel = resolveSubagentDefaultModel(userSettings, projectSettings, userSettingsPath, projectSettingsPath);
	const modelScope = projectSettings.modelScope ?? userSettings.modelScope;
	const packageSubagentPaths = collectPackageSubagentPaths(cwd, {
		includeUser: scope !== "project",
		includeProject: scope !== "user",
	});

	const builtinAgents = applyBuiltinOverrides(
		applySubagentDefaultModel(loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"), defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const userAgentsExtra = scope === "project" ? [] : extraUserAgentDirs().flatMap((dir) => loadAgentsFromDir(dir, "user"));
	const userAgentsOld = scope === "project" ? [] : loadAgentsFromDir(userDirOld, "user");
	const userAgentsNew = scope === "project" ? [] : loadAgentsFromDir(userDirNew, "user");
	const userAgents = applyCustomAgentOverrides(
		applySubagentDefaultModel([...userAgentsExtra, ...userAgentsOld, ...userAgentsNew], defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const projectAgents = applyCustomAgentOverrides(
		applySubagentDefaultModel(scope === "user" ? [] : projectAgentDirs.flatMap((dir) => loadAgentsFromDir(dir, "project")), defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const packageAgents = applyCustomAgentOverrides(
		applySubagentDefaultModel(packageSubagentPaths.agents.flatMap((dir) => loadAgentsFromDir(dir, "package")), defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const agents = mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents, packageAgents)
		.filter((agent) => agent.disabled !== true);

	return { agents, projectAgentsDir, modelScope };
}

export function discoverAgentsAll(cwd: string): {
	builtin: AgentConfig[];
	package: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	chains: ChainConfig[];
	chainDiagnostics: ChainDiscoveryDiagnostic[];
	userDir: string;
	projectDir: string | null;
	userChainDir: string;
	projectChainDir: string | null;
	userSettingsPath: string;
	projectSettingsPath: string | null;
} {
	const userDirOld = path.join(getAgentDir(), "agents");
	const userDirNew = path.join(os.homedir(), ".agents");
	const userChainDir = getUserChainDir();
	const { readDirs: projectDirs, preferredDir: projectDir } = resolveNearestProjectAgentDirs(cwd);
	const { readDirs: projectChainDirs, preferredDir: projectChainDir } = resolveNearestProjectChainDirs(cwd);
	const userSettingsPath = getUserAgentSettingsPath();
	const projectSettingsPath = getProjectAgentSettingsPath(cwd);
	const userSettings = readSubagentSettings(userSettingsPath);
	const projectSettings = readSubagentSettings(projectSettingsPath);
	const defaultModel = resolveSubagentDefaultModel(userSettings, projectSettings, userSettingsPath, projectSettingsPath);
	const packageSubagentPaths = collectPackageSubagentPaths(cwd);

	const builtin = applyBuiltinOverrides(
		applySubagentDefaultModel(loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"), defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const user = applyCustomAgentOverrides(
		applySubagentDefaultModel([
			...extraUserAgentDirs().flatMap((dir) => loadAgentsFromDir(dir, "user")),
			...loadAgentsFromDir(userDirOld, "user"),
			...loadAgentsFromDir(userDirNew, "user"),
		], defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const packageMap = new Map<string, AgentConfig>();
	for (const dir of packageSubagentPaths.agents) {
		for (const agent of loadAgentsFromDir(dir, "package")) {
			if (!packageMap.has(agent.name)) packageMap.set(agent.name, agent);
		}
	}
	const packageAgents = applyCustomAgentOverrides(
		applySubagentDefaultModel(Array.from(packageMap.values()), defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const projectMap = new Map<string, AgentConfig>();
	for (const dir of projectDirs) {
		for (const agent of loadAgentsFromDir(dir, "project")) {
			projectMap.set(agent.name, agent);
		}
	}
	const project = applyCustomAgentOverrides(
		applySubagentDefaultModel(Array.from(projectMap.values()), defaultModel),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const chainMap = new Map<string, ChainConfig>();
	const packageChainDiagnostics: ChainDiscoveryDiagnostic[] = [];
	const packageChainMap = new Map<string, ChainConfig>();
	for (const dir of packageSubagentPaths.chains) {
		const loaded = loadChainsFromDir(dir, "package");
		packageChainDiagnostics.push(...loaded.diagnostics);
		for (const chain of loaded.chains) {
			if (!packageChainMap.has(chain.name)) packageChainMap.set(chain.name, chain);
		}
	}
	const projectChainDiagnostics: ChainDiscoveryDiagnostic[] = [];
	for (const dir of projectChainDirs) {
		const loaded = loadChainsFromDir(dir, "project");
		projectChainDiagnostics.push(...loaded.diagnostics);
		for (const chain of loaded.chains) {
			chainMap.set(chain.name, chain);
		}
	}
	const userChains = loadChainsFromDir(userChainDir, "user");
	const chains = [
		...Array.from(packageChainMap.values()),
		...userChains.chains,
		...Array.from(chainMap.values()),
	];
	const chainDiagnostics = [
		...packageChainDiagnostics,
		...userChains.diagnostics,
		...projectChainDiagnostics,
	];

	const userDir = process.env.PI_CODING_AGENT_DIR ? userDirOld : fs.existsSync(userDirNew) ? userDirNew : userDirOld;

	return { builtin, package: packageAgents, user, project, chains, chainDiagnostics, userDir, projectDir, userChainDir, projectChainDir, userSettingsPath, projectSettingsPath };
}
