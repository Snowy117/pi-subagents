/** types (split from subagent-executor.ts; internal-only). */

import { type AgentConfig, type AgentScope } from "../../../agents/agents.ts";
import { type IntercomBridgeState } from "../../../intercom/intercom-bridge.ts";
import { type ModelInfo } from "../../../shared/model-info.ts";
import { type AgentProgress, type ArtifactConfig, type ControlEvent, type Details, type ExtensionConfig, type IntercomEventBus, type MaxOutputConfig, type NestedRouteInfo, type ResolvedControlConfig, type SingleResult, type SubagentState } from "../../../shared/types.ts";
import { type ModelScopeConfig } from "../../shared/model-scope.ts";
import { Semaphore } from "../../shared/parallel-utils.ts";
import { type WorktreeSetup } from "../../shared/worktree.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";


export const MUTATING_MANAGEMENT_ACTIONS = new Set(["create", "update", "delete", "eject", "disable", "enable", "reset"]);


export interface TaskParam {
	agent: string;
	task: string;
	count?: number;
	progress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
}


export interface SubagentParamsLike {
	action?: string;
	id?: string;
	index?: number;
	view?: "fleet" | "transcript";
	lines?: number;
	message?: string;
	config?: unknown;
	schedule?: string;
	scheduleName?: string;
	tasks?: TaskParam[];
	concurrency?: number;
	worktree?: boolean;
	context?: "fresh" | "fork";
	async?: boolean;
	artifacts?: boolean;
	includeProgress?: boolean;
}


export interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: ExtensionConfig;
	asyncByDefault: boolean;
	/** Parent-side registry for resident RPC children (Option B); created per extension activation. */
	persistentChildRegistry?: import("../../persistent/rpc-child-registry.ts").RpcChildRegistry;
	handleScheduledRunAction?: (params: SubagentParamsLike, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>;
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[]; modelScope?: ModelScopeConfig };
	allowMutatingManagementActions?: boolean;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}


export interface ExecutionContextData {
	params: SubagentParamsLike;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	agents: AgentConfig[];
	runId: string;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	sessionFileForTask: (agentName: string, idx?: number) => string | undefined;
	thinkingOverrideForTask: (agentName: string, idx?: number) => AgentConfig["thinking"] | undefined;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	effectiveAsync: boolean;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	nestedRoute?: NestedRouteInfo;
	contextPolicy: AgentDefaultContextPolicy;
	modelScope?: ModelScopeConfig;
}


export interface AgentDefaultContextPolicy {
	params: SubagentParamsLike;
	contextForAgent(agentName: string): "fresh" | "fork";
	usesFork: boolean;
}


export interface ForegroundParallelRunInput {
	tasks: TaskParam[];
	taskTexts: string[];
	agents: AgentConfig[];
	ctx: ExtensionContext;
	state: SubagentState;
	intercomEvents: IntercomEventBus;
	signal: AbortSignal;
	runId: string;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex: (idx?: number) => string | undefined;
	sessionFileForTask: (agentName: string, idx?: number) => string | undefined;
	thinkingOverrideForTask: (agentName: string, idx?: number) => AgentConfig["thinking"] | undefined;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	outputBaseDir: string;
	maxOutput?: MaxOutputConfig;
	paramsCwd: string;
	progressDir: string;
	maxSubagentDepths: number[];
	availableModels: ModelInfo[];
	modelScope?: ModelScopeConfig;
	modelOverrides: (string | undefined)[];
	firstProgressIndex: number;
	controlConfig: ResolvedControlConfig;
	onControlEvent?: (event: ControlEvent) => void;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
	concurrencyLimit: number;
	globalSemaphore?: Semaphore;
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	onUpdate?: (r: AgentToolResult<Details>) => void;
	worktreeSetup?: WorktreeSetup;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
}