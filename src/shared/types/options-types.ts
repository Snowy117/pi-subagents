/**
 * Execution options + extension configuration types, plus artifact
 * path/config descriptors used across run results and resume state.
 */

import type { ResolvedTurnBudget, ResolvedToolBudget, TurnBudgetConfig, ToolBudgetConfig } from "./budget-types.ts";
import type { ControlEvent, ResolvedControlConfig, ControlConfig, CompletionBatchConfig, WaitToolConfig } from "./control-types.ts";
import type { IntercomEventBus, Details, SingleResult, MaxOutputConfig, OutputMode, JsonSchemaObject, SubagentRunMode } from "./result-types.ts";
import type { NestedRouteInfo } from "./async-types.ts";
import type { AcceptanceInput } from "./acceptance-types.ts";
import type { AgentConfig } from "../../agents/agents.ts";
import type { ModelScopeConfig } from "../../runs/shared/model-scope.ts";

export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	transcriptPath: string;
	metadataPath: string;
}

export interface ArtifactConfig {
	enabled: boolean;
	includeInput: boolean;
	includeOutput: boolean;
	includeJsonl: boolean;
	includeTranscript?: boolean;
	includeMetadata: boolean;
	cleanupDays: number;
}

export interface RunSyncOptions {
	/** Session id of the direct parent session for permission-system ask forwarding. */
	parentSessionId?: string;
	cwd?: string;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	allowIntercomDetach?: boolean;
	intercomEvents?: IntercomEventBus;
	onUpdate?: (r: import("@earendil-works/pi-agent-core").AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	onDetachedExit?: (result: SingleResult) => void;
	controlConfig?: ResolvedControlConfig;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	runId: string;
	index?: number;
	sessionDir?: string;
	sessionFile?: string;
	share?: boolean;
	outputPath?: string;
	outputMode?: OutputMode;
	maxSubagentDepth?: number;
	nestedRoute?: NestedRouteInfo;
	/** Override the agent's default model (format: "provider/id" or just "id") */
	modelOverride?: string;
	/** Override the agent's default thinking level for this run */
	thinkingOverride?: AgentConfig["thinking"];
	/** Registry models available for heuristic bare-model resolution */
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	/** Current parent-session provider to prefer for ambiguous bare model ids */
	preferredModelProvider?: string;
	/** Optional subagent model-scope enforcement for fallback candidates */
	modelScope?: ModelScopeConfig;
	/** Skills to make available (overrides agent default if provided) */
	skills?: string[];
	structuredOutput?: {
		schema: JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
	acceptance?: AcceptanceInput;
	acceptanceContext?: {
		mode?: SubagentRunMode;
		async?: boolean;
		dynamic?: boolean;
		dynamicGroup?: boolean;
	};
}

export type IntercomBridgeMode = "off" | "fork-only" | "always";

export interface IntercomBridgeConfig {
	mode?: IntercomBridgeMode;
	instructionFile?: string;
}

interface TopLevelParallelConfig {
	maxTasks?: number;
	concurrency?: number;
}

interface ExtensionChainConfig {
	dynamicFanout?: {
		maxItems?: number;
	};
}

export interface ProactiveSkillSubagentsConfig {
	enabled?: boolean;
	minReferences?: number;
	maxRecommendations?: number;
	preferredAgent?: string;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";

export interface ScheduledRunsConfig {
	enabled?: boolean;
	maxLatenessMs?: number;
	maxPending?: number;
}

export interface ExtensionConfig {
	asyncByDefault?: boolean;
	/** Tool description variant registered for the parent-facing subagent tool. Defaults to full. */
	toolDescriptionMode?: ToolDescriptionMode;
	forceTopLevelAsync?: boolean;
	waitTool?: WaitToolConfig;
	defaultSessionDir?: string;
	singleRunOutputBaseDir?: string;
	maxSubagentDepth?: number;
	maxSubagentSpawnsPerSession?: number;
	/** Global cap on simultaneously-running subagent tasks within a single run. Defaults to 20. */
	globalConcurrencyLimit?: number;
	control?: ControlConfig;
	completionBatch?: CompletionBatchConfig;
	turnBudget?: TurnBudgetConfig;
	toolBudget?: ToolBudgetConfig;
	parallel?: TopLevelParallelConfig;
	chain?: ExtensionChainConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	intercomBridge?: IntercomBridgeConfig;
	proactiveSkillSubagents?: ProactiveSkillSubagentsConfig | false;
	scheduledRuns?: ScheduledRunsConfig;
}
