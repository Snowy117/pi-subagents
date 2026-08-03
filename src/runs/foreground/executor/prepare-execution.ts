import { type AgentConfig } from "../../../agents/agents.ts";
import { applyIntercomBridgeToAgent, resolveIntercomBridge, resolveIntercomSessionTarget } from "../../../intercom/intercom-bridge.ts";
import { getArtifactsDir } from "../../../shared/artifacts.ts";
import { createForkContextResolver } from "../../../shared/fork-context.ts";
import { resolveCurrentSessionId } from "../../../shared/session-identity.ts";
import { type ArtifactConfig, type Details, DEFAULT_ARTIFACT_CONFIG, RESULTS_DIR, TEMP_ROOT_DIR, checkSubagentDepth } from "../../../shared/types.ts";
import { applyForceTopLevelAsyncOverride } from "../../background/top-level-async.ts";
import { createNestedRoute, resolveInheritedNestedRouteFromEnv, resolveNestedRouteFromEnv } from "../../shared/nested-events.ts";
import { resolveControlConfig } from "../../shared/subagent-control.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeRepeatedParallelCounts, resolveAgentDefaultContextPolicy, shouldForkAgent } from "./budget-resolution.ts";
import { countRequestedSubagentSpawns, reserveSubagentSpawns } from "./foreground-state.ts";
import { preflightForkSessionsForStaticTasks, toExecutionErrorResult } from "./fork-helpers.ts";
import { validateExecutionInput } from "./validation.ts";
import { type ExecutionContextData, type ExecutorDeps, type SubagentParamsLike } from "./types.ts";
import { modeForConcreteInvocationCount } from "./mode-helpers.ts";


export function prepareExecution(input: {
	deps: ExecutorDeps;
	ctx: ExtensionContext;
	params: SubagentParamsLike;
	signal: AbortSignal;
}): (AgentToolResult<Details> & { isError?: boolean }) | {
	execData: ExecutionContextData;
	effectiveParams: SubagentParamsLike;
} {
	const { deps, ctx, params, signal } = input;
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
	let inheritedNestedRoute: ReturnType<typeof resolveNestedRouteFromEnv>;
	if (deps.allowMutatingManagementActions === false) {
		try {
			inheritedNestedRoute = resolveNestedRouteFromEnv();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return toExecutionErrorResult(effectiveParams, new Error(`Subagent execution is unavailable in child-safe fanout mode because the inherited lifecycle route is invalid: ${reason}`));
		}
		if (!inheritedNestedRoute || !deps.waitLifecycleRoots) {
			return toExecutionErrorResult(effectiveParams, new Error("Subagent execution is unavailable in child-safe fanout mode because no authorized nested lifecycle root was resolved."));
		}
		const expectedAsyncRoot = path.resolve(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId);
		const expectedResultsDir = path.resolve(RESULTS_DIR, "nested", inheritedNestedRoute.rootRunId);
		if (path.resolve(deps.waitLifecycleRoots.asyncDirRoot) !== expectedAsyncRoot || path.resolve(deps.waitLifecycleRoots.resultsDir) !== expectedResultsDir) {
			return toExecutionErrorResult(effectiveParams, new Error("Subagent execution is unavailable in child-safe fanout mode because its authorized lifecycle roots do not match the inherited nested route."));
		}
	} else {
		inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	}
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
	const nestedRoute = inheritedNestedRoute ?? createNestedRoute(runId);

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
	try {
		preflightForkSessionsForStaticTasks(effectiveParams, contextPolicy, forkSessionFileForTask);
	} catch (error) {
		return toExecutionErrorResult(effectiveParams, error);
	}

	const concreteCount = effectiveParams.tasks?.length ?? 0;
	const foregroundMode = modeForConcreteInvocationCount(concreteCount);
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
		agents,
		runId,
		sessionRoot,
		sessionFileForTask: childSessionFileForTask,
		thinkingOverrideForTask: forkThinkingOverrideForTask,
		artifactConfig,
		artifactsDir,
		effectiveAsync,
		executionMode: foregroundMode,
		controlConfig,
		intercomBridge,
		nestedRoute,
		contextPolicy,
		modelScope,
	};

	return { execData, effectiveParams };
}
