import { resolveSubagentIntercomTarget } from "../../../../intercom/intercom-bridge.ts";
import { createMutatingFailureState } from "../../../shared/long-running-guard.ts";
import { appendJsonl } from "../event-logging.ts";
import type { SingleStepResult } from "../run-single-step.ts";
import type { RunnerOps } from "../runner-ops.ts";
import type { RunnerState } from "../runner-state.ts";

export function attachResultOps(ops: RunnerOps, state: RunnerState): void {
	ops.pausedStepResult = (agent: string): SingleStepResult => ({
		agent,
		task: "",
		output: "Paused after interrupt. Waiting for explicit next action.",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		exitCode: 0,
		interrupted: true,
	});
	ops.timedOutStepResult = (agent: string): SingleStepResult => ({
		agent,
		task: "",
		output: state.timeoutMessage ?? "Subagent timed out.",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		error: state.timeoutMessage ?? "Subagent timed out.",
		exitCode: 1,
		timedOut: true,
	});
	ops.consumePendingAppendRequests = (): void => {
		if (state.statusPayload.mode !== "chain" || state.statusPayload.state !== "running") return;
	};
}
