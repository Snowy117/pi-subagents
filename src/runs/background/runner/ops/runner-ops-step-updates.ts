import { shouldAbortForTurnBudget, turnBudgetExceededMessage, turnBudgetSoftNote, turnBudgetState } from "../../../shared/turn-budget.ts";
import { toolBudgetState } from "../../../shared/tool-budget.ts";
import { buildControlEvent } from "../../../shared/subagent-control.ts";
import {
	didMutatingToolFail,
	isMutatingTool,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../../../shared/long-running-guard.ts";
import { stripAcceptanceReport } from "../../../shared/acceptance.ts";
import { extractTextFromContent, extractToolArgsPreview } from "../../../../shared/utils.ts";
import { appendJsonl } from "../event-logging.ts";
import { appendRecentStepOutput, isTerminalAssistantStop } from "../usage-helpers.ts";
import type { TurnBudgetState } from "../../../../shared/types.ts";
import type { ChildEvent } from "../types.ts";
import type { RunnerOps } from "../runner-ops.ts";
import type { RunnerState } from "../runner-state.ts";

export function attachStepUpdateOps(ops: RunnerOps, state: RunnerState): void {
	ops.updateStepModel = (flatIndex: number, model: string | undefined, thinking: string | undefined, now = Date.now()): void => {
		const step = state.statusPayload.steps[flatIndex];
		if (!step) return;
		step.model = model;
		step.thinking = thinking;
		state.statusPayload.lastUpdate = now;
		ops.writeStatusPayload();
	};
	ops.updateStepTurnBudget = (flatIndex: number, turnCount: number, now: number, terminalAssistantStop: boolean): void => {
		const budget = state.config.turnBudget;
		const step = state.statusPayload.steps[flatIndex];
		if (!budget || !step || state.timedOut || state.turnBudgetExceeded || step.turnBudgetExceeded) return;
		if (turnCount < budget.maxTurns) {
			const turnState: TurnBudgetState = { ...budget, outcome: "within-budget", turnCount };
			step.turnBudget = turnState;
			state.statusPayload.turnBudget = turnState;
			return;
		}
		const turnState = turnBudgetState(budget, turnCount, false);
		step.turnBudget = turnState;
		state.statusPayload.turnBudget = turnState;
		if (!step.wrapUpRequested) {
			step.wrapUpRequested = true;
			state.statusPayload.wrapUpRequested = true;
			appendRecentStepOutput(step, [turnBudgetSoftNote(budget, turnCount)]);
		}
		if (!shouldAbortForTurnBudget(budget, turnCount, terminalAssistantStop)) return;
		const exceededState = turnBudgetState(budget, turnCount, true);
		const message = turnBudgetExceededMessage(budget, turnCount);
		step.turnBudget = exceededState;
		step.turnBudgetExceeded = true;
		step.wrapUpRequested = true;
		step.error = message;
		state.turnBudgetExceeded = true;
		state.statusPayload.turnBudget = exceededState;
		state.statusPayload.turnBudgetExceeded = true;
		state.statusPayload.wrapUpRequested = true;
		state.statusPayload.error = message;
		state.statusPayload.lastUpdate = now;
		appendJsonl(state.eventsPath, JSON.stringify({ type: "subagent.step.turn_budget_exceeded", ts: now, runId: state.id, stepIndex: flatIndex, agent: step.agent, turnCount, maxTurns: budget.maxTurns, graceTurns: budget.graceTurns, message }));
		state.activeChildTurnBudgetAborts.get(flatIndex)?.(message, exceededState);
	};
	ops.updateStepFromChildEvent = (flatIndex: number, event: ChildEvent): void => {
		const step = state.statusPayload.steps[flatIndex];
		if (!step) return;
		const now = Date.now();
		state.statusPayload.currentStep = flatIndex;
		if (event.type === "tool_execution_start" && event.toolName) {
			const mutates = isMutatingTool(event.toolName, event.args);
			const currentPath = resolveCurrentPath(event.toolName, event.args);
			step.toolCount = (step.toolCount ?? 0) + 1;
			const configuredToolBudget = state.flatSteps[flatIndex]?.toolBudget;
			if (configuredToolBudget) {
				step.toolBudget = toolBudgetState(configuredToolBudget, step.toolCount);
				state.statusPayload.toolBudget = step.toolBudget;
			}
			step.currentTool = event.toolName;
			step.currentToolArgs = extractToolArgsPreview(event.args ?? {});
			step.currentToolStartedAt = now;
			step.currentPath = currentPath;
			state.pendingToolResults[flatIndex] = { tool: event.toolName, path: currentPath, mutates, startedAt: now };
			state.statusPayload.toolCount = (state.statusPayload.toolCount ?? 0) + 1;
			ops.syncTopLevelCurrentTool();
		} else if (event.type === "tool_execution_end") {
			if (step.currentTool) {
				step.recentTools ??= [];
				step.recentTools.push({ tool: step.currentTool, args: step.currentToolArgs || "", endMs: now });
			}
			step.currentTool = undefined;
			step.currentToolArgs = undefined;
			step.currentToolStartedAt = undefined;
			step.currentPath = undefined;
			ops.syncTopLevelCurrentTool();
		} else if (event.type === "tool_result_end" && event.message) {
			const toolSnapshot = state.pendingToolResults[flatIndex];
			state.pendingToolResults[flatIndex] = undefined;
			const resultText = extractTextFromContent(event.message.content);
			if (toolSnapshot && resultText.includes("Tool budget hard limit reached")) {
				const configuredToolBudget = state.flatSteps[flatIndex]?.toolBudget;
				if (configuredToolBudget) {
					step.toolBudget = toolBudgetState(configuredToolBudget, step.toolCount ?? 0, toolSnapshot.tool);
					step.toolBudgetBlocked = true;
					state.statusPayload.toolBudget = step.toolBudget;
					state.statusPayload.toolBudgetBlocked = true;
				}
			}
			appendRecentStepOutput(step, resultText.split("\n").slice(-10));
			if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
				const failureState = state.mutatingFailureStates[flatIndex]!;
				recordMutatingFailure(failureState, {
					tool: toolSnapshot.tool,
					path: toolSnapshot.path,
					error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
					ts: now,
				}, state.mutatingFailureWindowMs);
				if (state.controlConfig.enabled && shouldEscalateMutatingFailures(failureState, state.controlConfig.failedToolAttemptsBeforeAttention) && step.activityState !== "needs_attention") {
					const previous = step.activityState;
					step.activityState = "needs_attention";
					state.statusPayload.activityState = "needs_attention";
					ops.appendControlEvent(buildControlEvent({
						type: "needs_attention",
						from: previous,
						to: "needs_attention",
						runId: state.id,
						agent: step.agent,
						index: flatIndex,
						ts: now,
						message: `${step.agent} needs attention after repeated mutating tool failures`,
						reason: "tool_failures",
						turns: step.turnCount,
						tokens: step.tokens?.total,
						toolCount: step.toolCount,
						currentTool: toolSnapshot.tool,
						currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
						currentPath: toolSnapshot.path,
						recentFailureSummary: summarizeRecentMutatingFailures(failureState),
					}));
				}
			} else if (toolSnapshot?.mutates) {
				resetMutatingFailureState(state.mutatingFailureStates[flatIndex]!);
			}
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			appendRecentStepOutput(step, stripAcceptanceReport(extractTextFromContent(event.message.content)).split("\n").slice(-10));
			step.turnCount = (step.turnCount ?? 0) + 1;
			const usage = event.message.usage;
			if (usage) {
				const input = usage.input ?? usage.inputTokens ?? 0;
				const output = usage.output ?? usage.outputTokens ?? 0;
				const previousInput = step.tokens?.input ?? 0;
				const previousOutput = step.tokens?.output ?? 0;
				step.tokens = { input: previousInput + input, output: previousOutput + output, total: previousInput + previousOutput + input + output };
				const totalInput = state.statusPayload.totalTokens?.input ?? 0;
				const totalOutput = state.statusPayload.totalTokens?.output ?? 0;
				state.statusPayload.totalTokens = { input: totalInput + input, output: totalOutput + output, total: totalInput + totalOutput + input + output };
			}
			state.statusPayload.turnCount = Math.max(state.statusPayload.turnCount ?? 0, step.turnCount);
			ops.updateStepTurnBudget(flatIndex, step.turnCount, now, isTerminalAssistantStop(event.message));
		}
		ops.syncTopLevelCurrentTool();
		step.lastActivityAt = now;
		state.statusPayload.lastActivityAt = now;
		state.statusPayload.lastUpdate = now;
		ops.maybeEmitActiveLongRunning(flatIndex, now);
		ops.writeStatusPayload();
	};
}
