/** prepare-execution (split from subagent-executor.ts; internal-only).
 *  Extracted from createSubagentExecutor so the orchestrator stays under budget.
 *  Resolves/validates effective params, discovers agents, builds the session
 *  tree and ExecutionContextData + foreground control. On failure returns the
 *  early-exit AgentToolResult the inlined code produced. */

import { type AgentConfig } from "../../../agents/agents.ts";
import { type IntercomBridgeState, applyIntercomBridgeToAgent, resolveIntercomBridge, resolveIntercomSessionTarget } from "../../../intercom/intercom-bridge.ts";
import { getArtifactsDir } from "../../../shared/artifacts.ts";
import { createForkContextResolver } from "../../../shared/fork-context.ts";
import { resolveCurrentSessionId } from "../../../shared/session-identity.ts";
import { type ArtifactConfig, type Details, DEFAULT_ARTIFACT_CONFIG, checkSubagentDepth } from "../../../shared/types.ts";
import { applyForceTopLevelAsyncOverride } from "../../background/top-level-async.ts";
import { createNestedRoute, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv } from "../../shared/nested-events.ts";
import { resolveControlConfig } from "../../shared/subagent-control.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeRepeatedParallelCounts, resolveAgentDefaultContextPolicy, shouldForkAgent } from "./budget-resolution.ts";
import { countRequestedSubagentSpawns, reserveSubagentSpawns } from "./foreground-state.ts";
import { preflightForkSessionsForStaticTasks, toExecutionErrorResult, withForkContext } from "./fork-helpers.ts";
import { validateExecutionInput } from "./validation.ts";
import { type ExecutionContextData, type ExecutorDeps, type SubagentParamsLike } from "./types.ts";


