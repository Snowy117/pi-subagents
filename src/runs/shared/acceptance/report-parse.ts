import type { AcceptanceReport } from "../../../shared/types.ts";
import { isStringArray, validateAcceptanceReport } from "./report-validate.ts";

function extractBalancedJson(text: string, start: number): string | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") depth++;
		if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}

function unwrapAcceptanceReport(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const record = value as { acceptance?: unknown; "acceptance-report"?: unknown };
	if ("acceptance" in record) return record.acceptance;
	if ("acceptance-report" in record) return record["acceptance-report"];
	return value;
}

function isCommandsRunArray(value: unknown): value is NonNullable<AcceptanceReport["commandsRun"]> {
	return Array.isArray(value) && value.every((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return false;
		const command = item as { command?: unknown; result?: unknown; summary?: unknown };
		return typeof command.command === "string"
			&& (command.result === "passed" || command.result === "failed" || command.result === "not-run")
			&& typeof command.summary === "string";
	});
}

function hasGenericAcceptanceReportSignal(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return "criteriaSatisfied" in record && (
		isStringArray(record.changedFiles)
		|| isStringArray(record.testsAddedOrUpdated)
		|| isCommandsRunArray(record.commandsRun)
		|| isStringArray(record.validationOutput)
		|| isStringArray(record.residualRisks)
		|| typeof record.noStagedFiles === "boolean"
		|| typeof record.diffSummary === "string"
		|| isStringArray(record.reviewFindings)
		|| typeof record.manualNotes === "string"
	);
}

function parseReportJson(body: string): unknown {
	const trimmed = body.trim();
	try {
		return JSON.parse(trimmed) as unknown;
	} catch (error) {
		const jsonStart = trimmed.indexOf("{");
		if (jsonStart > 0) {
			const json = extractBalancedJson(trimmed, jsonStart);
			if (json) return JSON.parse(json) as unknown;
		}
		throw error;
	}
}

function fencedBlocks(output: string, tag: string): string[] {
	return [...output.matchAll(new RegExp(`\`\`\`${tag}\\s*\\n([\\s\\S]*?)\`\`\``, "gi"))]
		.map((match) => match[1]?.trim())
		.filter((value): value is string => Boolean(value));
}

function validationPathLabelForWrapper(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	const record = value as Record<string, unknown>;
	if ("acceptance" in record) return "acceptance";
	if ("acceptance-report" in record) return "acceptance-report";
	return "";
}

function parseAcceptanceReportBody(body: string): { report?: AcceptanceReport; errors: string[] } {
	const parsed = parseReportJson(body);
	const report = unwrapAcceptanceReport(parsed);
	return validateAcceptanceReport(report, validationPathLabelForWrapper(parsed));
}

function parseGenericJsonAcceptanceReportBody(body: string): AcceptanceReport | undefined {
	const parsed = parseReportJson(body);
	const report = unwrapAcceptanceReport(parsed);
	const validation = validateAcceptanceReport(report);
	if (!validation.report) return undefined;
	return hasGenericAcceptanceReportSignal(validation.report) ? validation.report : undefined;
}

export function parseAcceptanceReport(output: string): { report?: AcceptanceReport; error?: string } {
	const fenced = fencedBlocks(output, "acceptance-report");
	const parseErrors: string[] = [];
	for (const body of fenced) {
		try {
			const validation = parseAcceptanceReportBody(body);
			if (validation.report) return { report: validation.report };
			parseErrors.push(`Invalid acceptance-report: ${validation.errors.join("; ")}`);
		} catch (error) {
			parseErrors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (parseErrors.length > 0) return { error: `Failed to parse acceptance-report: ${parseErrors.join("; ")}` };
	for (const body of fencedBlocks(output, "(?:json|jsonc|json5)")) {
		try {
			const report = parseGenericJsonAcceptanceReportBody(body);
			if (report) return { report };
		} catch {
			// Ignore unrelated or malformed generic JSON fences; only explicit
			// acceptance-report fences should turn parse failures into blockers.
		}
	}
	const markerIndex = output.search(/ACCEPTANCE_REPORT\s*:/i);
	if (markerIndex !== -1) {
		const jsonStart = output.indexOf("{", markerIndex);
			if (jsonStart !== -1) {
				const json = extractBalancedJson(output, jsonStart);
				if (json) {
					try {
						const parsed = JSON.parse(json) as unknown;
						const report = unwrapAcceptanceReport(parsed);
						const validation = validateAcceptanceReport(report, validationPathLabelForWrapper(parsed));
						if (validation.report) return { report: validation.report };
						return { error: `Failed to parse acceptance-report: Invalid acceptance-report: ${validation.errors.join("; ")}` };
					} catch (error) {
						return { error: error instanceof Error ? error.message : String(error) };
					}
				}
			}
		}
	return { error: "Structured acceptance report not found." };
}

export function stripAcceptanceReport(output: string): string {
	const trailingFencePattern = /\n?```(acceptance-report|json|jsonc|json5)\s*\n([\s\S]*?)```\s*/gi;
	let trailingFence: { index: number; tag: string; body: string } | undefined;
	for (const match of output.matchAll(trailingFencePattern)) {
		const end = (match.index ?? 0) + match[0].length;
		if (output.slice(end).trim().length === 0 && match[1] && match[2]) {
			trailingFence = { index: match.index ?? 0, tag: match[1].toLowerCase(), body: match[2] };
		}
	}
	if (trailingFence) {
		if (trailingFence.tag === "acceptance-report") return output.slice(0, trailingFence.index).trimEnd();
		try {
			if (parseGenericJsonAcceptanceReportBody(trailingFence.body)) return output.slice(0, trailingFence.index).trimEnd();
		} catch {
			// Leave unrelated or malformed generic JSON fences visible.
		}
	}
	return output
		.replace(/\n?```acceptance-report\s*\n[\s\S]*?```\s*$/i, "")
		.replace(/\n?ACCEPTANCE_REPORT\s*:\s*\{[\s\S]*\}\s*$/i, "")
		.trimEnd();
}
