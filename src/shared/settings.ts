/**
 * Shared settings barrel.
 *
 * Kept for backward-compatible re-exports of non-chain utilities.
 * Internal runner types (ChainStep, isParallelStep, etc.) are defined
 * here for use by async-execution/step-building.ts and runner internals.
 */

export type { ParallelTaskResult } from "../runs/shared/parallel-utils.ts";
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.ts";

// -- Internal runner types (used by async-execution and runner internals) --

export interface SequentialStep {
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: unknown;
	cwd?: string;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	skill?: string | string[] | boolean;
	model?: string;
	toolBudget?: unknown;
	acceptance?: unknown;
}

export interface ParallelStep {
	parallel: SequentialStep[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
}

export interface DynamicParallelStep {
	expand: { from: { output: string; path: string }; item?: string; key?: string; maxItems?: number; onEmpty?: "skip" | "fail" };
	parallel: SequentialStep;
	collect?: { as: string; outputSchema?: unknown };
	concurrency?: number;
	failFast?: boolean;
	phase?: string;
	label?: string;
	acceptance?: unknown;
}

export type ChainStep = SequentialStep | ParallelStep | DynamicParallelStep;

export function isParallelStep(step: ChainStep): step is ParallelStep {
	return "parallel" in step && !("expand" in step);
}

export function isDynamicParallelStep(step: ChainStep): step is DynamicParallelStep {
	return "expand" in step;
}

export function getStepAgents(step: ChainStep): string[] {
	if (isParallelStep(step)) return step.parallel.map((t) => t.agent);
	if (isDynamicParallelStep(step)) return [step.parallel.agent];
	return [(step as SequentialStep).agent];
}

export interface StepOverrides {
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	skills?: string[] | false | undefined;
	model?: string;
}

export interface ResolvedStepBehavior {
	output: string | boolean | undefined;
	outputMode: "inline" | "file-only";
	reads: string[] | boolean | undefined;
	progress: boolean;
	skills: string[] | false | undefined;
	model: string | undefined;
}

export function resolveStepBehavior(
	agent: { output?: string | boolean; outputMode?: "inline" | "file-only"; reads?: string[] | boolean; progress?: boolean; skills?: string[]; model?: string },
	overrides?: StepOverrides,
	_chainSkills?: string[],
): ResolvedStepBehavior {
	return {
		output: overrides?.output !== undefined ? overrides.output : agent.output,
		outputMode: overrides?.outputMode ?? agent.outputMode ?? "inline",
		reads: overrides?.reads !== undefined ? overrides.reads : agent.reads,
		progress: overrides?.progress ?? agent.progress ?? false,
		skills: overrides?.skills !== undefined ? overrides.skills : (agent.skills ?? undefined),
		model: overrides?.model ?? agent.model,
	};
}

export function buildChainInstructions(
	behavior: StepOverrides,
	_cwd: string,
	_isFirstProgress: boolean,
): { prefix: string; suffix: string } {
	const prefix = "";
	const suffix = "";
	return { prefix, suffix };
}

export function taskDisallowsFileUpdates(task: string): boolean {
	return /\b(?:read[- ]only|review[- ]only|do not edit|don't edit|no edits|without edits|inspect|summari[sz]e)\b/i.test(task);
}

export function writeInitialProgressFile(_progressDir: string): void {
	// No-op: progress tracking is handled by the runner.
}

export function suppressProgressForReadOnlyTask(
	behavior: ResolvedStepBehavior,
	_task: string,
	_originalTask?: string,
): ResolvedStepBehavior {
	return behavior;
}