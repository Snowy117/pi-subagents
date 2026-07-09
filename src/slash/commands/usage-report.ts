import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "../../shared/formatters.ts";
import { resolveSlashMessageDetails } from "../slash-live-state.ts";
import {
	SLASH_RESULT_TYPE,
	type Details,
	type Usage,
} from "../../shared/types.ts";

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function addUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function usageHasValue(usage: Usage): boolean {
	return usage.input !== 0 || usage.output !== 0 || usage.cacheRead !== 0 || usage.cacheWrite !== 0 || usage.cost !== 0 || usage.turns !== 0;
}

function assistantUsageFromMessage(message: unknown): Usage | undefined {
	if (!message || typeof message !== "object") return undefined;
	const msg = message as { role?: unknown; usage?: unknown };
	if (msg.role !== "assistant" || !msg.usage || typeof msg.usage !== "object") return undefined;
	const usage = msg.usage as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		cost?: { total?: unknown };
	};
	return {
		input: typeof usage.input === "number" ? usage.input : 0,
		output: typeof usage.output === "number" ? usage.output : 0,
		cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
		cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
		cost: typeof usage.cost?.total === "number" ? usage.cost.total : 0,
		turns: 1,
	};
}

function isSubagentDetails(value: unknown): value is Details {
	if (!value || typeof value !== "object") return false;
	const details = value as { mode?: unknown; results?: unknown };
	return typeof details.mode === "string" && Array.isArray(details.results);
}

function detailsFromSessionEntry(entry: unknown): Details | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as { type?: unknown; customType?: unknown; details?: unknown; message?: unknown };
	if (record.type === "custom_message" && record.customType === SLASH_RESULT_TYPE) {
		const details = resolveSlashMessageDetails(record.details)?.result.details;
		return isSubagentDetails(details) ? details : undefined;
	}
	if (record.type !== "message" || !record.message || typeof record.message !== "object") return undefined;
	const message = record.message as { role?: unknown; toolName?: unknown; details?: unknown };
	if (message.role !== "toolResult" || message.toolName !== "subagent") return undefined;
	return isSubagentDetails(message.details) ? message.details : undefined;
}

function formatCostUsage(label: string, usage: Usage): string {
	const extras = [
		usage.cacheRead ? `cache read ${formatTokens(usage.cacheRead)}` : "",
		usage.cacheWrite ? `cache write ${formatTokens(usage.cacheWrite)}` : "",
		usage.turns ? `${usage.turns} turn${usage.turns === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	return `${label}: ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} $${usage.cost.toFixed(4)}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

export function buildSubagentCostReport(ctx: ExtensionContext): string {
	const parent = emptyUsage();
	const childTotal = emptyUsage();
	const total = emptyUsage();
	const children: Array<{ label: string; usage: Usage; sessionFile?: string }> = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		const message = entry.type === "message" ? (entry as { message?: unknown }).message : undefined;
		const parentUsage = assistantUsageFromMessage(message);
		if (parentUsage) addUsage(parent, parentUsage);
		const details = detailsFromSessionEntry(entry);
		if (!details) continue;
		for (const result of details.results) {
			if (!usageHasValue(result.usage)) continue;
			const usage = { ...result.usage };
			children.push({
				label: `Child ${children.length + 1} (${result.agent})`,
				usage,
				...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
			});
			addUsage(childTotal, usage);
		}
	}
	addUsage(total, parent);
	addUsage(total, childTotal);
	const lines = [
		"Subagent cost",
		"",
		formatCostUsage("Parent", parent),
	];
	if (children.length === 0) {
		lines.push("No subagent child usage found in this session.");
	} else {
		for (const child of children) {
			lines.push(formatCostUsage(child.label, child.usage));
			if (child.sessionFile) lines.push(`  Session: ${child.sessionFile}`);
		}
	}
	lines.push("────────────────────────────", formatCostUsage("Children", childTotal), formatCostUsage("Total", total));
	return lines.join("\n");
}
