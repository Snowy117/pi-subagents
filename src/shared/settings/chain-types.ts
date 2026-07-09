/**
 * Chain step and behavior types: sequential/parallel/dynamic step shapes,
 * per-step behavior overrides, and the resolved behavior descriptor.
 */

import type { OutputMode, JsonSchemaObject, ToolBudgetConfig, AcceptanceInput } from "../types.ts";

export interface ResolvedStepBehavior {
	output: string | false;
	outputMode: OutputMode;
	reads: string[] | false;
	progress: boolean;
	skills: string[] | false;
	model?: string;
}

export interface StepOverrides {
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skills?: string[] | false;
	model?: string;
}

/** Sequential step: single agent execution */
export interface SequentialStep {
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: JsonSchemaObject;
	cwd?: string;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skill?: string | string[] | false;
	model?: string;
	toolBudget?: ToolBudgetConfig;
	acceptance?: AcceptanceInput;
}

/** Parallel task item within a parallel step */
export interface ParallelTaskItem {
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: JsonSchemaObject;
	cwd?: string;
	count?: number;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skill?: string | string[] | false;
	model?: string;
	toolBudget?: ToolBudgetConfig;
	acceptance?: AcceptanceInput;
}

export interface DynamicExpandSpec {
	from: {
		output: string;
		path: string;
	};
	item?: string;
	key?: string;
	maxItems?: number;
	onEmpty?: "skip" | "fail";
}

export type DynamicParallelTemplate = Omit<ParallelTaskItem, "as" | "count">;

export interface DynamicCollectSpec {
	as: string;
	outputSchema?: JsonSchemaObject;
}

export interface DynamicParallelStep {
	expand: DynamicExpandSpec;
	parallel: DynamicParallelTemplate;
	collect: DynamicCollectSpec;
	concurrency?: number;
	failFast?: boolean;
	phase?: string;
	label?: string;
	acceptance?: AcceptanceInput;
}

/** Parallel step: multiple agents running concurrently */
export interface ParallelStep {
	parallel: ParallelTaskItem[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	cwd?: string;
}

/** Union type for chain steps */
export type ChainStep = SequentialStep | ParallelStep | DynamicParallelStep;
