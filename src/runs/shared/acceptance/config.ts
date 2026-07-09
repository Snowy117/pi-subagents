import type {
	AcceptanceConfig,
	AcceptanceEvidenceKind,
	AcceptanceInput,
	AcceptanceLevel,
} from "../../../shared/types.ts";
import {
	ACCEPTANCE_CONFIG_KEYS,
	ACCEPTANCE_GATE_KEYS,
	ACCEPTANCE_REVIEW_KEYS,
	ACCEPTANCE_VERIFY_KEYS,
	VALID_EVIDENCE,
	VALID_LEVELS,
} from "./constants.ts";

export function normalizeAcceptanceInput(input: AcceptanceInput | undefined): AcceptanceConfig {
	if (input === undefined || input === "auto") return { level: "auto" };
	if (input === false) return { level: "none", reason: "disabled by deprecated false shorthand" };
	if (typeof input === "string") return { level: input };
	return { ...input };
}

export function validateAcceptanceInput(input: unknown, pathLabel = "acceptance"): string[] {
	const errors: string[] = [];
	if (input === undefined) return errors;
	if (input === false) return errors;
	if (typeof input === "string") {
		if (!VALID_LEVELS.has(input as AcceptanceLevel)) errors.push(`${pathLabel} has invalid level '${input}'.`);
		return errors;
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		errors.push(`${pathLabel} must be a string level, false, or an object.`);
		return errors;
	}
	const value = input as Record<string, unknown>;
	for (const key of Object.keys(value)) {
		if (!ACCEPTANCE_CONFIG_KEYS.has(key)) errors.push(`${pathLabel}.${key} is not supported.`);
	}
	if (value.level !== undefined && (typeof value.level !== "string" || !VALID_LEVELS.has(value.level as AcceptanceLevel))) {
		errors.push(`${pathLabel}.level must be one of auto, none, attested, checked, verified, reviewed.`);
	}
	if (value.level === "none" && (typeof value.reason !== "string" || !value.reason.trim())) {
		errors.push(`${pathLabel}.reason is required when level is none.`);
	}
	if (value.reason !== undefined && typeof value.reason !== "string") errors.push(`${pathLabel}.reason must be a string.`);
	if (value.criteria !== undefined && !Array.isArray(value.criteria)) errors.push(`${pathLabel}.criteria must be an array.`);
	if (Array.isArray(value.criteria)) {
		for (const [index, criterion] of value.criteria.entries()) {
			if (typeof criterion === "string") continue;
			const criterionPath = `${pathLabel}.criteria[${index}]`;
			if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
				errors.push(`${criterionPath} must be a string or an object.`);
				continue;
			}
			const gate = criterion as Record<string, unknown>;
			for (const key of Object.keys(gate)) {
				if (!ACCEPTANCE_GATE_KEYS.has(key)) errors.push(`${criterionPath}.${key} is not supported.`);
			}
			if (typeof gate.id !== "string" || !gate.id.trim()) errors.push(`${criterionPath}.id is required.`);
			if (typeof gate.must !== "string" || !gate.must.trim()) errors.push(`${criterionPath}.must is required.`);
			if (gate.evidence !== undefined && !Array.isArray(gate.evidence)) errors.push(`${criterionPath}.evidence must be an array.`);
			if (Array.isArray(gate.evidence)) {
				for (const [evidenceIndex, item] of gate.evidence.entries()) {
					if (typeof item !== "string" || !VALID_EVIDENCE.has(item as AcceptanceEvidenceKind)) {
						errors.push(`${criterionPath}.evidence[${evidenceIndex}] is not a supported evidence kind.`);
					}
				}
			}
			if (gate.severity !== undefined && gate.severity !== "required" && gate.severity !== "recommended") {
				errors.push(`${criterionPath}.severity must be required or recommended.`);
			}
		}
	}
	if (Array.isArray(value.evidence)) {
		for (const [index, item] of value.evidence.entries()) {
			if (typeof item !== "string" || !VALID_EVIDENCE.has(item as AcceptanceEvidenceKind)) {
				errors.push(`${pathLabel}.evidence[${index}] is not a supported evidence kind.`);
			}
		}
	} else if (value.evidence !== undefined) {
		errors.push(`${pathLabel}.evidence must be an array.`);
	}
	if (value.verify !== undefined && !Array.isArray(value.verify)) errors.push(`${pathLabel}.verify must be an array.`);
	if (Array.isArray(value.verify)) {
		for (const [index, command] of value.verify.entries()) {
			if (!command || typeof command !== "object" || Array.isArray(command)) {
				errors.push(`${pathLabel}.verify[${index}] must be an object.`);
				continue;
			}
			const cmd = command as Record<string, unknown>;
			for (const key of Object.keys(cmd)) {
				if (!ACCEPTANCE_VERIFY_KEYS.has(key)) errors.push(`${pathLabel}.verify[${index}].${key} is not supported.`);
			}
			if (typeof cmd.id !== "string" || !cmd.id.trim()) errors.push(`${pathLabel}.verify[${index}].id is required.`);
			if (typeof cmd.command !== "string" || !cmd.command.trim()) errors.push(`${pathLabel}.verify[${index}].command is required.`);
			if (cmd.timeoutMs !== undefined && (typeof cmd.timeoutMs !== "number" || !Number.isInteger(cmd.timeoutMs) || cmd.timeoutMs < 1)) {
				errors.push(`${pathLabel}.verify[${index}].timeoutMs must be an integer >= 1.`);
			}
			if (cmd.cwd !== undefined && typeof cmd.cwd !== "string") errors.push(`${pathLabel}.verify[${index}].cwd must be a string.`);
			if (cmd.env !== undefined) {
				if (!cmd.env || typeof cmd.env !== "object" || Array.isArray(cmd.env)) {
					errors.push(`${pathLabel}.verify[${index}].env must be an object.`);
				} else {
					for (const [envKey, envValue] of Object.entries(cmd.env as Record<string, unknown>)) {
						if (typeof envValue !== "string") errors.push(`${pathLabel}.verify[${index}].env.${envKey} must be a string.`);
					}
				}
			}
			if (cmd.allowFailure !== undefined && typeof cmd.allowFailure !== "boolean") {
				errors.push(`${pathLabel}.verify[${index}].allowFailure must be a boolean.`);
			}
		}
	}
	if (value.review !== undefined && value.review !== false) {
		if (!value.review || typeof value.review !== "object" || Array.isArray(value.review)) {
			errors.push(`${pathLabel}.review must be false or an object.`);
		} else {
			const review = value.review as Record<string, unknown>;
			for (const key of Object.keys(review)) {
				if (!ACCEPTANCE_REVIEW_KEYS.has(key)) errors.push(`${pathLabel}.review.${key} is not supported.`);
			}
			if (review.agent !== undefined && typeof review.agent !== "string") errors.push(`${pathLabel}.review.agent must be a string.`);
			if (review.focus !== undefined && typeof review.focus !== "string") errors.push(`${pathLabel}.review.focus must be a string.`);
			if (review.required !== undefined && typeof review.required !== "boolean") errors.push(`${pathLabel}.review.required must be a boolean.`);
		}
	}
	if (value.stopRules !== undefined && !Array.isArray(value.stopRules)) errors.push(`${pathLabel}.stopRules must be an array.`);
	if (Array.isArray(value.stopRules)) {
		for (const [index, item] of value.stopRules.entries()) {
			if (typeof item !== "string") errors.push(`${pathLabel}.stopRules[${index}] must be a string.`);
		}
	}
	return errors;
}
