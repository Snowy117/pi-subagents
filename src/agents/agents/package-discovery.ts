/**
 * Installed-package and settings package discovery for subagent paths.
 *
 * Resolves agent/chain directories declared by npm/git/file packages and
 * settings.json `packages` entries. Opportunistic: malformed third-party
 * manifests never break local discovery.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getProjectConfigDir } from "../../shared/utils.ts";
import { findNearestProjectRoot } from "./project-root.ts";

interface PackageSubagentPaths {
	agents: string[];
	chains: string[];
}

let cachedGlobalNpmRoot: string | null = null;

function readJsonFileBestEffort(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		// Installed package scans are opportunistic; bad third-party manifests
		// should not break local agent discovery.
		return null;
	}
}

function readOptionalJsonFile(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as { code?: unknown }).code
			: undefined;
		if (code === "ENOENT") return null;
		throw error;
	}
}

function isSafePackagePath(value: string): boolean {
	return value.length > 0
		&& !path.isAbsolute(value)
		&& value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..");
}

function parseNpmPackageName(source: string): string | undefined {
	const spec = source.slice(4).trim();
	if (!spec) return undefined;
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	const packageName = match?.[1] ?? spec;
	return isSafePackagePath(packageName) ? packageName : undefined;
}

function stripGitRef(repoPath: string): string {
	const atIndex = repoPath.indexOf("@");
	const hashIndex = repoPath.indexOf("#");
	const refIndex = [atIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
	return refIndex === undefined ? repoPath : repoPath.slice(0, refIndex);
}

function parseGitPackagePath(source: string): { host: string; repoPath: string } | undefined {
	const spec = source.slice(4).trim();
	if (!spec) return undefined;

	let host = "";
	let repoPath = "";
	const scpLike = spec.match(/^git@([^:]+):(.+)$/);
	if (scpLike) {
		host = scpLike[1] ?? "";
		repoPath = scpLike[2] ?? "";
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) {
		try {
			const url = new URL(spec);
			host = url.hostname;
			repoPath = url.pathname.replace(/^\/+/, "");
		} catch {
			return undefined;
		}
	} else {
		const slashIndex = spec.indexOf("/");
		if (slashIndex < 0) return undefined;
		host = spec.slice(0, slashIndex);
		repoPath = spec.slice(slashIndex + 1);
	}

	const normalizedPath = stripGitRef(repoPath).replace(/\.git$/, "").replace(/^\/+/, "");
	if (!host || !isSafePackagePath(host) || !isSafePackagePath(normalizedPath) || normalizedPath.split(/[\\/]/).length < 2) {
		return undefined;
	}
	return { host, repoPath: normalizedPath };
}

function resolveSettingsPackageRoot(source: string, baseDir: string): string | undefined {
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("git:")) {
		const parsed = parseGitPackagePath(trimmed);
		return parsed ? path.join(baseDir, "git", parsed.host, parsed.repoPath) : undefined;
	}
	if (trimmed.startsWith("npm:")) {
		const packageName = parseNpmPackageName(trimmed);
		return packageName ? path.join(baseDir, "npm", "node_modules", packageName) : undefined;
	}
	const normalized = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return path.join(os.homedir(), normalized.slice(2));
	if (path.isAbsolute(normalized)) return normalized;
	if (normalized === "." || normalized === ".." || normalized.startsWith("./") || normalized.startsWith("../")) {
		return path.resolve(baseDir, normalized);
	}
	return undefined;
}

function getGlobalNpmRoot(): string | null {
	if (cachedGlobalNpmRoot !== null) return cachedGlobalNpmRoot;
	try {
		cachedGlobalNpmRoot = fs.realpathSync(execSync("npm root -g", { encoding: "utf-8", timeout: 5000 }).trim());
		return cachedGlobalNpmRoot;
	} catch {
		cachedGlobalNpmRoot = "";
		return null;
	}
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function extractSubagentPathsFromPackageRoot(packageRoot: string): PackageSubagentPaths {
	const packageJsonPath = path.join(packageRoot, "package.json");
	const pkg = readJsonFileBestEffort(packageJsonPath);
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return { agents: [], chains: [] };

	const roots: Record<string, unknown>[] = [];
	const piSubagents = (pkg as { "pi-subagents"?: unknown })["pi-subagents"];
	if (piSubagents && typeof piSubagents === "object" && !Array.isArray(piSubagents)) {
		roots.push(piSubagents as Record<string, unknown>);
	}

	const pi = (pkg as { pi?: unknown }).pi;
	if (pi && typeof pi === "object" && !Array.isArray(pi)) {
		const subagents = (pi as { subagents?: unknown }).subagents;
		if (subagents && typeof subagents === "object" && !Array.isArray(subagents)) {
			roots.push(subagents as Record<string, unknown>);
		}
	}

	const agents: string[] = [];
	const chains: string[] = [];
	for (const root of roots) {
		for (const entry of stringArray(root.agents)) agents.push(path.resolve(packageRoot, entry));
		for (const entry of stringArray(root.chains)) chains.push(path.resolve(packageRoot, entry));
	}
	return { agents, chains };
}

function collectPackageRootsFromNodeModules(nodeModulesDir: string): string[] {
	const roots: string[] = [];
	if (!fs.existsSync(nodeModulesDir)) return roots;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
	} catch {
		return roots;
	}

	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

		if (entry.name.startsWith("@")) {
			const scopeDir = path.join(nodeModulesDir, entry.name);
			let scopeEntries: fs.Dirent[];
			try {
				scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const scopeEntry of scopeEntries) {
				if (scopeEntry.name.startsWith(".")) continue;
				if (!scopeEntry.isDirectory() && !scopeEntry.isSymbolicLink()) continue;
				roots.push(path.join(scopeDir, scopeEntry.name));
			}
			continue;
		}

		roots.push(path.join(nodeModulesDir, entry.name));
	}
	return roots;
}

function collectSettingsPackageRoots(settingsFile: string, baseDir: string): string[] {
	const settings = readOptionalJsonFile(settingsFile);
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [];
	const packages = (settings as { packages?: unknown }).packages;
	if (!Array.isArray(packages)) return [];

	const roots: string[] = [];
	for (const entry of packages) {
		const packageSource = typeof entry === "string"
			? entry
			: typeof entry === "object" && entry !== null && typeof (entry as { source?: unknown }).source === "string"
				? (entry as { source: string }).source
				: undefined;
		if (!packageSource) continue;
		const packageRoot = resolveSettingsPackageRoot(packageSource, baseDir);
		if (packageRoot) roots.push(packageRoot);
	}
	return roots;
}

export function collectPackageSubagentPaths(cwd: string, options: { includeUser: boolean; includeProject: boolean } = { includeUser: true, includeProject: true }): PackageSubagentPaths {
	const agentDir = getAgentDir();
	const projectRoot = findNearestProjectRoot(cwd) ?? cwd;
	const packageRoots = [
		projectRoot,
	];

	if (options.includeProject) {
		const projectConfigDir = getProjectConfigDir(projectRoot);
		packageRoots.push(
			...collectPackageRootsFromNodeModules(path.join(projectConfigDir, "npm", "node_modules")),
			...collectSettingsPackageRoots(path.join(projectConfigDir, "settings.json"), projectConfigDir),
		);
	}

	if (options.includeUser) {
		packageRoots.push(
			...collectPackageRootsFromNodeModules(path.join(agentDir, "npm", "node_modules")),
			...collectSettingsPackageRoots(path.join(agentDir, "settings.json"), agentDir),
		);
	}

	if (options.includeUser) {
		const globalRoot = getGlobalNpmRoot();
		if (globalRoot) packageRoots.push(...collectPackageRootsFromNodeModules(globalRoot));
	}

	const seenRoots = new Set<string>();
	const seenAgents = new Set<string>();
	const seenChains = new Set<string>();
	const agents: string[] = [];
	const chains: string[] = [];
	for (const packageRoot of packageRoots) {
		const resolvedRoot = path.resolve(packageRoot);
		if (seenRoots.has(resolvedRoot)) continue;
		seenRoots.add(resolvedRoot);
		const paths = extractSubagentPathsFromPackageRoot(resolvedRoot);
		for (const agentDir of paths.agents) {
			if (seenAgents.has(agentDir)) continue;
			seenAgents.add(agentDir);
			agents.push(agentDir);
		}
		for (const chainDir of paths.chains) {
			if (seenChains.has(chainDir)) continue;
			seenChains.add(chainDir);
			chains.push(chainDir);
		}
	}
	return { agents, chains };
}
