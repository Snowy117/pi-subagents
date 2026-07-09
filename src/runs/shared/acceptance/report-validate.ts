import type { AcceptanceReport } from "../../../shared/types.ts";

export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function pathFor(base: string, segment: string): string {
	return base ? `${base}.${segment}` : segment;
}

export function describeValidationValue(value: unknown): string {
	if (value === undefined) return "missing";
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "object") return "object";
	if (typeof value === "string") {
		const short = value.length > 80 ? `${value.slice(0, 77)}...` : value;
		return JSON.stringify(short);
	}
	return `${typeof value} ${String(value)}`;
}

export function pushTypeError(errors: string[], pathLabel: string, expected: string, value: unknown): void {
	errors.push(`${pathLabel}: expected ${expected}; got ${describeValidationValue(value)}`);
}

export function validateStringArrayField(errors: string[], value: unknown, pathLabel: string): void {
	if (!Array.isArray(value)) {
		pushTypeError(errors, pathLabel, "string[]", value);
		return;
	}
	for (const [index, item] of value.entries()) {
		if (typeof item !== "string") pushTypeError(errors, `${pathLabel}[${index}]`, "string", item);
	}
}

export function validateAcceptanceReport(value: unknown, pathLabel = ""): { report?: AcceptanceReport; errors: string[] } {
	const errors: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		pushTypeError(errors, pathLabel || "acceptance-report", "object", value);
		return { errors };
	}
	const report = value as AcceptanceReport;
	if (report.criteriaSatisfied !== undefined) {
		if (!Array.isArray(report.criteriaSatisfied)) {
			pushTypeError(errors, pathFor(pathLabel, "criteriaSatisfied"), "array", report.criteriaSatisfied);
		} else {
			for (const [index, item] of report.criteriaSatisfied.entries()) {
				const itemPath = `${pathFor(pathLabel, "criteriaSatisfied")}[${index}]`;
				if (!item || typeof item !== "object" || Array.isArray(item)) {
					pushTypeError(errors, itemPath, "object", item);
					continue;
				}
				const criterion = item as { id?: unknown; status?: unknown; evidence?: unknown };
				if (criterion.id !== undefined && typeof criterion.id !== "string") pushTypeError(errors, `${itemPath}.id`, "string", criterion.id);
				if (criterion.status !== "satisfied" && criterion.status !== "not-satisfied" && criterion.status !== "not-applicable") {
					pushTypeError(errors, `${itemPath}.status`, "one of \"satisfied\", \"not-satisfied\", \"not-applicable\"", criterion.status);
				}
				if (typeof criterion.evidence !== "string" || !criterion.evidence.trim()) pushTypeError(errors, `${itemPath}.evidence`, "non-empty string", criterion.evidence);
			}
		}
	}
	if (report.changedFiles !== undefined) validateStringArrayField(errors, report.changedFiles, pathFor(pathLabel, "changedFiles"));
	if (report.testsAddedOrUpdated !== undefined) validateStringArrayField(errors, report.testsAddedOrUpdated, pathFor(pathLabel, "testsAddedOrUpdated"));
	if (report.commandsRun !== undefined) {
		if (!Array.isArray(report.commandsRun)) {
			pushTypeError(errors, pathFor(pathLabel, "commandsRun"), "array", report.commandsRun);
		} else {
			for (const [index, item] of report.commandsRun.entries()) {
				const itemPath = `${pathFor(pathLabel, "commandsRun")}[${index}]`;
				if (!item || typeof item !== "object" || Array.isArray(item)) {
					pushTypeError(errors, itemPath, "object", item);
					continue;
				}
				const command = item as { command?: unknown; result?: unknown; summary?: unknown };
				if (typeof command.command !== "string" || !command.command.trim()) pushTypeError(errors, `${itemPath}.command`, "non-empty string", command.command);
				if (command.result !== "passed" && command.result !== "failed" && command.result !== "not-run") {
					pushTypeError(errors, `${itemPath}.result`, "one of \"passed\", \"failed\", \"not-run\"", command.result);
				}
				if (typeof command.summary !== "string") pushTypeError(errors, `${itemPath}.summary`, "string", command.summary);
			}
		}
	}
	if (report.validationOutput !== undefined) validateStringArrayField(errors, report.validationOutput, pathFor(pathLabel, "validationOutput"));
	if (report.residualRisks !== undefined) validateStringArrayField(errors, report.residualRisks, pathFor(pathLabel, "residualRisks"));
	if (report.noStagedFiles !== undefined && typeof report.noStagedFiles !== "boolean") pushTypeError(errors, pathFor(pathLabel, "noStagedFiles"), "boolean", report.noStagedFiles);
	if (report.diffSummary !== undefined && typeof report.diffSummary !== "string") pushTypeError(errors, pathFor(pathLabel, "diffSummary"), "string", report.diffSummary);
	if (report.reviewFindings !== undefined) validateStringArrayField(errors, report.reviewFindings, pathFor(pathLabel, "reviewFindings"));
	if (report.manualNotes !== undefined && typeof report.manualNotes !== "string") pushTypeError(errors, pathFor(pathLabel, "manualNotes"), "string", report.manualNotes);
	if (report.notes !== undefined && typeof report.notes !== "string") pushTypeError(errors, pathFor(pathLabel, "notes"), "string", report.notes);
	if (errors.length > 0) return { errors };
	const hasReportField = report.criteriaSatisfied !== undefined
		|| report.changedFiles !== undefined
		|| report.testsAddedOrUpdated !== undefined
		|| report.commandsRun !== undefined
		|| report.validationOutput !== undefined
		|| report.residualRisks !== undefined
		|| report.noStagedFiles !== undefined
		|| report.diffSummary !== undefined
		|| report.manualNotes !== undefined
		|| report.notes !== undefined
		|| report.reviewFindings !== undefined;
	return hasReportField
		? { report, errors }
		: { errors: [`${pathLabel || "acceptance-report"}: expected at least one acceptance report field`] };
}
