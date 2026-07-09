import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../../agents/agents.ts";
import type { ChainStep } from "../../../shared/settings.ts";
import type { RunnerStep } from "../../shared/parallel-utils.ts";
import type { AvailableModelInfo, ParentModel } from "../../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../../shared/model-scope.ts";
import { buildWorkflowGraphSnapshot } from "../../shared/workflow-graph.ts";
import type { ImportedAsyncRoot } from "../chain-root-attachment.ts";
import type {
	AcceptanceInput,
	ArtifactConfig,
	Details,
	MaxOutputConfig,
	NestedRouteInfo,
	ResolvedControlConfig,
	ResolvedTurnBudget,
	ResolvedToolBudget,
	SubagentRunMode,
} from "../../../shared/types.ts";

export interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
	/** Parent session id used by permission-system ask forwarding. */
	parentSessionId?: string;
	currentModelProvider?: string;
	currentModel?: ParentModel;
	/** Optional model-scope enforcement resolved from subagent settings. */
	modelScope?: ModelScopeConfig;
}

export interface AsyncChainParams {
	chain: ChainStep[];
	task?: string;
	attachRoot?: ImportedAsyncRoot & { agent: string; outputName?: string; label?: string };
	resultMode?: Exclude<SubagentRunMode, "single">;
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	thinkingOverridesByFlatIndex?: (AgentConfig["thinking"] | undefined)[];
	progressDir?: string;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	nestedRoute?: NestedRouteInfo;
	acceptance?: AcceptanceInput;
	timeoutMs?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	configToolBudget?: ResolvedToolBudget;
	/** Global cap on simultaneously-running subagent tasks within the async run. */
	globalConcurrencyLimit?: number;
}

export interface AsyncSingleParams {
	agent: string;
	task?: string;
	agentConfig: AgentConfig;
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	sessionFile?: string;
	skills?: string[];
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	outputBaseDir?: string;
	modelOverride?: string;
	thinkingOverride?: AgentConfig["thinking"];
	availableModels?: AvailableModelInfo[];
	maxSubagentDepth: number;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	nestedRoute?: NestedRouteInfo;
	acceptance?: AcceptanceInput;
	timeoutMs?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	configToolBudget?: ResolvedToolBudget;
}

export interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

export interface AsyncRunnerStepBuildParams {
	chain: ChainStep[];
	task?: string;
	attachRoot?: ImportedAsyncRoot & { agent: string; outputName?: string; label?: string };
	resultMode?: SubagentRunMode;
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	thinkingOverridesByFlatIndex?: (AgentConfig["thinking"] | undefined)[];
	progressDir?: string;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	worktreeBaseDir?: string;
	asyncDir: string;
	outputBaseDir?: string;
	validateOutputBindings?: boolean;
	toolBudget?: ResolvedToolBudget;
	configToolBudget?: ResolvedToolBudget;
}

export type AsyncRunnerStepBuildResult =
	| {
		steps: RunnerStep[];
		runnerCwd: string;
		workflowGraph: ReturnType<typeof buildWorkflowGraphSnapshot>;
		eventChain: ChainStep[];
		originalTask?: string;
	}
	| { error: string };
