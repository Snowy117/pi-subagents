import { deliverInterruptRequest, deliverTimeoutRequest } from "../../control-channel.ts";
import { projectNestedEvents, resolveNestedAsyncDir } from "../../../shared/nested-events.ts";
import type { NestedRunSummary, TurnBudgetState } from "../../../../shared/types.ts";
import { appendJsonl } from "../event-logging.ts";
import type { RunnerOps } from "../runner-ops.ts";
import type { RunnerState } from "../runner-state.ts";

function* nestedRuns(children: NestedRunSummary[] | undefined): Generator<NestedRunSummary> {
	for (const child of children ?? []) {
		yield child;
		yield* nestedRuns(child.children);
		yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
	}
}

export function attachStepControlOps(ops: RunnerOps, state: RunnerState): void {
	ops.registerStepInterrupt = (flatIndex: number, interrupt: (() => void) | undefined): void => {
		if (!interrupt) {
			state.activeChildInterrupts.delete(flatIndex);
			return;
		}
		state.activeChildInterrupts.set(flatIndex, interrupt);
		if (state.interrupted) interrupt();
	};
	ops.registerStepTimeout = (flatIndex: number, interrupt: (() => void) | undefined): void => {
		if (!interrupt) {
			state.activeChildTimeouts.delete(flatIndex);
			return;
		}
		state.activeChildTimeouts.set(flatIndex, interrupt);
		if (state.timedOut) interrupt();
	};
	ops.registerStepTurnBudgetAbort = (flatIndex: number, abort: ((message: string, state?: TurnBudgetState) => void) | undefined): void => {
		if (!abort) {
			state.activeChildTurnBudgetAborts.delete(flatIndex);
			return;
		}
		state.activeChildTurnBudgetAborts.set(flatIndex, abort);
	};
	ops.interruptActiveChildren = (): void => {
		for (const interrupt of [...state.activeChildInterrupts.values()]) interrupt();
	};
	ops.timeoutActiveChildren = (): void => {
		for (const interrupt of [...state.activeChildTimeouts.values()]) interrupt();
	};
	ops.interruptNestedAsyncDescendants = (): void => {
		if (!state.config.nestedRoute) return;
		let registry: ReturnType<typeof projectNestedEvents>;
		try {
			registry = projectNestedEvents(state.config.nestedRoute);
		} catch (error) {
			appendJsonl(state.eventsPath, JSON.stringify({
				type: "subagent.nested.interrupt_failed",
				ts: Date.now(),
				runId: state.id,
				message: error instanceof Error ? error.message : String(error),
			}));
			return;
		}
		for (const run of nestedRuns(registry.children)) {
			if (run.state !== "running" && run.state !== "queued") continue;
			const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(state.config.nestedRoute.rootRunId, run);
			if (!nestedAsyncDir) continue;
			try {
				deliverInterruptRequest({ asyncDir: nestedAsyncDir, pid: run.pid, source: "ancestor-interrupt" });
			} catch (error) {
				appendJsonl(state.eventsPath, JSON.stringify({
					type: "subagent.nested.interrupt_failed",
					ts: Date.now(),
					runId: state.id,
					targetRunId: run.id,
					message: error instanceof Error ? error.message : String(error),
				}));
			}
		}
	};
	ops.timeoutNestedAsyncDescendants = (): void => {
		if (!state.config.nestedRoute) return;
		let registry: ReturnType<typeof projectNestedEvents>;
		try {
			registry = projectNestedEvents(state.config.nestedRoute);
		} catch (error) {
			appendJsonl(state.eventsPath, JSON.stringify({
				type: "subagent.nested.timeout_failed",
				ts: Date.now(),
				runId: state.id,
				message: error instanceof Error ? error.message : String(error),
			}));
			return;
		}
		for (const run of nestedRuns(registry.children)) {
			if (run.state !== "running" && run.state !== "queued") continue;
			const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(state.config.nestedRoute.rootRunId, run);
			if (!nestedAsyncDir) continue;
			try {
				deliverTimeoutRequest({ asyncDir: nestedAsyncDir, pid: run.pid, source: "ancestor-timeout" });
			} catch (error) {
				appendJsonl(state.eventsPath, JSON.stringify({
					type: "subagent.nested.timeout_failed",
					ts: Date.now(),
					runId: state.id,
					targetRunId: run.id,
					message: error instanceof Error ? error.message : String(error),
				}));
			}
		}
	};
}
