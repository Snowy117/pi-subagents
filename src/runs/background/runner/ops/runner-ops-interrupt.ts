import { consumeInterruptRequest } from "../../control-channel.ts";
import { appendJsonl } from "../event-logging.ts";
import type { RunnerOps } from "../runner-ops.ts";
import type { RunnerState } from "../runner-state.ts";

export function attachInterruptOps(ops: RunnerOps, state: RunnerState): void {
	ops.interruptRunner = () => {
		consumeInterruptRequest(state.asyncDir);
		if (state.interrupted || state.statusPayload.state !== "running") return;
		state.interrupted = true;
		const now = Date.now();
		state.statusPayload.state = "paused";
		state.currentActivityState = undefined;
		state.statusPayload.activityState = undefined;
		state.statusPayload.lastUpdate = now;
		for (const step of state.statusPayload.steps) {
			if (step.status === "running") {
				step.status = "paused";
				step.activityState = undefined;
				step.endedAt = now;
				step.durationMs = step.startedAt ? now - step.startedAt : undefined;
				step.lastActivityAt = now;
			}
		}
		ops.writeStatusPayload();
		appendJsonl(state.eventsPath, JSON.stringify({
			type: "subagent.run.paused",
			ts: now,
			runId: state.id,
		}));
		ops.interruptNestedAsyncDescendants();
		ops.interruptActiveChildren();
	};
	ops.timeoutRunner = () => {
		if (state.timedOut || state.interrupted || state.statusPayload.state !== "running") return;
		state.timedOut = true;
		const now = Date.now();
		const message = state.timeoutMessage ?? "Subagent timed out.";
		state.statusPayload.state = "failed";
		state.statusPayload.timedOut = true;
		state.statusPayload.error = message;
		state.currentActivityState = undefined;
		state.statusPayload.activityState = undefined;
		state.statusPayload.lastUpdate = now;
		for (const step of state.statusPayload.steps) {
			if (step.status !== "running" && step.status !== "pending") continue;
			step.status = "failed";
			step.error = message;
			step.exitCode = 1;
			step.timedOut = true;
			step.activityState = undefined;
			step.endedAt = now;
			step.durationMs = step.startedAt ? now - step.startedAt : 0;
			step.lastActivityAt = now;
		}
		ops.writeStatusPayload();
		appendJsonl(state.eventsPath, JSON.stringify({
			type: "subagent.run.timed_out",
			ts: now,
			runId: state.id,
			timeoutMs: state.config.timeoutMs,
			deadlineAt: state.config.deadlineAt,
			message,
		}));
		state.timeoutAbortController.abort();
		ops.timeoutNestedAsyncDescendants();
		ops.timeoutActiveChildren();
	};
}
