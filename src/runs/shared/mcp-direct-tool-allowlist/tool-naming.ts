import { BUILTIN_TOOL_NAMES, CACHE_MAX_AGE_MS, type McpConfig, type MetadataCache, type ServerCacheEntry, type ServerEntry, type ToolPrefix } from "./types.ts";
import { computeMcpServerHash } from "./hashing.ts";

export function resolveDirectToolNames(config: McpConfig, cache: MetadataCache, prefix: ToolPrefix, envOverride: string[]): string[] {
	const names: string[] = [];
	const seenNames = new Set<string>();
	const { servers: selectedServers, tools: selectedTools } = parseSelections(envOverride);

	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		const serverCache = cache.servers[serverName];
		if (!isServerCacheValid(serverCache, definition)) continue;

		const toolFilter = selectedServers.has(serverName)
			? true
			: selectedTools.get(serverName);
		if (!toolFilter) continue;

		for (const tool of Array.isArray(serverCache.tools) ? serverCache.tools : []) {
			if (typeof tool?.name !== "string" || !tool.name) continue;
			if (toolFilter !== true && !toolFilter.has(tool.name)) continue;
			if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) continue;
			const prefixedName = formatToolName(tool.name, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(prefixedName) || seenNames.has(prefixedName)) continue;
			seenNames.add(prefixedName);
			names.push(prefixedName);
		}

		if (definition.exposeResources === false) continue;
		for (const resource of Array.isArray(serverCache.resources) ? serverCache.resources : []) {
			if (typeof resource?.name !== "string" || !resource.name || typeof resource.uri !== "string" || !resource.uri) continue;
			const baseName = `get_${resourceNameToToolName(resource.name)}`;
			if (toolFilter !== true && !toolFilter.has(baseName)) continue;
			if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) continue;
			const prefixedName = formatToolName(baseName, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(prefixedName) || seenNames.has(prefixedName)) continue;
			seenNames.add(prefixedName);
			names.push(prefixedName);
		}
	}

	return names;
}

function parseSelections(selections: string[]): { servers: Set<string>; tools: Map<string, Set<string>> } {
	const servers = new Set<string>();
	const tools = new Map<string, Set<string>>();
	for (let item of selections) {
		item = item.replace(/\/+$/, "");
		if (item.includes("/")) {
			const [server, tool] = item.split("/", 2);
			if (server && tool) {
				if (!tools.has(server)) tools.set(server, new Set());
				tools.get(server)!.add(tool);
			} else if (server) {
				servers.add(server);
			}
		} else if (item) {
			servers.add(item);
		}
	}
	return { servers, tools };
}

function isServerCacheValid(entry: ServerCacheEntry | undefined, definition: ServerEntry): entry is ServerCacheEntry {
	if (!entry || entry.configHash !== computeMcpServerHash(definition)) return false;
	if (!entry.cachedAt || typeof entry.cachedAt !== "number") return false;
	return Date.now() - entry.cachedAt <= CACHE_MAX_AGE_MS;
}

export function getToolPrefix(value: unknown): ToolPrefix {
	return value === "none" || value === "short" || value === "server" ? value : "server";
}

function getServerPrefix(serverName: string, mode: ToolPrefix): string {
	if (mode === "none") return "";
	if (mode === "short") {
		const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
		return short || "mcp";
	}
	return serverName.replace(/-/g, "_");
}

function formatToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
	const serverPrefix = getServerPrefix(serverName, prefix);
	return serverPrefix ? `${serverPrefix}_${toolName}` : toolName;
}

function isToolExcluded(toolName: string, serverName: string, prefix: ToolPrefix, excludeTools: unknown): boolean {
	if (!Array.isArray(excludeTools) || excludeTools.length === 0) return false;
	const candidates = new Set([
		normalizeToolName(toolName),
		normalizeToolName(formatToolName(toolName, serverName, prefix)),
		normalizeToolName(formatToolName(toolName, serverName, "server")),
		normalizeToolName(formatToolName(toolName, serverName, "short")),
	]);
	return excludeTools.some((excluded) => typeof excluded === "string" && candidates.has(normalizeToolName(excluded)));
}

function normalizeToolName(value: string): string {
	return value.replace(/-/g, "_");
}

function resourceNameToToolName(name: string): string {
	let result = name
		.replace(/[^a-zA-Z0-9]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+/, "")
		.replace(/_+$/, "")
		.toLowerCase();
	if (!result || /^\d/.test(result)) result = `resource${result ? `_${result}` : ""}`;
	return result;
}
