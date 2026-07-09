/** create-executor (split from subagent-executor.ts; internal-only). The
 *  subagent executor orchestrator. dispatchAction, prepareExecution and the
 *  nested-foreground event emitter were extracted to keep this concise. */

import { clearPendingForegroundControlNotices } from "../../../extension/control-notices.ts";
import { type Details } from "../../../shared/types.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dispatchAction } from "./action-dispatch.ts";
import { runAsyncPath } from "./async-path.ts";
import { runChainPath } from "./chain-path.ts";
import { resolveRequestedCwd } from "./foreground-state.ts";
import { toExecutionErrorResult, withForkContext } from "./fork-helpers.ts";
import { duplicateSubagentCallResult, omitExecutionModeActionAlias } from "./mode-helpers.ts";
import { createNestedForegroundEventEmitter } from "./nested-foreground-events.ts";
import { runParallelPath } from "./parallel-path.ts";
import { prepareExecution } from "./prepare-execution.ts";
import { runSinglePath } from "./single-path.ts";
import { type ExecutorDeps, type SubagentParamsLike } from "./types.ts";


export function createSubagentExecutor(deps: ExecutorDeps): {
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
} {
	const execute = async (
		_id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>> => {
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundRuns ??= new Map();
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		const requestParams = omitExecutionModeActionAlias(params);
		const requestCwd = resolveRequestedCwd(ctx.cwd, requestParams.cwd);
		const paramsWithResolvedCwd = requestParams.cwd === undefined ? requestParams : { ...requestParams, cwd: requestCwd };
		const actionResult = await dispatchAction({ deps, ctx, params: paramsWithResolvedCwd, requestCwd });
		if (actionResult) return actionResult;
		const prepared = prepareExecution({ deps, ctx, params: paramsWithResolvedCwd, signal, onUpdate });
		if (!("execData" in prepared)) return prepared;
		const { execData, foregroundControl, inheritedNestedRoute, nestedParentAddress, runId, hasTasks, hasChain, hasSingle, foregroundMode, effectiveParams, intercomBridge } = prepared;
		const writeNestedForegroundEvent = createNestedForegroundEventEmitter({
			inheritedNestedRoute,
			nestedParentAddress,
			runId,
			hasTasks,
			hasChain,
			foregroundMode,
			params: effectiveParams,
			intercomBridge,
			foregroundControl,
		});

		let nestedForegroundStarted = false;
		try {
			const asyncResult = runAsyncPath(execData, deps);
			if (asyncResult) return withForkContext(asyncResult, effectiveParams.context);
			if (foregroundControl) {
				writeNestedForegroundEvent("subagent.nested.started");
				nestedForegroundStarted = true;
			}
			if (hasChain && effectiveParams.chain) {
				const result = await runChainPath(execData, deps);
				writeNestedForegroundEvent("subagent.nested.completed", result);
				return withForkContext(result, effectiveParams.context);
			}
			if (hasTasks && effectiveParams.tasks) {
				const result = await runParallelPath(execData, deps);
				writeNestedForegroundEvent("subagent.nested.completed", result);
				return withForkContext(result, effectiveParams.context);
			}
			if (hasSingle) {
				const result = await runSinglePath(execData, deps);
				writeNestedForegroundEvent("subagent.nested.completed", result);
				return withForkContext(result, effectiveParams.context);
			}
		} catch (error) {
			const errorResult = toExecutionErrorResult(effectiveParams, error);
			if (nestedForegroundStarted) writeNestedForegroundEvent("subagent.nested.completed", errorResult);
			return errorResult;
		} finally {
			if (foregroundControl) {
				clearPendingForegroundControlNotices(deps.state, runId);
				deps.state.foregroundControls.delete(runId);
				if (deps.state.lastForegroundControlId === runId) {
					deps.state.lastForegroundControlId = null;
				}
			}
		}

		return withForkContext({
			content: [{ type: "text", text: "Invalid params" }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		}, effectiveParams.context);
	};

	const executeWithSingleDispatchGuard = async (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>> => {
		const requestParams = omitExecutionModeActionAlias(params);
		if (requestParams.action) return execute(id, requestParams, signal, onUpdate, ctx);
		if (deps.state.subagentInProgress === true) return duplicateSubagentCallResult(requestParams);
		deps.state.subagentInProgress = true;
		try {
			return await execute(id, requestParams, signal, onUpdate, ctx);
		} finally {
			deps.state.subagentInProgress = false;
		}
	};

	return { execute: executeWithSingleDispatchGuard };
}
