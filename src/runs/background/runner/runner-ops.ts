import type { SteerRequest } from "../control-channel.ts";
import type { TurnBudgetState, AcceptanceLedger } from "../../../shared/types.ts";
import { buildControlEvent } from "../../shared/subagent-control.ts";
import type { ChildEvent } from "./types.ts";
import type { SingleStepResult } from "./run-single-step.ts";
import type { RunnerState } from "./runner-state.ts";

/**
 * Bundle of the per-run closures that the original `runSubagent` defined as
 * inline `const` arrow functions. They are assembled onto a single object so
 * that each closure can reference its siblings (e.g. `writeStatusPayload`
 * calls `refreshWorkflowGraph`) via forward references that resolve at call
 * time — never at assembly time.
 *
 * Every closure mutates the shared `RunnerState` by reference, exactly as the
 * inline originals captured their enclosing `let` bindings by reference.
 */
export interface RunnerOps {
	emitNestedSelfEvent: (type: "subagent.nested.updated" | "subagent.nested.completed") => void;
	refreshWorkflowGraph: () => void;
	writeStatusPayload: () => void;
	registerStepInterrupt: (flatIndex: number, interrupt: (() => void) | undefined) => void;
	registerStepTimeout: (flatIndex: number, interrupt: (() => void) | undefined) => void;
	registerStepTurnBudgetAbort: (flatIndex: number, abort: ((message: string, state?: TurnBudgetState) => void) | undefined) => void;
	interruptActiveChildren: () => void;
	timeoutActiveChildren: () => void;
	interruptNestedAsyncDescendants: () => void;
	timeoutNestedAsyncDescendants: () => void;
	pausedStepResult: (agent: string) => SingleStepResult;
	timedOutStepResult: (agent: string) => SingleStepResult;
	consumePendingAppendRequests: () => void;
	markDynamicGraphGroup: (stepIndex: number, status: "completed" | "failed" | "running", error?: string, acceptance?: AcceptanceLedger) => void;
	stepOutputActivityAt: (index: number) => number;
	appendControlEvent: (event: ReturnType<typeof buildControlEvent>) => void;
	syncTopLevelCurrentTool: () => void;
	maybeEmitActiveLongRunning: (flatIndex: number, now: number) => boolean;
	deliverSteerRequest: (request: SteerRequest) => void;
	flushPendingStepSteers: (flatIndex: number) => void;
	updateStepModel: (flatIndex: number, model: string | undefined, thinking: string | undefined, now?: number) => void;
	updateStepTurnBudget: (flatIndex: number, turnCount: number, now: number, terminalAssistantStop: boolean) => void;
	updateStepFromChildEvent: (flatIndex: number, event: ChildEvent) => void;
	updateRunnerActivityState: (now: number) => boolean;
	interruptRunner: () => void;
	timeoutRunner: () => void;
}

/**
 * Assemble all per-run closures onto a single `RunnerOps` object. The attach
 * helpers each populate a cohesive group; because closures only invoke their
 * siblings at *runtime* (during the step loop, long after this returns),
 * forward references through `ops.*` are safe.
 */
export function createRunnerOps(state: RunnerState): RunnerOps {
	const ops = {} as RunnerOps;
	attachStatusOps(ops, state);
	attachStepControlOps(ops, state);
	attachResultOps(ops, state);
	attachActivityOps(ops, state);
	attachStepUpdateOps(ops, state);
	attachInterruptOps(ops, state);
	return ops;
}

// Attach helpers (defined in sibling modules, imported below) populate the
// `ops` object in place. They are declared here and the implementations live
// in dedicated cohesive modules to keep each file under the line budget.
import { attachStatusOps } from "./ops/runner-ops-status.ts";
import { attachStepControlOps } from "./ops/runner-ops-step-control.ts";
import { attachResultOps } from "./ops/runner-ops-results.ts";
import { attachActivityOps } from "./ops/runner-ops-activity.ts";
import { attachStepUpdateOps } from "./ops/runner-ops-step-updates.ts";
import { attachInterruptOps } from "./ops/runner-ops-interrupt.ts";
