import type { Message } from "@earendil-works/pi-ai";
import type {
	ArtifactConfig,
	ArtifactPaths,
	AsyncParallelGroupStatus,
	AsyncStatus,
	ChainOutputMap,
	CostSummary,
	MaxOutputConfig,
	ModelAttempt,
	NestedRouteInfo,
	ResolvedControlConfig,
	ResolvedToolBudget,
	ResolvedTurnBudget,
	SubagentRunMode,
	ToolBudgetState,
	TurnBudgetState,
	Usage,
	WorkflowGraphSnapshot,
} from "../../../shared/types.ts";
import type { RunnerStep } from "../../shared/parallel-utils.ts";

export interface SubagentRunConfig {
	id: string;
	steps: RunnerStep[];
	resultPath: string;
	cwd: string;
	placeholder: string;
	taskIndex?: number;
	totalTasks?: number;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	share?: boolean;
	sessionDir?: string;
	asyncDir: string;
	sessionId?: string | null;
	piPackageRoot?: string;
	piArgv1?: string;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTargets?: Array<string | undefined>;
	resultMode?: SubagentRunMode;
	dynamicFanoutMaxItems?: number;
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: { parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }> };
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	/** Global cap on simultaneously-running subagent tasks within this run. */
	globalConcurrencyLimit?: number;
	/** Launch steps as persistent Pi RPC processes (Option B). */
	persistentChildren?: boolean;
	/** Parent-side registry for resident RPC children. */
	persistentChildRegistry?: import("../../persistent/rpc-child-registry.ts").RpcChildRegistry;
}

export interface StepResult {
	agent: string;
	output: string;
	error?: string;
	success: boolean;
	exitCode?: number | null;
	skipped?: boolean;
	interrupted?: boolean;
	timedOut?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	totalCost?: CostSummary;
	artifactPaths?: ArtifactPaths;
	truncated?: boolean;
	transcriptPath?: string;
	transcriptError?: string;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;

}

export interface ChildEventContext {
	eventsPath: string;
	runId: string;
	stepIndex: number;
	agent: string;
}

export interface ChildUsage {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export type ChildMessage = Message & {
	model?: string;
	errorMessage?: string;
	usage?: ChildUsage;
};

export interface ChildEvent {
	type?: string;
	message?: ChildMessage;
	toolName?: string;
	args?: Record<string, unknown>;
}

export interface RunPiStreamingResult {
	stderr: string;
	exitCode: number | null;
	/** True when the child remains resident (Option B); the process is parked in the registry. */
	residentChild?: boolean;
	messages: Message[];
	usage: Usage;
	model?: string;
	error?: string;
	finalOutput: string;
	interrupted?: boolean;
	timedOut?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	observedMutationAttempt?: boolean;
}

/** Context for running a single step */
export interface SingleStepContext {
	previousOutput: string;
	outputs?: ChainOutputMap;
	placeholder: string;
	cwd: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	id: string;
	flatIndex: number;
	flatStepCount: number;
	outputFile: string;
	steerInboxDir?: string;
	actionControlDir?: string;
	transcriptPath?: string;
	piPackageRoot?: string;
	piArgv1?: string;
	registerInterrupt?: (interrupt: (() => void) | undefined) => void;
	registerTimeout?: (interrupt: (() => void) | undefined) => void;
	registerTurnBudgetAbort?: (abort: ((message: string, state?: TurnBudgetState) => void) | undefined) => void;
	timeoutSignal?: AbortSignal;
	timeoutMessage?: string;
	turnBudget?: ResolvedTurnBudget;
	childIntercomTarget?: string;
	orchestratorIntercomTarget?: string;
	nestedRoute?: NestedRouteInfo;
	onAttemptStart?: (attempt: { model?: string; thinking?: string }) => void;
	onChildEvent?: (event: ChildEvent) => void;
	/** Launch steps as persistent Pi RPC processes (Option B). */
	persistentChildren?: boolean;
	/** Parent-side registry for resident RPC children. */
	persistentChildRegistry?: import("../../persistent/rpc-child-registry.ts").RpcChildRegistry;
	/** Runner-side conversation bridge for this child's step (Phase 4). */
	conversationBridge?: import("./conversation-bridge.ts").RunnerConversationBridge;
}

export type RunnerStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
	exitCode?: number | null;
};

export type RunnerStatusPayload = Omit<AsyncStatus, "steps" | "parallelGroups" | "pid" | "cwd" | "currentStep" | "chainStepCount" | "lastUpdate"> & {
	pid: number;
	cwd: string;
	currentStep: number;
	chainStepCount: number;
	parallelGroups: AsyncParallelGroupStatus[];
	steps: RunnerStatusStep[];
	lastUpdate: number;
	artifactsDir?: string;
	error?: string;
};

