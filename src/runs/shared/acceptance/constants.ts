import type {
	AcceptanceConfig,
	AcceptanceEvidenceKind,
	AcceptanceLevel,
	ResolvedAcceptanceGate,
	SubagentRunMode,
} from "../../../shared/types.ts";

export const LEVEL_RANK: Record<Exclude<AcceptanceLevel, "auto">, number> = {
	none: 0,
	attested: 1,
	checked: 2,
	verified: 3,
	reviewed: 4,
};

export const VALID_LEVELS = new Set<AcceptanceLevel>(["auto", "none", "attested", "checked", "verified", "reviewed"]);
export const VALID_EVIDENCE = new Set<AcceptanceEvidenceKind>([
	"changed-files",
	"tests-added",
	"commands-run",
	"validation-output",
	"residual-risks",
	"no-staged-files",
	"diff-summary",
	"review-findings",
	"manual-notes",
]);
export const ACCEPTANCE_CONFIG_KEYS = new Set(["level", "criteria", "evidence", "verify", "review", "stopRules", "reason"]);
export const ACCEPTANCE_GATE_KEYS = new Set(["id", "must", "evidence", "severity"]);
export const ACCEPTANCE_VERIFY_KEYS = new Set(["id", "command", "timeoutMs", "cwd", "env", "allowFailure"]);
export const ACCEPTANCE_REVIEW_KEYS = new Set(["agent", "focus", "required"]);

export function normalizeLevel(level: AcceptanceLevel | undefined): Exclude<AcceptanceLevel, "auto"> | "auto" {
	return level ?? "auto";
}

export function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

export function requiredEvidenceForLevel(level: Exclude<AcceptanceLevel, "auto">): AcceptanceEvidenceKind[] {
	switch (level) {
		case "none":
			return [];
		case "attested":
			return ["manual-notes", "residual-risks"];
		case "checked":
			return ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"];
		case "verified":
		case "reviewed":
			return ["changed-files", "tests-added", "commands-run", "validation-output", "residual-risks", "no-staged-files"];
	}
}

export function inferLevel(input: {
	agentName: string;
	task?: string;
	mode?: SubagentRunMode;
	async?: boolean;
	dynamic?: boolean;
	dynamicGroup?: boolean;
}): { level: Exclude<AcceptanceLevel, "auto">; reasons: string[]; criteria: string[]; evidence: AcceptanceEvidenceKind[]; review?: { agent?: string; required?: boolean } } {
	const agent = input.agentName.toLowerCase();
	const task = input.task?.toLowerCase() ?? "";
	const reasons: string[] = [];
	const readOnlyAgent = /\b(?:reviewer|scout|context-builder|researcher|analyst)\b/.test(agent);
	const readOnlyTask = /\b(?:read[- ]only|review[- ]only|do not edit|don't edit|no edits|without edits|inspect|summari[sz]e)\b/.test(task);
	const writeTask = /\b(?:fix|implement|update|write|edit|modify|migrate|release|security|delete|remove|refactor|commit)\b/.test(task)
		|| /\bworker\b/.test(agent);
	const risky = Boolean(input.async && writeTask)
		|| Boolean(input.dynamic)
		|| Boolean(input.dynamicGroup)
		|| /\b(?:release|migration|migrate|security|data[- ]loss|destructive|post-review|fix pass)\b/.test(task);

	if (risky) {
		reasons.push(input.async ? "async write-capable or risky run" : "risky write-capable run");
		if (input.dynamic || input.dynamicGroup) reasons.push("dynamic fanout context");
		return {
			level: "reviewed",
			reasons,
			criteria: ["Implement the requested change without widening scope", "Return evidence sufficient for an independent acceptance review"],
			evidence: requiredEvidenceForLevel("reviewed"),
			review: { agent: "reviewer", required: true },
		};
	}
	if (writeTask && !readOnlyTask) {
		reasons.push("write-capable worker/task");
		return {
			level: "checked",
			reasons,
			criteria: ["Implement the requested change without widening scope"],
			evidence: requiredEvidenceForLevel("checked"),
		};
	}
	if (readOnlyAgent || readOnlyTask) {
		reasons.push(readOnlyAgent ? "read-only/reviewer-style agent" : "read-only task wording");
		return {
			level: "attested",
			reasons,
			criteria: ["Return concrete findings with file paths and severity when applicable"],
			evidence: ["review-findings", "residual-risks"],
		};
	}
	reasons.push("default lightweight attestation");
	return {
		level: "attested",
		reasons,
		criteria: ["Return a concise result and residual risks when applicable"],
		evidence: ["manual-notes", "residual-risks"],
	};
}

export function normalizeCriteria(criteria: Array<string | { id?: string; must?: string; evidence?: AcceptanceEvidenceKind[]; severity?: "required" | "recommended" }> | undefined, evidence: AcceptanceEvidenceKind[]): ResolvedAcceptanceGate[] {
	return (criteria ?? []).map((criterion, index) => {
		if (typeof criterion === "string") {
			return { id: `criterion-${index + 1}`, must: criterion, evidence, severity: "required" };
		}
		return {
			id: criterion.id?.trim() || `criterion-${index + 1}`,
			must: criterion.must ?? "",
			evidence: criterion.evidence?.filter((item) => VALID_EVIDENCE.has(item)) ?? evidence,
			severity: criterion.severity ?? "required",
		};
	}).filter((criterion) => criterion.must.trim());
}

export function explicitAcceptanceCanDisable(explicit: AcceptanceConfig): boolean {
	return explicit.level === "none" && typeof explicit.reason === "string" && explicit.reason.trim().length > 0;
}
