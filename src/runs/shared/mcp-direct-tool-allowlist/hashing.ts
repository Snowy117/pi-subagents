import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerEntry } from "./types.ts";

export function computeMcpServerHash(definition: ServerEntry): string {
	const identity: Record<string, unknown> = {
		command: definition.command,
		args: definition.args,
		env: interpolateEnvRecord(definition.env),
		cwd: resolveConfigPath(definition.cwd),
		url: definition.url,
		headers: interpolateEnvRecord(definition.headers),
		auth: definition.auth,
		bearerToken: resolveBearerToken(definition),
		bearerTokenEnv: definition.bearerTokenEnv,
		exposeResources: definition.exposeResources,
		excludeTools: definition.excludeTools,
	};
	return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

function interpolateEnvRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		if (typeof value === "string") resolved[key] = interpolateEnvVars(value);
	}
	return resolved;
}

function interpolateEnvVars(value: string): string {
	return value
		.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "")
		.replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? "");
}

function resolveConfigPath(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const resolved = interpolateEnvVars(value);
	if (resolved === "~") return os.homedir();
	if (resolved.startsWith("~/") || resolved.startsWith("~\\")) return path.join(os.homedir(), resolved.slice(2));
	return resolved;
}

function resolveBearerToken(definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">): string | undefined {
	if (typeof definition.bearerToken === "string") return interpolateEnvVars(definition.bearerToken);
	return typeof definition.bearerTokenEnv === "string" ? process.env[definition.bearerTokenEnv] : undefined;
}

function stableStringify(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? "undefined" : serialized;
	}
	if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}
