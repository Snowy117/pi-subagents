import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../shared/utils.ts";
import type { SubagentProfileFile } from "./profile-types.ts";

export function readJsonObjectFile(filePath: string): Record<string, unknown> {
	const raw = fs.readFileSync(filePath, "utf-8");
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`File '${filePath}' must contain a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

export function writeJsonFile(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

const SAFE_PATH_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function normalizePathToken(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} is required.`);
	if (!SAFE_PATH_TOKEN.test(trimmed) || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
		throw new Error(`${label} must be a safe file name using only letters, numbers, dots, underscores, and hyphens.`);
	}
	return trimmed;
}

export function normalizeProfileName(name: string): string {
	const trimmed = name.trim();
	const stem = trimmed.endsWith(".json") ? trimmed.slice(0, -5) : trimmed;
	return normalizePathToken(stem, "Profile name");
}

export function normalizeProviderName(provider: string): string {
	return normalizePathToken(provider, "Provider");
}

export function validateSubagentProfile(filePath: string, parsed: Record<string, unknown>): SubagentProfileFile {
	const subagents = parsed.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) {
		throw new Error(`Profile '${filePath}' must contain a 'subagents' object.`);
	}
	const agentOverrides = (subagents as Record<string, unknown>).agentOverrides;
	if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) {
		throw new Error(`Profile '${filePath}' must contain 'subagents.agentOverrides' as an object.`);
	}
	for (const [name, value] of Object.entries(agentOverrides)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`Profile '${filePath}' has invalid override '${name}'; expected an object.`);
		}
		const model = (value as Record<string, unknown>).model;
		if (model !== undefined && typeof model !== "string") {
			throw new Error(`Profile '${filePath}' has invalid model for '${name}'; expected a string.`);
		}
	}
	return parsed as unknown as SubagentProfileFile;
}

export function getUserSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

export function readSettingsFile(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	return readJsonObjectFile(filePath);
}
