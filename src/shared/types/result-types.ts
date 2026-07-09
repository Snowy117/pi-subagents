/**
 * Run-result domain types: workflow graphs, progress, model attempts,
 * single/aggregate results, display items, errors, and the intercom
 * result payload. The central "what a run produced" model.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { Usage, TurnBudgetState, ResolvedTurnBudget, ToolBudgetState, ResolvedToolBudget, CostSummary } from "./budget-types.ts";
import type { ActivityState, ControlEvent } from "./control-types.ts";
import type { AcceptanceLedger, AcceptanceLedgerStatus } from "./acceptance-types.ts";
import type { ArtifactPaths } from "./options-types.ts";
import type { PublicNestedRunSummary, NestedRunSummary } from "./nested-types.ts";
import type { TruncationResult } from "./output-truncation.ts";

export interface MaxOutputConfig {
	bytes?: number;
	lines?: number;
}

export type OutputMode = "inline" | "file-only";

export type JsonSchemaObject = Record<string, unknown>;

export interface ChainOutputMapEntry {
	text: string;
	structured?: unknown;
	agent: string;
	stepIndex: number;
}

export type ChainOutputMap = Record<string, ChainOutputMapEntry>;

export type WorkflowNodeStatus = "pending" | "running" | "completed" | "failed" | "paused" | "detached";

export interface WorkflowGraphNode {
	id: string;
	kind: "step" | "parallel-group" | "dynamic-parallel-group" | "agent";
	agent?: string;
	phase?: string;
	label: string;
	status: WorkflowNodeStatus;
	flatIndex?: number;
	stepIndex?: number;
	children?: WorkflowGraphNode[];
	dynamic?: {
		sourceOutput: string;
		sourcePath: string;
		itemName: string;
		maxItems?: number;
		collectAs?: string;
	};
	itemKey?: string;
	outputName?: string;
	structured?: boolean;
	acceptanceStatus?: AcceptanceLedgerStatus;
	error?: string;
}

export interface WorkflowGraphSnapshot {
	runId: string;
	mode: "chain" | "parallel" | "single";
	phases: Array<{ title: string; nodeIds: string[] }>;
	nodes: WorkflowGraphNode[];
	currentNodeId?: string;
}

export interface SavedOutputReference {
	path: string;
	bytes: number;
	lines: number;
	message: string;
}

export interface AgentProgress {
	index: number;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "detached";
	activityState?: ActivityState;
	task: string;
	skills?: string[];
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	turnCount?: number;
	tokens: number;
	durationMs: number;
	error?: string;
	failedTool?: string;
}

export interface ToolCallSummary {
	text: string;
	expandedText: string;
}

interface ProgressSummary {
	toolCount: number;
	tokens: number;
	durationMs: number;
}

export interface ModelAttempt {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export type SubagentResultStatus = "completed" | "failed" | "paused" | "detached";
export type SubagentRunMode = "single" | "parallel" | "chain";

export interface SubagentResultIntercomChild {
	agent: string;
	status: SubagentResultStatus;
	summary: string;
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
	intercomTarget?: string;
	children?: PublicNestedRunSummary[];
}

export interface SubagentResultIntercomPayload {
	to: string;
	message: string;
	requestId?: string;
	runId: string;
	mode: SubagentRunMode;
	status: SubagentResultStatus;
	summary: string;
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
	asyncDir?: string;
	chainSteps?: number;
	agent?: string;
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
}

export interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	detached?: boolean;
	detachedReason?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	messages?: Message[];
	usage: Usage;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	controlEvents?: ControlEvent[];
	error?: string;
	sessionFile?: string;
	skills?: string[];
	skillsWarning?: string;
	progress?: AgentProgress;
	progressSummary?: ProgressSummary;
	toolCalls?: ToolCallSummary[];
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
	finalOutput?: string;
	outputMode?: OutputMode;
	savedOutputPath?: string;
	outputReference?: SavedOutputReference;
	outputSaveError?: string;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
	transcriptPath?: string;
	transcriptError?: string;
	children?: NestedRunSummary[];
}

export interface Details {
	mode: SubagentRunMode | "management";
	runId?: string;
	context?: "fresh" | "fork";
	results: SingleResult[];
	controlEvents?: ControlEvent[];
	asyncId?: string;
	asyncDir?: string;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	progress?: AgentProgress[];
	progressSummary?: ProgressSummary;
	artifacts?: {
		dir: string;
		files: ArtifactPaths[];
	};
	truncation?: {
		truncated: boolean;
		originalBytes?: number;
		originalLines?: number;
		artifactPath?: string;
	};
	// Chain metadata for observability
	chainAgents?: string[];      // Agent names in order, e.g., ["scout", "planner"]
	totalSteps?: number;         // Total steps in chain
	currentStepIndex?: number;   // 0-indexed current step (for running chains)
	workflowGraph?: WorkflowGraphSnapshot;
	outputs?: ChainOutputMap;
	// Aggregated child usage across all agents in the run
	totalChildUsage?: Usage;
	// Aggregated cost across all agents in the run
	totalCost?: CostSummary;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "tool"; name: string; args: Record<string, unknown> };

export interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

export interface IntercomEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}
