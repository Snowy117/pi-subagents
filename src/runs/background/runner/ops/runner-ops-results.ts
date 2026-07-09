import { resolveSubagentIntercomTarget } from "../../../../intercom/intercom-bridge.ts";
import { appendRunnerStepsToStatus, consumeChainAppendRequests, countPendingChainAppendRequests } from "../../chain-append.ts";
import { createMutatingFailureState } from "../../../shared/long-running-guard.ts";
import { appendJsonl } from "../event-logging.ts";
import type { SingleStepResult } from "../run-single-step.ts";
import type { RunnerOps } from "../runner-ops.ts";
import type { RunnerState } from "../runner-state.ts";

export function attachResultOps(ops: RunnerOps, state: RunnerState): void {
	ops.pausedStepResult = (agent: string): SingleStepResult => ({
		agent,
		output: "Paused after interrupt. Waiting for explicit next action.",
		exitCode: 0,
		interrupted: true,
	});
	ops.timedOutStepResult = (agent: string): SingleStepResult => ({
		agent,
		output: state.timeoutMessage ?? "Subagent timed out.",
		error: state.timeoutMessage ?? "Subagent timed out.",
		exitCode: 1,
		timedOut: true,
	});
	ops.consumePendingAppendRequests = (): void => {
		if (state.statusPayload.mode !== "chain" || state.statusPayload.state !== "running") return;
		const requests = consumeChainAppendRequests(state.asyncDir);
		if (requests.length === 0) {
			const pendingAppends = countPendingChainAppendRequests(state.asyncDir);
			if ((state.statusPayload.pendingAppends ?? 0) !== pendingAppends) {
				state.statusPayload.pendingAppends = pendingAppends;
				state.statusPayload.lastUpdate = Date.now();
				ops.writeStatusPayload();
			}
			return;
		}
		const appendedSteps = requests.flatMap((request) => request.steps);
		state.config.steps.push(...appendedSteps);
		const now = Date.now();
		const pendingAppends = countPendingChainAppendRequests(state.asyncDir);
		const added = appendRunnerStepsToStatus({
			status: state.statusPayload,
			steps: appendedSteps,
			now,
			pendingAppends,
		});
		state.mutatingFailureStates.push(...Array.from({ length: added.addedFlatSteps }, () => createMutatingFailureState()));
		state.pendingToolResults.push(...Array.from({ length: added.addedFlatSteps }, () => undefined));
		if (state.config.childIntercomTargets) {
			state.config.childIntercomTargets = state.statusPayload.steps.map((statusStep, index) => resolveSubagentIntercomTarget(state.id, statusStep.agent, index));
		}
		ops.writeStatusPayload();
		for (const request of requests) {
			appendJsonl(state.eventsPath, JSON.stringify({
				type: "subagent.chain.append.accepted",
				ts: now,
				runId: state.id,
				requestId: request.id,
				stepCount: request.steps.length,
				pendingAppends,
			}));
		}
	};
}
