export const CACHE_VERSION = 1;
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);

export type ToolPrefix = "server" | "none" | "short";

export interface ServerEntry {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: "oauth" | "bearer" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
	exposeResources?: boolean;
	excludeTools?: string[];
	directTools?: boolean | string[];
}

export interface McpConfig {
	mcpServers: Record<string, ServerEntry>;
	imports?: ImportKind[];
	settings?: {
		toolPrefix?: ToolPrefix;
		directTools?: boolean;
	};
}

export interface CachedTool {
	name?: string;
}

export interface CachedResource {
	uri?: string;
	name?: string;
}

export interface ServerCacheEntry {
	configHash?: string;
	tools?: CachedTool[];
	resources?: CachedResource[];
	cachedAt?: number;
}

export interface MetadataCache {
	version: number;
	servers: Record<string, ServerCacheEntry>;
}

export type ImportKind = "cursor" | "claude-code" | "claude-desktop" | "codex" | "windsurf" | "vscode";
