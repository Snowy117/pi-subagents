/** Pure effective-behavior readers for chain-clarify (stateless, no `this`). */

import { findModelInfo, getSupportedThinkingLevels } from "../../../shared/model-info.ts";
import type { ModelInfo, ThinkingLevel } from "../../../shared/model-info.ts";
import type { ResolvedStepBehavior } from "../../../shared/settings.ts";
import { resolveModelCandidate } from "../../shared/model-fallback.ts";
import type { BehaviorOverride } from "./types.ts";

/** Effective behavior for a step: base resolved behavior with overrides applied. */
export function computeEffectiveBehavior(
	resolvedBehaviors: ResolvedStepBehavior[],
	behaviorOverrides: Map<number, BehaviorOverride>,
	stepIndex: number,
): ResolvedStepBehavior {
	const base = resolvedBehaviors[stepIndex]!;
	const override = behaviorOverrides.get(stepIndex);
	if (!override) return base;

	return {
		output: override.output !== undefined ? override.output : base.output,
		outputMode: base.outputMode,
		reads: override.reads !== undefined ? override.reads : base.reads,
		progress: override.progress !== undefined ? override.progress : base.progress,
		skills: override.skills !== undefined ? override.skills : base.skills,
		model: override.model !== undefined ? override.model : base.model,
	};
}

/** Resolve a model name to its full provider/model id via the fallback chain. */
export function resolveModelFullId(
	modelName: string,
	availableModels: ModelInfo[],
	preferredProvider: string | undefined,
): string {
	return resolveModelCandidate(modelName, availableModels, preferredProvider) ?? modelName;
}

/** Effective model for a step (override or agent default), fully resolved. */
export function computeEffectiveModel(
	resolvedBehaviors: ResolvedStepBehavior[],
	behaviorOverrides: Map<number, BehaviorOverride>,
	availableModels: ModelInfo[],
	preferredProvider: string | undefined,
	stepIndex: number,
): string {
	const override = behaviorOverrides.get(stepIndex);
	if (override?.model) return resolveModelFullId(override.model, availableModels, preferredProvider);

	const baseModel = resolvedBehaviors[stepIndex]?.model;
	if (baseModel) return resolveModelFullId(baseModel, availableModels, preferredProvider);
	return "default";
}

/** Thinking levels supported by the effective model of a step. */
export function computeAvailableThinkingLevels(
	resolvedBehaviors: ResolvedStepBehavior[],
	behaviorOverrides: Map<number, BehaviorOverride>,
	availableModels: ModelInfo[],
	preferredProvider: string | undefined,
	stepIndex: number,
): ThinkingLevel[] {
	const effectiveModel = computeEffectiveModel(resolvedBehaviors, behaviorOverrides, availableModels, preferredProvider, stepIndex);
	return getSupportedThinkingLevels(findModelInfo(effectiveModel, availableModels, preferredProvider));
}
