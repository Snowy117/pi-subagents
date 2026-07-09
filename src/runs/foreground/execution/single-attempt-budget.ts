/**
 * Turn-budget handlers for `runSingleAttempt`: soft wrap-up nudges and the
 * hard abort escalation that signals the child to stop.
 *
 * Wired onto the shared `state` object by `attachBudgetHandlers`. The abort
 * routine signals the shared `state.proc` and schedules the termination /
 * hard-kill timers on the state object; `updateTurnBudget` calls the local
 * `requestTurnBudgetAbort`. Cross-group updates (`fireUpdate`) go through the
 * shared state object so mutation order matches the original (R2).
 */

import { appendRecentOutput } from "./attempt-helpers.ts";
import { trySignalChild } from "../../../shared/post-exit-stdio-guard.ts";
import type { SingleAttemptState } from "./single-attempt-state.ts";
import { shouldAbortForTurnBudget, turnBudgetExceededMessage, turnBudgetSoftNote, turnBudgetState } from "../../shared/turn-budget.ts";

export function attachBudgetHandlers(state: SingleAttemptState): void {
	state.requestTurnBudgetAbort = (turnCount) => {
		const budget = state.options.turnBudget;
		if (!budget || state.result.timedOut || state.result.turnBudgetExceeded || state.interruptedByControl || state.processClosed || state.settled || state.detached) return;
		const message = turnBudgetExceededMessage(budget, turnCount);
		state.result.turnBudgetExceeded = true;
		state.result.wrapUpRequested = true;
		state.result.turnBudget = turnBudgetState(budget, turnCount, true);
		state.result.error = message;
		state.result.finalOutput = message;
		state.progress.status = "failed";
		state.progress.error = message;
		state.progress.durationMs = Date.now() - state.startTime;
		state.fireUpdate();
		trySignalChild(state.proc, "SIGINT");
		state.turnBudgetTerminationTimer = setTimeout(() => {
			if (state.processClosed || state.settled || state.detached || state.result.timedOut) return;
			trySignalChild(state.proc, "SIGTERM");
		}, 1000);
		state.turnBudgetTerminationTimer.unref?.();
		state.turnBudgetHardKillTimer = setTimeout(() => {
			if (state.processClosed || state.settled || state.detached || state.result.timedOut) return;
			trySignalChild(state.proc, "SIGKILL");
		}, 4000);
		state.turnBudgetHardKillTimer.unref?.();
	};

	state.updateTurnBudget = (turnCount, terminalAssistantStop) => {
		const budget = state.options.turnBudget;
		if (!budget || state.result.timedOut || state.result.turnBudgetExceeded) return;
		if (turnCount < budget.maxTurns) {
			state.result.turnBudget = { ...budget, outcome: "within-budget", turnCount };
			return;
		}
		if (!state.turnBudgetSoftReached) {
			state.turnBudgetSoftReached = true;
			state.result.wrapUpRequested = true;
			appendRecentOutput(state.progress, [turnBudgetSoftNote(budget, turnCount)]);
		}
		state.result.turnBudget = turnBudgetState(budget, turnCount, false);
		if (shouldAbortForTurnBudget(budget, turnCount, terminalAssistantStop)) {
			state.requestTurnBudgetAbort(turnCount);
		}
	};
}
