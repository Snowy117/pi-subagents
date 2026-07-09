import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type {
	AcceptanceEvidenceKind,
	AcceptanceLedger,
	AcceptanceReport,
	AcceptanceReviewResult,
	AcceptanceRuntimeCheck,
	AcceptanceVerifyCommand,
	AcceptanceVerifyResult,
	ResolvedAcceptanceConfig,
	ResolvedAcceptanceGate,
	SingleResult,
} from "../../../shared/types.ts";
import { LEVEL_RANK, unique } from "./constants.ts";
import { isStringArray } from "./report-validate.ts";
import { parseAcceptanceReport } from "./report-parse.ts";

function checkCriteriaSatisfied(criteria: ResolvedAcceptanceGate[], report: AcceptanceReport): AcceptanceRuntimeCheck[] {
	const reports = new Map((report.criteriaSatisfied ?? []).filter((item) => item.id).map((item) => [item.id!, item]));
	return criteria.filter((criterion) => criterion.severity !== "recommended").map((criterion) => {
		const item = reports.get(criterion.id);
		if (!item) return { id: `criterion:${criterion.id}`, status: "failed", message: `Required criterion '${criterion.id}' was not reported.` };
		if (item.status !== "satisfied") return { id: `criterion:${criterion.id}`, status: "failed", message: `Required criterion '${criterion.id}' was reported as ${item.status}.` };
		return { id: `criterion:${criterion.id}`, status: "passed", message: `Required criterion '${criterion.id}' satisfied.` };
	});
}

function reportEvidencePresent(report: AcceptanceReport, kind: AcceptanceEvidenceKind): boolean {
	switch (kind) {
		case "changed-files": return isStringArray(report.changedFiles) && report.changedFiles.length > 0;
		case "tests-added": return isStringArray(report.testsAddedOrUpdated) && report.testsAddedOrUpdated.length > 0;
		case "commands-run": return Array.isArray(report.commandsRun) && report.commandsRun.length > 0;
		case "validation-output": return isStringArray(report.validationOutput) && report.validationOutput.length > 0;
		case "residual-risks": return isStringArray(report.residualRisks);
		case "no-staged-files": return report.noStagedFiles === true;
		case "diff-summary": return typeof report.diffSummary === "string" && report.diffSummary.trim().length > 0;
		case "review-findings": return isStringArray(report.reviewFindings);
		case "manual-notes": return Boolean((report.manualNotes ?? report.notes)?.trim());
	}
}

function checkNoStagedFiles(cwd: string): AcceptanceRuntimeCheck {
	const result = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		return { id: "no-staged-files", status: "not-applicable", message: "git status unavailable; no staged-files check skipped" };
	}
	const staged = result.stdout.split(/\r?\n/).filter((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?");
	return staged.length === 0
		? { id: "no-staged-files", status: "passed", message: "No staged files detected." }
		: { id: "no-staged-files", status: "failed", message: `Staged files present: ${staged.join(", ")}` };
}

function runStructuralChecks(acceptance: ResolvedAcceptanceConfig, report: AcceptanceReport, cwd: string): AcceptanceRuntimeCheck[] {
	const checks: AcceptanceRuntimeCheck[] = [];
	for (const kind of acceptance.evidence) {
		const present = reportEvidencePresent(report, kind);
		checks.push({
			id: `evidence:${kind}`,
			status: present ? "passed" : "failed",
			message: present ? `${kind} evidence present.` : `${kind} evidence missing from child report.`,
		});
	}
	if (acceptance.evidence.includes("no-staged-files")) checks.push(checkNoStagedFiles(cwd));
	return checks;
}

function trimOutput(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > 12_000 ? `${trimmed.slice(0, 12_000)}\n...[truncated]` : trimmed;
}

function uniqueStrings(items: Array<string | undefined>): string[] {
	return unique(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item)));
}

