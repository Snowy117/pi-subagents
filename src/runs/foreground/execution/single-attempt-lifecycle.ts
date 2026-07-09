/**
 * Lifecycle handlers for `runSingleAttempt`: timer teardown, the
 * terminal-stop grace drain, the intercom detach finalization, and the
 * settle/resolve `finish` routine.
 *
 * These closures are wired onto the shared `state` object by
 * `attachLifecycleHandlers`. They reference each other by local name and
 * reach cross-group state (stdio guard, unsubscribers, resolver) via the
 * shared state object so mutations propagate identically to the original
 * inline-closure semantics (R2).
 */

import { trySignalChild } from "../../../shared/post-exit-stdio-guard.ts";
import type { SingleAttemptState } from "./single-attempt-state.ts";

// If the child emits a terminal assistant stop but never exits, give it a
// short grace period to flush naturally, then clean it up.
const FINAL_STOP_GRACE_MS = 1000;
const HARD_KILL_MS = 3000;

export function attachLifecycleHandlers(state: SingleAttemptState): void {
	state.clearTurnBudgetTimers = () => {
		if (state.turnBudgetTerminationTimer) {
			clearTimeout(state.turnBudgetTerminationTimer);
			state.turnBudgetTerminationTimer = undefined;
		}
		if (state.turnBudgetHardKillTimer) {
			clearTimeout(state.turnBudgetHardKillTimer);
			state.turnBudgetHardKillTimer = undefined;
		}
	};

	state.clearTimeoutTimers = () => {
		if (state.timeoutTimer) {
			clearTimeout(state.timeoutTimer);
			state.timeoutTimer = undefined;
		}
		if (state.timeoutTerminationTimer) {
			clearTimeout(state.timeoutTerminationTimer);
			state.timeoutTerminationTimer = undefined;
		}
		if (state.timeoutHardKillTimer) {
			clearTimeout(state.timeoutHardKillTimer);
			state.timeoutHardKillTimer = undefined;
		}
	};

	state.clearFinalDrainTimers = () => {
		if (state.finalDrainTimer) {
			clearTimeout(state.finalDrainTimer);
			state.finalDrainTimer = undefined;
		}
		if (state.finalHardKillTimer) {
			clearTimeout(state.finalHardKillTimer);
			state.finalHardKillTimer = undefined;
		}
	};

	state.startFinalDrain = () => {
		if (state.childExited || state.finalDrainTimer || state.settled || state.processClosed || state.detached) return;
		state.finalDrainTimer = setTimeout(() => {
			if (state.settled || state.processClosed || state.detached) return;
			const termSent = trySignalChild(state.proc, "SIGTERM");
			if (!termSent) return;
			state.forcedTerminationSignal = true;
			if (!state.cleanTerminalAssistantStopReceived && !state.assistantError) {
				state.result.error = state.result.error ?? `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
			}
			state.finalHardKillTimer = setTimeout(() => {
				if (state.settled || state.processClosed || state.detached) return;
				state.forcedTerminationSignal = trySignalChild(state.proc, "SIGKILL") || state.forcedTerminationSignal;
			}, HARD_KILL_MS);
			state.finalHardKillTimer.unref?.();
		}, FINAL_STOP_GRACE_MS);
		state.finalDrainTimer.unref?.();
	};

	state.finish = (code: number) => {
		if (state.settled) return;
		state.settled = true;
		state.clearFinalDrainTimers();
		state.clearStdioGuard();
		state.clearTimeoutTimers();
		state.clearTurnBudgetTimers();
		if (state.activityTimer) {
			clearInterval(state.activityTimer);
			state.activityTimer = undefined;
		}
		state.unsubscribeIntercomDetach?.();
		state.removeAbortListener?.();
		state.removeInterruptListener?.();
		state.resolve(code);
	};

	state.detachForIntercom = () => {
		state.detached = true;
		state.processClosed = true;
		state.result.detached = true;
		state.result.detachedReason = "intercom coordination";
		state.progress.status = "detached";
		state.progress.durationMs = Date.now() - state.startTime;
		state.result.progressSummary = {
			toolCount: state.progress.toolCount,
			tokens: state.progress.tokens,
			durationMs: state.progress.durationMs,
		};
		state.finish(-2);
	};
}
