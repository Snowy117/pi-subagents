/**
 * Async execution state types: async-started event, async run status,
 * job state, foreground-resume records, and the live extension subagent
 * state. Nested-run shapes live in nested-types.
 */

import type { FSWatcher } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TurnBudgetState, ToolBudgetState, TokenUsage, CostSummary } from "./budget-types.ts";
import type { ActivityState } from "./control-types.ts";
import type { SubagentRunMode, SubagentResultStatus, WorkflowGraphSnapshot, ChainOutputMap, ModelAttempt, OutputMode } from "./result-types.ts";
import type { ArtifactPaths } from "./options-types.ts";
import type { AcceptanceLedger } from "./acceptance-types.ts";
import type { SubagentLifecycleArtifactVersion } from "./constants.ts";
import type { AsyncParallelGroupStatus, NestedRunSummary, NestedRouteInfo } from "./nested-types.ts";

export interface AsyncStartedEvent {
	lifecycleArtifactVersion?: SubagentLifecycleArtifactVersion;
	id?: string;
	asyncDir?: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agent?: string;
	agents?: string[];
	chain?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	workflowGraph?: WorkflowGraphSnapshot;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: TurnBudgetState;
	nestedRoute?: NestedRouteInfo;
}

export interface AsyncStatus {
	lifecycleArtifactVersion?: SubagentLifecycleArtifactVersion;
	runId: string;
	sessionId?: string;
	mode: SubagentRunMode;
	state: "queued" | "running" | "complete" | "failed" | "paused";
	error?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	steerCount?: number;
	lastSteerAt?: number;
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	pid?: number;
	cwd?: string;
	currentStep?: number;
	chainStepCount?: number;
	pendingAppends?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	workflowGraph?: WorkflowGraphSnapshot;
	steps?: Array<{
		agent: string;
		phase?: string;
		label?: string;
		outputName?: string;
		structured?: boolean;
		status: "pending" | "running" | "complete" | "completed" | "failed" | "paused";
		children?: NestedRunSummary[];
		sessionFile?: string;
		transcriptPath?: string;
		transcriptError?: string;
		activityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolArgs?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		recentTools?: Array<{ tool: string; args: string; endMs: number }>;
		recentOutput?: string[];
		turnCount?: number;
		toolCount?: number;
		startedAt?: number;
		endedAt?: number;
		durationMs?: number;
		exitCode?: number | null;
		timedOut?: boolean;
		turnBudget?: TurnBudgetState;
		turnBudgetExceeded?: boolean;
		wrapUpRequested?: boolean;
		toolBudget?: ToolBudgetState;
		toolBudgetBlocked?: boolean;
		tokens?: TokenUsage;
		skills?: string[];
		model?: string;
		thinking?: string;
		attemptedModels?: string[];
		modelAttempts?: ModelAttempt[];
		totalCost?: CostSummary;
		steerCount?: number;
		lastSteerAt?: number;
		error?: string;
		structuredOutput?: unknown;
		structuredOutputPath?: string;
		structuredOutputSchemaPath?: string;
		acceptance?: AcceptanceLedger;
	}>;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	totalCost?: CostSummary;
	sessionFile?: string;
	outputs?: ChainOutputMap;
}

export type AsyncJobStep = NonNullable<AsyncStatus["steps"]>[number] & {
	index?: number;
};

export interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	status: "queued" | "running" | "complete" | "failed" | "paused";
	pid?: number;
	sessionId?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	steerCount?: number;
	lastSteerAt?: number;
	mode?: SubagentRunMode;
	agents?: string[];
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: AsyncJobStep[];
	stepsTotal?: number;
	runningSteps?: number;
	completedSteps?: number;
	hasParallelGroups?: boolean;
	activeParallelGroup?: boolean;
	startedAt?: number;
	updatedAt?: number;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	controlEventCursor?: number;
	nestedRoute?: NestedRouteInfo;
	nestedChildren?: NestedRunSummary[];
}

export interface ForegroundResumeChild {
	agent: string;
	index: number;
	sessionFile?: string;
	status: SubagentResultStatus;
	exitCode?: number;
	finalOutput?: string;
	outputMode?: OutputMode;
	savedOutputPath?: string;
	outputSaveError?: string;
	artifactPaths?: ArtifactPaths;
	transcriptPath?: string;
	transcriptError?: string;
	detachedReason?: string;
	updatedAt?: number;
}

export interface ForegroundResumeRun {
	runId: string;
	mode: SubagentRunMode;
	cwd: string;
	updatedAt: number;
	children: ForegroundResumeChild[];
}

export interface SubagentState {
	baseCwd: string;
	currentSessionId: string | null;
	subagentInProgress?: boolean;
	subagentSpawns?: { sessionId: string | null; count: number };
	asyncJobs: Map<string, AsyncJobState>;
	foregroundRuns?: Map<string, ForegroundResumeRun>;
	foregroundControls: Map<string, {
		runId: string;
		mode: SubagentRunMode;
		startedAt: number;
		updatedAt: number;
		currentAgent?: string;
		currentIndex?: number;
		currentActivityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		turnCount?: number;
		tokens?: number;
		toolCount?: number;
		nestedRoute?: NestedRouteInfo;
		nestedChildren?: NestedRunSummary[];
		interrupt?: () => boolean;
	}>;
	lastForegroundControlId: string | null;
	pendingForegroundControlNotices?: Map<string, ReturnType<typeof setTimeout>>;
	cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
	lastUiContext: ExtensionContext | null;
	poller: NodeJS.Timeout | null;
	completionSeen: Map<string, number>;
	watcher: FSWatcher | null;
	watcherRestartTimer: ReturnType<typeof setTimeout> | null;
	resultFileCoalescer: {
		schedule(file: string, delayMs?: number): boolean;
		clear(): void;
	};
}
