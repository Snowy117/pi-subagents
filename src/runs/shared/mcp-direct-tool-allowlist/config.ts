import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getProjectConfigDir } from "../../../shared/utils.ts";
import { CACHE_VERSION, type ImportKind, type McpConfig, type MetadataCache, type ServerEntry } from "./types.ts";
import { getToolPrefix, resolveDirectToolNames } from "./tool-naming.ts";

const GENERIC_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "mcp", "mcp.json");
const IMPORT_PATHS = {
	cursor: [path.join(os.homedir(), ".cursor", "mcp.json")],
	"claude-code": [
		path.join(os.homedir(), ".claude", "mcp.json"),
		path.join(os.homedir(), ".claude.json"),
		path.join(os.homedir(), ".claude", "claude_desktop_config.json"),
	],
	"claude-desktop": [path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")],
	codex: [path.join(os.homedir(), ".codex", "config.json")],
	windsurf: [path.join(os.homedir(), ".windsurf", "mcp.json")],
	vscode: [".vscode/mcp.json"],
} as const;

export function resolveMcpDirectToolNames(mcpDirectTools: string[] | undefined, cwd = process.cwd()): string[] {
	if (!mcpDirectTools?.length) return [];

	try {
		const config = loadMcpConfig(cwd);
		const cache = loadMetadataCache();
		if (!cache) return [];
		return resolveDirectToolNames(config, cache, getToolPrefix(config.settings?.toolPrefix), mcpDirectTools);
	} catch {
		return [];
	}
}

function loadMetadataCache(): MetadataCache | null {
	const cachePath = path.join(getAgentDir(), "mcp-cache.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object") return null;
	const raw = parsed as Record<string, unknown>;
	if (raw.version !== CACHE_VERSION || !raw.servers || typeof raw.servers !== "object" || Array.isArray(raw.servers)) {
		return null;
	}
	return raw as unknown as MetadataCache;
}

function loadMcpConfig(cwd: string): McpConfig {
	let config: McpConfig = { mcpServers: {} };
	for (const sourcePath of getConfigPaths(cwd)) {
		const loaded = readConfig(sourcePath);
		if (!loaded) continue;
		config = mergeConfigs(config, expandImports(loaded, cwd));
	}
	return config;
}

function getConfigPaths(cwd: string): string[] {
	const piGlobalPath = path.join(getAgentDir(), "mcp.json");
	const projectPath = path.resolve(cwd, ".mcp.json");
	const projectPiPath = path.resolve(getProjectConfigDir(cwd), "mcp.json");
	const sources: string[] = [];
	if (GENERIC_GLOBAL_CONFIG_PATH !== piGlobalPath) sources.push(GENERIC_GLOBAL_CONFIG_PATH);
	sources.push(piGlobalPath);
	if (projectPath !== piGlobalPath) sources.push(projectPath);
	if (projectPiPath !== piGlobalPath && projectPiPath !== projectPath) sources.push(projectPiPath);
	return sources;
}

function readConfig(configPath: string): McpConfig | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch {
		return null;
	}
	return validateConfig(parsed);
}

function validateConfig(raw: unknown): McpConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mcpServers: {} };
	const obj = raw as Record<string, unknown>;
	const servers = obj.mcpServers ?? obj["mcp-servers"] ?? {};
	return {
		mcpServers: servers && typeof servers === "object" && !Array.isArray(servers) ? servers as Record<string, ServerEntry> : {},
		imports: Array.isArray(obj.imports) ? obj.imports.filter((value): value is ImportKind => isImportKind(value)) : undefined,
		settings: obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings)
			? obj.settings as McpConfig["settings"]
			: undefined,
	};
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
	const imports = [...(base.imports ?? []), ...(next.imports ?? [])];
	return {
		mcpServers: { ...base.mcpServers, ...next.mcpServers },
		imports: imports.length ? [...new Set(imports)] : undefined,
		settings: next.settings ? { ...base.settings, ...next.settings } : base.settings,
	};
}

function expandImports(config: McpConfig, cwd: string): McpConfig {
	if (!config.imports?.length) return config;

	const importedServers: Record<string, ServerEntry> = {};
	for (const importKind of config.imports) {
		const importPath = resolveImportPath(importKind, cwd);
		if (!importPath) continue;
		let imported: unknown;
		try {
			imported = JSON.parse(fs.readFileSync(importPath, "utf-8"));
		} catch {
			continue;
		}
		for (const [name, definition] of Object.entries(extractServers(imported, importKind))) {
			if (!importedServers[name]) importedServers[name] = definition;
		}
	}

	return {
		imports: config.imports,
		settings: config.settings,
		mcpServers: { ...importedServers, ...config.mcpServers },
	};
}

function resolveImportPath(importKind: ImportKind, cwd: string): string | null {
	for (const candidate of IMPORT_PATHS[importKind]) {
		const fullPath = candidate.startsWith(".") ? path.resolve(cwd, candidate) : candidate;
		if (fs.existsSync(fullPath)) return fullPath;
	}
	return null;
}

function extractServers(config: unknown, kind: ImportKind): Record<string, ServerEntry> {
	if (!config || typeof config !== "object" || Array.isArray(config)) return {};
	const obj = config as Record<string, unknown>;
	const servers = kind === "cursor" || kind === "windsurf" || kind === "vscode"
		? obj.mcpServers ?? obj["mcp-servers"]
		: obj.mcpServers;
	return servers && typeof servers === "object" && !Array.isArray(servers) ? servers as Record<string, ServerEntry> : {};
}

function isImportKind(value: unknown): value is ImportKind {
	return typeof value === "string" && Object.hasOwn(IMPORT_PATHS, value);
}
