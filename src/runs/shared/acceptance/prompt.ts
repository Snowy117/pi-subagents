import type { ResolvedAcceptanceConfig } from "../../../shared/types.ts";

export function formatAcceptancePrompt(acceptance: ResolvedAcceptanceConfig): string {
	if (acceptance.level === "none") return "";
	const lines = [
		"",
		"## Acceptance Contract",
		`Acceptance level: ${acceptance.level}`,
		"Completion is not accepted from prose alone. End with a structured acceptance report.",
		"",
		"Criteria:",
		...(acceptance.criteria.length ? acceptance.criteria.map((criterion) => `- ${criterion.id}: ${criterion.must}`) : ["- Return the requested result."]),
		"",
		`Required evidence: ${acceptance.evidence.join(", ") || "none"}`,
	];
	if (acceptance.verify.length > 0) {
		lines.push("", "Runtime verification commands configured by parent:");
		for (const command of acceptance.verify) lines.push(`- ${command.id}: ${command.command}`);
	}
	if (acceptance.review && acceptance.review !== false) {
		lines.push("", `Review gate: ${acceptance.review.required === false ? "optional" : "required"}${acceptance.review.agent ? ` by ${acceptance.review.agent}` : ""}.`);
		if (acceptance.review.focus) lines.push(`Review focus: ${acceptance.review.focus}`);
	}
	if (acceptance.stopRules.length > 0) {
		lines.push("", "Stop rules:", ...acceptance.stopRules.map((rule) => `- ${rule}`));
	}
	lines.push(
		"",
		"Finish with a fenced JSON block tagged `acceptance-report` in this shape:",
		"Use empty arrays when no items apply; array fields contain strings unless object entries are shown.",
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "specific proof" }],
			changedFiles: ["src/file.ts"],
			testsAddedOrUpdated: ["test/file.test.ts"],
			commandsRun: [{ command: "command", result: "passed", summary: "short result" }],
			validationOutput: ["validation output or concise summary"],
			residualRisks: ["none"],
			noStagedFiles: true,
			diffSummary: "short description of the diff",
			reviewFindings: ["blocker: file.ts:12 - issue found, or no blockers"],
			manualNotes: "anything else the parent should know",
		}, null, 2),
		"```",
	);
	return lines.join("\n");
}
