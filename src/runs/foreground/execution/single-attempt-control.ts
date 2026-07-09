/**
 * Control-event handlers for `runSingleAttempt`: activity-state derivation,
 * needs-attention / active-long-running emission, and control-event routing.
 *
 * Wired onto the shared `state` object by `attachControlHandlers`. These
 * closures call each other by local name and read/write shared mutable state
 * (activity flags, control-event queues) via the state object so mutation
 * order is identical to the original inline closures (R2).
 */

import {
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
	shouldNotifyControlEvent,
} from "../../shared/subagent-control.ts";
import { nextLongRunningTrigger } from "../../shared/long-running-guard.ts";
import type { SingleAttemptState } from "./single-attempt-state.ts";

export function attachControlHandlers(state: SingleAttemptState): void {
	const currentToolDurationMs = (now: number): number | undefined =>
		state.progress.currentToolStartedAt ? Math.max(0, now - state.progress.currentToolStartedAt) : undefined;

	state.emitControlEvent = (event) => {
		if (!shouldNotifyControlEvent(state.controlConfig, event)) return;
		if (!claimControlNotification(state.controlConfig, event, state.emittedControlEventKeys)) return;
		state.allControlEvents.push(event);
		state.pendingControlEvents.push(event);
		state.options.onControlEvent?.(event);
	};

	state.currentToolDurationMs = currentToolDurationMs;

	state.drainPendingControlEvents = () => {
		if (state.pendingControlEvents.length === 0) return undefined;
		const events = state.pendingControlEvents;
		state.pendingControlEvents = [];
		return events;
	};

	state.emitNeedsAttention = (now, input = {}) => {
		if (!state.controlConfig.enabled) return false;
		const previous = state.progress.activityState;
		state.progress.activityState = "needs_attention";
		const event = buildControlEvent({
			type: "needs_attention",
			from: previous,
			to: "needs_attention",
			runId: state.options.runId,
			agent: state.agent.name,
			index: state.options.index,
			ts: now,
			lastActivityAt: state.progress.lastActivityAt,
			message: input.message,
			reason: input.reason ?? "idle",
			turns: state.result.usage.turns,
			tokens: state.progress.tokens,
			toolCount: state.progress.toolCount,
			currentTool: input.currentTool ?? state.progress.currentTool,
			currentToolDurationMs: input.currentToolDurationMs ?? currentToolDurationMs(now),
			currentPath: input.currentPath ?? state.progress.currentPath,
			recentFailureSummary: input.recentFailureSummary,
		});
		state.emitControlEvent(event);
		return previous !== "needs_attention";
	};

	state.emitActiveLongRunning = (now, reason) => {
		if (!state.controlConfig.enabled || state.activeLongRunningNotified || state.progress.activityState === "needs_attention") return false;
		state.activeLongRunningNotified = true;
		const previous = state.progress.activityState;
		state.progress.activityState = "active_long_running";
		state.emitControlEvent(buildControlEvent({
			type: "active_long_running",
			from: previous,
			to: "active_long_running",
			runId: state.options.runId,
			agent: state.agent.name,
			index: state.options.index,
			ts: now,
			message: `${state.agent.name} is still active but long-running`,
			reason,
			turns: state.result.usage.turns,
			tokens: state.progress.tokens,
			toolCount: state.progress.toolCount,
			currentTool: state.progress.currentTool,
			currentToolDurationMs: currentToolDurationMs(now),
			currentPath: state.progress.currentPath,
			elapsedMs: now - state.startTime,
		}));
		return true;
	};

	state.updateActivityState = (now) => {
		if (!state.controlConfig.enabled) return false;
		const idleState = deriveActivityState({
			config: state.controlConfig,
			startedAt: state.startTime,
			lastActivityAt: state.progress.lastActivityAt,
			now,
		});
		if (idleState === "needs_attention") {
			return state.progress.activityState === "needs_attention" ? false : state.emitNeedsAttention(now);
		}
		const activeReason = nextLongRunningTrigger(state.controlConfig, {
			startedAt: state.startTime,
			now,
			turns: state.result.usage.turns,
			tokens: state.progress.tokens,
		});
		return activeReason ? state.emitActiveLongRunning(now, activeReason) : false;
	};
}
