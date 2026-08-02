import * as fs from "node:fs";
import * as path from "node:path";
import { isDynamicParallelStep, isParallelStep, type SequentialStep } from "../../../shared/settings.ts";
import { ASYNC_DIR, RESULTS_DIR, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, TEMP_ROOT_DIR } from "../../../shared/types.ts";
import { nestedResultsPath, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, writeNestedEvent } from "../../shared/nested-events.ts";
import { initialTurnBudgetState } from "../../shared/turn-budget.ts";
import type { AsyncChainParams, AsyncExecutionResult } from "./types.ts";
import { buildAsyncRunnerSteps } from "./step-building.ts";
import { formatAsyncStartError, formatAsyncStartedMessage } from "./start-helpers.ts";
import { piPackageRoot, spawnRunner } from "./runner-spawn.ts";

/**
 * Execute tasks asynchronously (parallel dispatch).
 * Supports a single parallel step (tasks array) or sequential steps.
 */
export function executeAsyncChain(
	id: string,
	params: AsyncChainParams,
): AsyncExecutionResult {
	const {
		chain,
		agents,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFilesByFlatIndex,
		thinkingOverridesByFlatIndex,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		worktreeBaseDir,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
		nestedRoute,
	} = params;
	const resultMode = params.resultMode ?? "parallel";
	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: resultMode, results: [] },
		};
	}

	const built = buildAsyncRunnerSteps(id, {
		chain,
		task: params.task,
		resultMode,
		agents,
		ctx,
		availableModels: params.availableModels,
		cwd,
		chainSkills: params.chainSkills,
		sessionFilesByFlatIndex,
		thinkingOverridesByFlatIndex,
		progressDir: params.progressDir ?? (artifactsDir ? path.join(artifactsDir, "progress", id) : resultMode === "parallel" ? path.join(asyncDir, "progress") : undefined),
		outputBaseDir: artifactsDir ? path.join(artifactsDir, "outputs", id) : undefined,
		dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
		maxSubagentDepth,
		worktreeBaseDir,
		asyncDir,
		toolBudget: params.toolBudget,
		configToolBudget: params.configToolBudget,
	});
	if ("error" in built) {
		try {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup for validation failures before the runner is spawned.
		}
		return formatAsyncStartError(resultMode, built.error);
	}
	const { steps, runnerCwd, workflowGraph, eventChain } = built;
	const deadlineAt = params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined;
	const initialTurnBudget = params.turnBudget ? initialTurnBudgetState(params.turnBudget) : undefined;
	let childTargetIndex = 0;
	const childIntercomTargets = childIntercomTarget ? steps.flatMap((step) => {
		if (!("parallel" in step) && step.importAsyncRoot) {
			childTargetIndex++;
			return [undefined];
		}
		if ("parallel" in step) {
			if (!Array.isArray(step.parallel)) {
				childTargetIndex++;
				return [undefined];
			}
			return step.parallel.map((task) => childIntercomTarget(task.agent, childTargetIndex++));
		}
		return [childIntercomTarget(step.agent, childTargetIndex++)];
	}) : undefined;

	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps,
				resultPath: inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				worktreeBaseDir,
				controlConfig,
				turnBudget: params.turnBudget,
				toolBudget: params.toolBudget,
				controlIntercomTarget,
				childIntercomTargets,
				resultMode,
				dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
				timeoutMs: params.timeoutMs,
				deadlineAt,
				globalConcurrencyLimit: params.globalConcurrencyLimit,
				workflowGraph,
				nestedRoute: nestedRoute ?? inheritedNestedRoute,
				nestedSelf: inheritedNestedRoute && nestedAddress ? {
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
				} : undefined,
			},
			id,
			runnerCwd,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${spawnResult.error}`);
	}

	const chainDesc = chain
		.map((s) =>
			isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : (s as SequentialStep).agent,
		)
		.join(" -> ");

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async ${resultMode}: ${chainDesc} [${id}]`) }],
		details: { mode: resultMode, runId: id, results: [], asyncId: id, asyncDir, workflowGraph, ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}) },
	};
}