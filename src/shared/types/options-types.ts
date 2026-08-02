/**
 * Execution options + extension configuration types, plus artifact
 * path/config descriptors used across run results and resume state.
 */

import type { ResolvedTurnBudget, ResolvedToolBudget, TurnBudgetConfig, ToolBudgetConfig } from "./budget-types.ts";
import type { ControlEvent, ResolvedControlConfig, ControlConfig, CompletionBatchConfig, WaitToolConfig } from "./control-types.ts";
import type { IntercomEventBus, Details, SingleResult, MaxOutputConfig, OutputMode } from "./result-types.ts";
import type { NestedRouteInfo } from "./async-types.ts";
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

	foregroundLiveChildren?: import("./async-types.ts").SubagentState["foregroundLiveChildren"];
	/** Launch the child as a persistent Pi RPC process (Option B). Defaults to false; the extension config layer resolves the user-facing default. */
	persistentChildren?: boolean;
	/** Parent-side registry for resident RPC children; required when persistentChildren is true. */
	persistentChildRegistry?: import("../../runs/persistent/rpc-child-registry.ts").RpcChildRegistry;
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

export interface TuiConfig {
	openSubagentsOnDown: boolean;
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
	/** Persistent RPC child lifecycle: enabled toggle + eviction settings (Option B). */
	persistentChildren?: boolean | {
		enabled?: boolean;
		eviction?: {
			idleMs?: number;
			maxResidentChildren?: number;
		};
	};
	/** Routing of app-level keys (Esc abort, model/thinking cycle+select,
	 *  tools expand, thinking toggle) to the child while child mode is active.
	 *  Default: true. */
	childKeyRoute?: boolean;
	completionBatch?: CompletionBatchConfig;
	turnBudget?: TurnBudgetConfig;
	toolBudget?: ToolBudgetConfig;
	parallel?: TopLevelParallelConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	intercomBridge?: IntercomBridgeConfig;
	proactiveSkillSubagents?: ProactiveSkillSubagentsConfig | false;
	scheduledRuns?: ScheduledRunsConfig;
	tui?: Partial<TuiConfig>;
}