export function aggregateAcceptanceReport(input: {
	results: Array<Pick<SingleResult, "agent" | "acceptance" | "error" | "exitCode">>;
	notes?: string;
}): AcceptanceReport {
	const childReports = input.results.map((result) => result.acceptance?.childReport).filter((report): report is AcceptanceReport => Boolean(report));
	const blockers = input.results.filter((result) => result.exitCode !== 0 || result.acceptance?.status === "rejected");
	const successfulChildren = input.results.length > 0 && blockers.length === 0;
	return {
		criteriaSatisfied: [
			{ id: "criterion-1", status: successfulChildren ? "satisfied" : "not-satisfied", evidence: successfulChildren ? `All ${input.results.length} dynamic child run(s) completed without child or acceptance blockers.` : "Dynamic fanout produced no accepted child evidence." },
			{ id: "criterion-2", status: successfulChildren ? "satisfied" : "not-satisfied", evidence: successfulChildren ? "Collected child acceptance evidence for aggregate review." : "Dynamic fanout produced no aggregate review evidence." },
			...input.results.map((result, index) => ({
				id: `child-${index + 1}`,
				status: result.exitCode === 0 && result.acceptance?.status !== "rejected" ? "satisfied" : "not-satisfied",
				evidence: `${result.agent}: acceptance ${result.acceptance?.status ?? "unreported"}${result.error ? ` (${result.error})` : ""}`,
			})),
		],
		changedFiles: uniqueStrings(childReports.flatMap((report) => report.changedFiles ?? [])),
		testsAddedOrUpdated: uniqueStrings(childReports.flatMap((report) => report.testsAddedOrUpdated ?? [])),
		commandsRun: childReports.flatMap((report) => report.commandsRun ?? []),
		validationOutput: uniqueStrings(childReports.flatMap((report) => report.validationOutput ?? [])),
		residualRisks: uniqueStrings([
			...childReports.flatMap((report) => report.residualRisks ?? []),
			...blockers.map((result) => `${result.agent}: ${result.error ?? "child or acceptance gate failed"}`),
		]),
		noStagedFiles: childReports.length > 0 && childReports.every((report) => report.noStagedFiles === true),
		reviewFindings: uniqueStrings(childReports.flatMap((report) => report.reviewFindings ?? [])),
		manualNotes: input.notes ?? `Aggregated acceptance evidence from ${input.results.length} dynamic fanout child run(s).`,
		notes: input.notes,
	};
}

function runVerifyCommand(command: AcceptanceVerifyCommand, defaultCwd: string, options: { signal?: AbortSignal; abortMessage?: string } = {}): Promise<AcceptanceVerifyResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const cwd = command.cwd ? path.resolve(defaultCwd, command.cwd) : defaultCwd;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let hardKill: NodeJS.Timeout | undefined;
		const child = spawn(command.command, {
			cwd,
			env: { ...process.env, ...(command.env ?? {}) },
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const finish = (result: Omit<AcceptanceVerifyResult, "id" | "command" | "cwd" | "durationMs">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (hardKill) clearTimeout(hardKill);
			options.signal?.removeEventListener("abort", abortVerification);
			resolve({
				id: command.id,
				command: command.command,
				cwd,
				durationMs: Date.now() - startedAt,
				...result,
			});
		};
		const abortVerification = () => {
			if (settled || timedOut) return;
			timedOut = true;
			child.kill("SIGTERM");
			hardKill = setTimeout(() => {
				child.kill("SIGKILL");
				finish({
					exitCode: null,
					status: "timed-out",
					stdout: trimOutput(stdout),
					stderr: trimOutput(stderr || options.abortMessage || "Acceptance verification timed out."),
				});
			}, 1000);
			hardKill.unref?.();
		};
		const timeout = setTimeout(abortVerification, command.timeoutMs ?? 120_000);
		timeout.unref?.();
		if (options.signal?.aborted) abortVerification();
		else options.signal?.addEventListener("abort", abortVerification, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (exitCode) => {
			const passed = exitCode === 0 && !timedOut;
			finish({
				exitCode,
				status: timedOut ? "timed-out" : passed ? "passed" : command.allowFailure ? "allowed-failure" : "failed",
				stdout: trimOutput(stdout),
				stderr: trimOutput(stderr || (timedOut ? options.abortMessage ?? "" : "")),
			});
		});
		child.on("error", (error) => {
			finish({
				exitCode: timedOut ? null : 1,
				status: timedOut ? "timed-out" : command.allowFailure ? "allowed-failure" : "failed",
				stderr: timedOut ? trimOutput(stderr || options.abortMessage || "Acceptance verification timed out.") : error instanceof Error ? error.message : String(error),
			});
		});
	});
}

