/** nested-foreground-events (split from subagent-executor.ts; internal-only).
 *  Factory extracting createSubagentExecutor's writeNestedForegroundEvent
 *  closure so the orchestrator stays concise. Pure move: the returned
 *  callback is the same closure, just parameterised. */

import { type IntercomBridgeState, resolveSubagentIntercomTarget } from "../../../intercom/intercom-bridge.ts";
import { type SequentialStep, isParallelStep } from "../../../shared/settings.ts";
import { type Details } from "../../../shared/types.ts";
import { resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, writeNestedEvent } from "../../shared/nested-events.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type SubagentParamsLike } from "./types.ts";


export function createNestedForegroundEventEmitter(input: {
	inheritedNestedRoute: ReturnType<typeof resolveInheritedNestedRouteFromEnv>;
	nestedParentAddress: ReturnType<typeof resolveNestedParentAddressFromEnv>;
	runId: string;
	hasTasks: boolean;
	hasChain: boolean;
	params: SubagentParamsLike;
	intercomBridge: IntercomBridgeState;
	foregroundControl: { startedAt: number } | undefined;
	foregroundMode: "single" | "parallel" | "chain";
}): (type: "subagent.nested.started" | "subagent.nested.completed", result?: AgentToolResult<Details> & { isError?: boolean }) => void {
	const { inheritedNestedRoute, nestedParentAddress, runId, hasTasks, hasChain, params, intercomBridge, foregroundControl, foregroundMode } = input;
	return (type, result) => {
	if (!inheritedNestedRoute || !nestedParentAddress) return;
	const now = Date.now();
	const details = result?.details;
	const state = type === "subagent.nested.started"
		? "running"
		: details?.results.some((child) => child.interrupted || child.detached)
			? "paused"
			: result?.isError || details?.results.some((child) => child.exitCode !== 0)
				? "failed"
				: "complete";
	const errorText = result?.isError
		? result.content.find((item) => item.type === "text")?.text
		: undefined;
	const agentsForSummary = hasTasks && params.tasks
		? params.tasks.map((task) => task.agent)
		: hasChain && params.chain
			? params.chain.flatMap((step) => isParallelStep(step) ? step.parallel.map((task) => task.agent) : [(step as SequentialStep).agent])
			: params.agent ? [params.agent] : [];
	const leafIntercomTarget = intercomBridge.active && agentsForSummary[0]
		? resolveSubagentIntercomTarget(runId, agentsForSummary[0], 0)
		: undefined;
	try {
		writeNestedEvent(inheritedNestedRoute, {
			type,
			ts: now,
			parentRunId: nestedParentAddress.parentRunId,
			parentStepIndex: nestedParentAddress.parentStepIndex,
			child: {
				id: runId,
				parentRunId: nestedParentAddress.parentRunId,
				parentStepIndex: nestedParentAddress.parentStepIndex,
				depth: nestedParentAddress.depth,
				path: nestedParentAddress.path,
				ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
				leafIntercomTarget,
				intercomTarget: leafIntercomTarget,
				ownerState: state === "running" ? "live" : "gone",
				mode: foregroundMode,
				state,
				agent: agentsForSummary[0],
				agents: agentsForSummary,
				startedAt: foregroundControl?.startedAt ?? now,
				...(state !== "running" ? { endedAt: now } : {}),
				lastUpdate: now,
				...(details?.totalCost ? { totalCost: details.totalCost } : {}),
				...(errorText ? { error: errorText } : {}),
				...(details?.results.length ? { steps: details.results.map((child) => ({
					agent: child.agent,
					status: child.interrupted || child.detached ? "paused" : child.exitCode === 0 ? "complete" : "failed",
					...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
					...(child.error ? { error: child.error } : {}),
				})) } : {}),
			},
		});
	} catch (error) {
		console.error("Failed to emit nested foreground status event:", error);
	}
	};
}
