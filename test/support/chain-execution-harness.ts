/**
 * Shared harness for the chain-execution integration test siblings.
 *
 * Holds module-level tryImport consts and shared type interfaces extracted
 * from the original `chain-execution.test.ts`.
 */
import { tryImport } from "./helpers.ts";


export interface TestSequentialStep {
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: Record<string, unknown>;
	model?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	skill?: string | string[] | false;
	progress?: boolean;
	cwd?: string;
	acceptance?: unknown;
}

export interface TestParallelTask {
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: Record<string, unknown>;
	model?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	skill?: string | string[] | false;
	progress?: boolean;
	cwd?: string;
	acceptance?: unknown;
}

export type TestChainStep = TestSequentialStep | {
	parallel: TestParallelTask[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	cwd?: string;
} | {
	expand: {
		from: { output: string; path: string };
		item?: string;
		key?: string;
		maxItems?: number;
		onEmpty?: "skip" | "fail";
	};
	parallel: TestParallelTask;
	collect: { as: string; outputSchema?: Record<string, unknown> };
	concurrency?: number;
	failFast?: boolean;
	label?: string;
	acceptance?: unknown;
};

export interface ChainResultItem {
	agent: string;
	exitCode: number;
	finalOutput?: string;
	structuredOutput?: unknown;
	task?: string;
	detached?: boolean;
	timedOut?: boolean;
	error?: string;
	attemptedModels?: string[];
	skills?: string[];
	acceptance?: { status?: string; verifyRuns?: Array<{ status?: string }>; childReport?: unknown; runtimeChecks?: Array<{ status?: string; id?: string }> };
}

export interface ChainExecutionResult {
	isError?: boolean;
	content: Array<{ text: string }>;
	details: {
		results: ChainResultItem[];
		chainAgents?: string[];
		totalSteps?: number;
		totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
		workflowGraph?: {
			nodes: Array<{ kind?: string; agent?: string; flatIndex?: number; outputName?: string; status?: string; error?: string; acceptanceStatus?: string; children?: Array<{ itemKey?: string; label?: string; status?: string; acceptanceStatus?: string }> }>;
		};
		currentStepIndex?: number;
		outputs?: Record<string, { text: string; structured?: unknown }>;
	};
}

export interface ChainExecutionModule {
	executeChain(params: Record<string, unknown>): Promise<ChainExecutionResult>;
}

export const chainMod = await tryImport<ChainExecutionModule>("./src/runs/foreground/chain-execution.ts");
export const available = !!chainMod;
export const executeChain = chainMod?.executeChain;

