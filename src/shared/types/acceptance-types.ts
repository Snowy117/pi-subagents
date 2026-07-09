/**
 * Acceptance-gate types: levels, evidence, gates, config, reports, and ledgers.
 */

export type AcceptanceLevel = "auto" | "none" | "attested" | "checked" | "verified" | "reviewed";

export type AcceptanceEvidenceKind =
	| "changed-files"
	| "tests-added"
	| "commands-run"
	| "validation-output"
	| "residual-risks"
	| "no-staged-files"
	| "diff-summary"
	| "review-findings"
	| "manual-notes";

export interface AcceptanceGate {
	id: string;
	must: string;
	evidence?: AcceptanceEvidenceKind[];
	severity?: "required" | "recommended";
}

export interface AcceptanceVerifyCommand {
	id: string;
	command: string;
	timeoutMs?: number;
	cwd?: string;
	env?: Record<string, string>;
	allowFailure?: boolean;
}

export interface AcceptanceReviewGate {
	agent?: string;
	focus?: string;
	required?: boolean;
}

export interface AcceptanceConfig {
	level?: AcceptanceLevel;
	criteria?: Array<string | AcceptanceGate>;
	evidence?: AcceptanceEvidenceKind[];
	verify?: AcceptanceVerifyCommand[];
	review?: AcceptanceReviewGate | false;
	stopRules?: string[];
	reason?: string;
}

export type AcceptanceInput = AcceptanceLevel | false | AcceptanceConfig;

export interface ResolvedAcceptanceGate extends AcceptanceGate {
	id: string;
	must: string;
	evidence: AcceptanceEvidenceKind[];
	severity: "required" | "recommended";
}

export interface ResolvedAcceptanceConfig {
	level: Exclude<AcceptanceLevel, "auto">;
	explicit: boolean;
	inferredReason: string[];
	criteria: ResolvedAcceptanceGate[];
	evidence: AcceptanceEvidenceKind[];
	verify: AcceptanceVerifyCommand[];
	review?: AcceptanceReviewGate | false;
	stopRules: string[];
	reason?: string;
}

export interface AcceptanceReport {
	criteriaSatisfied?: Array<{
		id?: string;
		status: "satisfied" | "not-satisfied" | "not-applicable";
		evidence: string;
	}>;
	changedFiles?: string[];
	testsAddedOrUpdated?: string[];
	commandsRun?: Array<{
		command: string;
		result: "passed" | "failed" | "not-run";
		summary: string;
	}>;
	validationOutput?: string[];
	residualRisks?: string[];
	noStagedFiles?: boolean;
	diffSummary?: string;
	reviewFindings?: string[];
	manualNotes?: string;
	notes?: string;
}

export type AcceptanceRuntimeCheckStatus = "passed" | "failed" | "not-applicable";

export interface AcceptanceRuntimeCheck {
	id: string;
	status: AcceptanceRuntimeCheckStatus;
	message: string;
}

export interface AcceptanceVerifyResult {
	id: string;
	command: string;
	cwd?: string;
	exitCode: number | null;
	status: "passed" | "failed" | "timed-out" | "allowed-failure";
	stdout?: string;
	stderr?: string;
	durationMs: number;
}

export interface AcceptanceReviewResult {
	status: "no-blockers" | "blockers" | "needs-parent-decision";
	findings: Array<{
		severity: "blocker" | "non-blocking";
		file?: string;
		issue: string;
		rationale: string;
	}>;
}

export type AcceptanceLedgerStatus =
	| "not-required"
	| "claimed"
	| "attested"
	| "checked"
	| "verified"
	| "reviewed"
	| "accepted"
	| "rejected";

export interface AcceptanceLedger {
	status: AcceptanceLedgerStatus;
	explicit: boolean;
	effectiveAcceptance: ResolvedAcceptanceConfig;
	inferredReason: string[];
	criteria: ResolvedAcceptanceGate[];
	childReport?: AcceptanceReport;
	childReportParseError?: string;
	runtimeChecks: AcceptanceRuntimeCheck[];
	verifyRuns: AcceptanceVerifyResult[];
	reviewResult?: AcceptanceReviewResult;
	parentDecision?: {
		status: "accepted" | "rejected";
		at: string;
		reason?: string;
	};
}
