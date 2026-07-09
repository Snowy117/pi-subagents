import type {
	AcceptanceEvidenceKind,
	AcceptanceInput,
	ResolvedAcceptanceConfig,
	SubagentRunMode,
} from "../../../shared/types.ts";
import {
	LEVEL_RANK,
	explicitAcceptanceCanDisable,
	inferLevel,
	normalizeCriteria,
	normalizeLevel,
	requiredEvidenceForLevel,
	unique,
} from "./constants.ts";
import { normalizeAcceptanceInput } from "./config.ts";

export function resolveEffectiveAcceptance(input: {
	explicit?: AcceptanceInput;
	agentName: string;
	task?: string;
	mode?: SubagentRunMode;
	async?: boolean;
	dynamic?: boolean;
	dynamicGroup?: boolean;
}): ResolvedAcceptanceConfig {
	const explicit = normalizeAcceptanceInput(input.explicit);
	const inferred = inferLevel(input);
	const explicitLevel = normalizeLevel(explicit.level);
	const level = explicitAcceptanceCanDisable(explicit)
		? "none"
		: explicitLevel === "auto"
			? inferred.level
			: (LEVEL_RANK[explicitLevel] >= LEVEL_RANK[inferred.level] ? explicitLevel : inferred.level);
	const evidence = unique([...(level === inferred.level ? inferred.evidence : requiredEvidenceForLevel(level)), ...(explicit.evidence ?? [])]);
	const criteria = normalizeCriteria(
		(explicit.criteria?.length ? explicit.criteria : inferred.criteria) as Array<string | { id?: string; must?: string; evidence?: AcceptanceEvidenceKind[]; severity?: "required" | "recommended" }>,
		evidence,
	);
	let review = explicit.review !== undefined ? explicit.review : inferred.review;
	if (level === "reviewed" && explicitLevel !== "auto" && explicitLevel !== "reviewed" && explicit.review === undefined && review && review !== false) {
		review = { ...review, required: false };
	}
	return {
		level,
		explicit: input.explicit !== undefined,
		inferredReason: inferred.reasons,
		criteria,
		evidence,
		verify: explicit.verify ?? [],
		review,
		stopRules: explicit.stopRules ?? [],
		reason: explicit.reason,
	};
}