export function prepareExecution(input: {
	deps: ExecutorDeps;
	ctx: ExtensionContext;
	params: SubagentParamsLike;
	signal: AbortSignal;
	onUpdate: ((r: AgentToolResult<Details>) => void) | undefined;
}): (AgentToolResult<Details> & { isError?: boolean }) | {
	execData: ExecutionContextData;
	foregroundControl: { startedAt: number } | undefined;
	inheritedNestedRoute: ReturnType<typeof resolveInheritedNestedRouteFromEnv>;
	nestedParentAddress: ReturnType<typeof resolveNestedParentAddressFromEnv>;
	runId: string;
	hasTasks: boolean;
	hasChain: false;
	hasSingle: false;
	foregroundMode: "single" | "parallel";
	effectiveParams: SubagentParamsLike;
	intercomBridge: IntercomBridgeState;
} {
	const { deps, ctx, params, signal, onUpdate } = input;
	const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth);
	if (blocked) {
		return {
			content: [
				{
					type: "text",
					text:
						`Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
						"You are running at the maximum subagent nesting depth. " +
						"Complete your current task directly without delegating to further subagents.",
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const normalized = normalizeRepeatedParallelCounts(params);
	if (normalized.error) return normalized.error;
	const normalizedParams = normalized.params!;

	let effectiveParams = applyForceTopLevelAsyncOverride(
		normalizedParams,
		depth,
		deps.config.forceTopLevelAsync === true,
	);
	const effectiveCwd = ctx.cwd;
	const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
	deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
	const discovered = deps.discoverAgents(effectiveCwd, "both");
	const discoveredAgents = discovered.agents;
	const modelScope = discovered.modelScope;
	const contextPolicy = resolveAgentDefaultContextPolicy(effectiveParams, discoveredAgents);
	effectiveParams = contextPolicy.params;
	const sessionName = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
	const intercomBridge = resolveIntercomBridge({
		config: deps.config.intercomBridge,
		context: effectiveParams.context,
		orchestratorTarget: sessionName,
	});
	const agents = intercomBridge.active
		? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
		: discoveredAgents;
	const runId = randomUUID().slice(0, 8);
	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedParentAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const nestedRoute = inheritedNestedRoute ?? createNestedRoute(runId);
	const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;

	const validationError = validateExecutionInput(
		effectiveParams,
		agents,
	);
	if (validationError) return validationError;

	let forkSessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
	let forkThinkingOverrideForIndex: (idx?: number) => AgentConfig["thinking"] | undefined = () => undefined;
	try {
		const forkContextResolver = createForkContextResolver(ctx.sessionManager, contextPolicy.usesFork ? "fork" : undefined);
		forkSessionFileForIndex = forkContextResolver.sessionFileForIndex;
		forkThinkingOverrideForIndex = forkContextResolver.thinkingOverrideForIndex;
	} catch (error) {
		return toExecutionErrorResult(effectiveParams, error);
	}
	const effectiveAsync = effectiveParams.async ?? deps.asyncByDefault;
	const controlConfig = resolveControlConfig(deps.config.control);

	const artifactConfig: ArtifactConfig = {
		...DEFAULT_ARTIFACT_CONFIG,
		enabled: effectiveParams.artifacts !== false,
	};
	const artifactsDir = getArtifactsDir(parentSessionFile, effectiveCwd);

	const baseSessionRoot = deps.config.defaultSessionDir
		? path.resolve(deps.expandTilde(deps.config.defaultSessionDir))
		: deps.getSubagentSessionRoot(parentSessionFile);
	const sessionRoot = path.join(baseSessionRoot, runId);
	try {
		fs.mkdirSync(sessionRoot, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return toExecutionErrorResult(
			effectiveParams,
			new Error(`Failed to create session directory '${sessionRoot}': ${message}`),
		);
	}
	const sessionDirForIndex = (idx?: number) =>
		path.join(sessionRoot, `run-${idx ?? 0}`);
	const forkSessionFileForTask = (agentName: string, idx?: number) =>
		shouldForkAgent(contextPolicy, agentName) ? forkSessionFileForIndex(idx) : undefined;
	const forkThinkingOverrideForTask = (agentName: string, idx?: number) =>
		shouldForkAgent(contextPolicy, agentName) ? forkThinkingOverrideForIndex(idx) : undefined;
	const childSessionFileForTask = (agentName: string, idx?: number) =>
		forkSessionFileForTask(agentName, idx) ?? path.join(sessionDirForIndex(idx), "session.jsonl");
	const childSessionFileForIndex = (idx?: number) =>
		path.join(sessionDirForIndex(idx), "session.jsonl");
	try {
		preflightForkSessionsForStaticTasks(effectiveParams, contextPolicy, forkSessionFileForTask);
	} catch (error) {
		return toExecutionErrorResult(effectiveParams, error);
	}

	const onUpdateWithContext = onUpdate
		? (r: AgentToolResult<Details>) => onUpdate(withForkContext(r, effectiveParams.context))
		: undefined;

	const foregroundMode: "single" | "parallel" = hasTasks ? "parallel" : "single";
	const spawnLimitError = reserveSubagentSpawns({
		state: deps.state,
		config: deps.config,
		sessionId: deps.state.currentSessionId,
		requested: countRequestedSubagentSpawns(effectiveParams, deps.config),
		mode: foregroundMode,
	});
	if (spawnLimitError) return spawnLimitError;

	const execData: ExecutionContextData = {
		params: effectiveParams,
		effectiveCwd,
		ctx,
		signal,
		onUpdate: onUpdateWithContext,
		agents,
		runId,
		sessionRoot,
		sessionDirForIndex,
		sessionFileForIndex: childSessionFileForIndex,
		sessionFileForTask: childSessionFileForTask,
		thinkingOverrideForTask: forkThinkingOverrideForTask,
		artifactConfig,
		artifactsDir,
		effectiveAsync,
		controlConfig,
		intercomBridge,
		nestedRoute,
		contextPolicy,
		modelScope,
	};

	const foregroundControl = effectiveAsync
		? undefined
		: {
			runId,
			mode: foregroundMode,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			currentAgent: undefined,
			currentIndex: undefined,
			currentActivityState: undefined,
			nestedRoute,
			interrupt: undefined,
		};
	if (foregroundControl) {
		deps.state.foregroundControls.set(runId, foregroundControl);
		deps.state.lastForegroundControlId = runId;
	}

	return { execData, foregroundControl, inheritedNestedRoute, nestedParentAddress, runId, hasTasks, hasChain: false as const, hasSingle: false as const, foregroundMode, effectiveParams, intercomBridge };
}