/** create-executor (split from subagent-executor.ts; internal-only). The
 *  subagent executor orchestrator. dispatchAction, prepareExecution and the
 *  nested-foreground event emitter were extracted to keep this concise. */

import { type Details } from "../../../shared/types.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dispatchAction } from "./action-dispatch.ts";
import { runAsyncPath } from "./async-path.ts";
import { toExecutionErrorResult, withForkContext } from "./fork-helpers.ts";
import { duplicateSubagentCallResult } from "./mode-helpers.ts";
import { prepareExecution } from "./prepare-execution.ts";
import { type ExecutorDeps, type SubagentParamsLike } from "./types.ts";
import { createCompletionBroker } from "../../background/completion-broker.ts";


export function createSubagentExecutor(deps: ExecutorDeps): {
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		_onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
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
		deps.state.foregroundLiveChildren ??= new Map();
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		deps.state.completionBroker ??= createCompletionBroker();
		const actionResult = await dispatchAction({ deps, ctx, params, requestCwd: ctx.cwd, signal });
		if (actionResult) return actionResult;
		const prepared = prepareExecution({ deps, ctx, params, signal });
		if (!("execData" in prepared)) return prepared;
		const { execData, effectiveParams } = prepared;
		try {
			const result = await runAsyncPath(execData, deps);
			return withForkContext(result, effectiveParams.context);
		} catch (error) {
			const errorResult = toExecutionErrorResult(effectiveParams, error);
			return errorResult;
		}
	};

	const executeWithSingleDispatchGuard = async (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>> => {
		if (params.action) return execute(id, params, signal, onUpdate, ctx);
		if (deps.state.subagentInProgress === true) return duplicateSubagentCallResult(params);
		deps.state.subagentInProgress = true;
		try {
			return await execute(id, params, signal, onUpdate, ctx);
		} finally {
			deps.state.subagentInProgress = false;
		}
	};

	return { execute: executeWithSingleDispatchGuard };
}