export async function evaluateAcceptance(input: {
	acceptance: ResolvedAcceptanceConfig;
	output: string;
	cwd: string;
	report?: AcceptanceReport;
	reviewResult?: AcceptanceReviewResult;
	signal?: AbortSignal;
	abortMessage?: string;
}): Promise<AcceptanceLedger> {
	const acceptance = input.acceptance;
	const ledger: AcceptanceLedger = {
		status: acceptance.level === "none" ? "not-required" : "claimed",
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
	if (acceptance.level === "none") return ledger;

	const parsed = input.report ? { report: input.report } : parseAcceptanceReport(input.output);
	if (parsed.report) {
		ledger.childReport = parsed.report;
		ledger.status = "attested";
	} else {
		ledger.childReportParseError = parsed.error;
		ledger.runtimeChecks.push({ id: "attestation", status: "failed", message: parsed.error ?? "Structured acceptance report missing." });
		ledger.status = "rejected";
		return ledger;
	}

	if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.checked) {
		ledger.runtimeChecks = [
			...checkCriteriaSatisfied(acceptance.criteria, parsed.report),
			...runStructuralChecks(acceptance, parsed.report, input.cwd),
		];
		if (ledger.runtimeChecks.some((check) => check.status === "failed")) {
			ledger.status = "rejected";
			return ledger;
		}
		ledger.status = "checked";
	}

	if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.verified && (acceptance.level === "verified" || acceptance.verify.length > 0)) {
		if (acceptance.level === "verified" && acceptance.verify.length === 0) {
			ledger.runtimeChecks.push({ id: "verification-config", status: "failed", message: "verified acceptance requires runtime verify commands." });
			ledger.status = "rejected";
			return ledger;
		}
		ledger.verifyRuns = [];
		for (const command of acceptance.verify) {
			ledger.verifyRuns.push(await runVerifyCommand(command, input.cwd, { signal: input.signal, abortMessage: input.abortMessage }));
			if (input.signal?.aborted) break;
		}
		if (ledger.verifyRuns.some((run) => run.status === "failed" || run.status === "timed-out")) {
			ledger.status = "rejected";
			return ledger;
		}
		ledger.status = "verified";
	}

	if (acceptance.level === "reviewed") {
		if (input.reviewResult) {
			ledger.reviewResult = input.reviewResult;
			ledger.status = input.reviewResult.status === "no-blockers" ? "reviewed" : "rejected";
		} else {
			const optionalReview = acceptance.review && acceptance.review !== false && acceptance.review.required === false;
			ledger.reviewResult = {
				status: "needs-parent-decision",
				findings: [{
					severity: acceptance.explicit && !optionalReview ? "blocker" : "non-blocking",
					issue: "Reviewed acceptance requires an independent reviewer result.",
					rationale: "The run cannot be marked reviewed from child evidence alone.",
				}],
			};
			if (acceptance.review === false || (acceptance.explicit && !optionalReview)) ledger.status = "rejected";
		}
	}

	return ledger;
}

export function acceptanceFailureMessage(ledger: AcceptanceLedger): string | undefined {
	if (ledger.status !== "rejected") return undefined;
	const failedCheck = ledger.runtimeChecks.find((check) => check.status === "failed");
	if (failedCheck) return `Acceptance rejected: ${failedCheck.message}`;
	const failedVerify = ledger.verifyRuns.find((run) => run.status === "failed" || run.status === "timed-out");
	if (failedVerify) return `Acceptance verification '${failedVerify.id}' ${failedVerify.status}.`;
	if (ledger.reviewResult?.status === "needs-parent-decision") return "Acceptance review required but no automatic reviewer result is available.";
	if (ledger.reviewResult?.status === "blockers") return "Acceptance review found blockers.";
	return "Acceptance rejected.";
}
