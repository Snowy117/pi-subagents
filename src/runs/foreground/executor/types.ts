/** types (split from subagent-executor.ts; internal-only). */

import { type AgentConfig, type AgentScope } from "../../../agents/agents.ts";
import { type IntercomBridgeState } from "../../../intercom/intercom-bridge.ts";
import { type ArtifactConfig, type Details, type ExtensionConfig, type NestedRouteInfo, type ResolvedControlConfig, type SubagentRunMode, type SubagentState } from "../../../shared/types.ts";
import { type ModelScopeConfig } from "../../shared/model-scope.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorAttentionRequest } from "../../../intercom/native-supervisor-channel/types.ts";


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
	all?: boolean;
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
	handleScheduledRunAction?: (params: SubagentParamsLike, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[]; modelScope?: ModelScopeConfig };
	allowMutatingManagementActions?: boolean;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	waitLifecycleRoots?: { asyncDirRoot: string; resultsDir: string };
	getActionableSupervisorRequests?: () => ReadonlyArray<SupervisorAttentionRequest>;
}


export interface ExecutionContextData {
	params: SubagentParamsLike;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	agents: AgentConfig[];
	runId: string;
	sessionRoot: string;
	sessionFileForTask: (agentName: string, idx?: number) => string | undefined;
	thinkingOverrideForTask: (agentName: string, idx?: number) => AgentConfig["thinking"] | undefined;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	effectiveAsync: boolean;
	executionMode: Exclude<SubagentRunMode, "chain">;
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
