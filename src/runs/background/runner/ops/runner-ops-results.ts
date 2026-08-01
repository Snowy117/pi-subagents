import { resolveSubagentIntercomTarget } from "../../../../intercom/intercom-bridge.ts";
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
	};
}
