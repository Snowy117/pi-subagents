/**
 * Streaming-event handlers for `runSingleAttempt`: the stdout update plumbing
 * (`fireUpdate` / `emitUpdateSnapshot`) and the JSON line processor
 * `processLine`, which is the largest single closure and the heart of the
 * attempt — it advances progress, usage, tool/turn budgets, mutating-failure
 * tracking, and activity state for every child event.
 *
 * Wired onto the shared `state` object by `attachEventHandlers`. These
 * closures reach cross-group handlers (activity state, turn budget, final
 * drain, needs-attention) through the shared state object so event-processing
 * order and mutation order are byte-for-byte the original (R2).
 */

import type { Message } from "@earendil-works/pi-ai";
import { appendRecentOutput, snapshotProgress, snapshotResult } from "./attempt-helpers.ts";
import {
	didMutatingToolFail,
	isMutatingTool,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../../shared/long-running-guard.ts";
import type { SingleAttemptState } from "./single-attempt-state.ts";
import { toolBudgetState } from "../../shared/tool-budget.ts";
import { extractTextFromContent, extractToolArgsPreview, getFinalOutput } from "../../../shared/utils.ts";

export function attachEventHandlers(state: SingleAttemptState): void {
	state.emitUpdateSnapshot = (text: string) => {
		if (!state.options.onUpdate || state.processClosed) return;
		const progressSnapshot = snapshotProgress(state.progress);
		const resultSnapshot = snapshotResult(state.result, progressSnapshot);
		const controlEvents = state.drainPendingControlEvents();
		state.options.onUpdate({
			content: [{ type: "text", text }],
			details: {
				mode: "single",
				results: [resultSnapshot],
				progress: [progressSnapshot],
				controlEvents,
			},
		});
	};

	state.fireUpdate = () => {
		if (!state.options.onUpdate || state.processClosed) return;
		state.progress.durationMs = Date.now() - state.startTime;
		const output = (state.result.timedOut || state.result.turnBudgetExceeded) && state.result.finalOutput ? state.result.finalOutput : getFinalOutput(state.result.messages ?? []);
		state.emitUpdateSnapshot(output || "(running...)");
	};

	state.processLine = (line: string) => {
		if (!line.trim()) return;
		state.jsonlWriter.writeLine(line);
		let evt: { type?: string; message?: Message; toolName?: string; args?: unknown };
		try {
			evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
		} catch {
			state.shared.transcriptWriter?.writeStdoutLine(line);
			// Non-JSON stdout lines are expected; only structured events are parsed.
			return;
		}
		state.shared.transcriptWriter?.writeChildEvent(evt);

		const now = Date.now();
		state.progress.durationMs = now - state.startTime;
		state.progress.lastActivityAt = now;
		state.updateActivityState(now);

		if (evt.type === "tool_execution_start") {
			const toolArgs = evt.args && typeof evt.args === "object" && !Array.isArray(evt.args)
				? evt.args as Record<string, unknown>
				: {};
			if (state.options.allowIntercomDetach && (evt.toolName === "intercom" || evt.toolName === "contact_supervisor")) {
				state.intercomStarted = true;
			}
			state.progress.toolCount++;
			if (state.options.toolBudget) {
				state.result.toolBudget = toolBudgetState(state.options.toolBudget, state.progress.toolCount);
			}
			state.progress.currentTool = evt.toolName;
			state.progress.currentToolArgs = extractToolArgsPreview(toolArgs);
			state.progress.currentToolStartedAt = now;
			state.progress.currentPath = resolveCurrentPath(evt.toolName, toolArgs);
			const mutates = isMutatingTool(evt.toolName, toolArgs);
			state.observedMutationAttempt = state.observedMutationAttempt || mutates;
			state.pendingToolResult = { tool: evt.toolName ?? "tool", path: state.progress.currentPath, mutates, startedAt: now };
			state.fireUpdate();
		}

		if (evt.type === "tool_execution_end") {
			if (state.progress.currentTool) {
				state.progress.recentTools.push({
					tool: state.progress.currentTool,
					args: state.progress.currentToolArgs || "",
					endMs: now,
				});
			}
			state.progress.currentTool = undefined;
			state.progress.currentToolArgs = undefined;
			state.progress.currentToolStartedAt = undefined;
			state.progress.currentPath = undefined;
			state.fireUpdate();
		}

		if (evt.type === "message_end" && evt.message) {
			(state.result.messages ??= []).push(evt.message);
			if (evt.message.role === "assistant") {
				state.result.usage.turns++;
				state.progress.turnCount = state.result.usage.turns;
				const stopReason = (evt.message as { stopReason?: string }).stopReason;
				const hasToolCall = Array.isArray(evt.message.content)
					&& evt.message.content.some((part) => (part as { type?: string }).type === "toolCall");
				const terminalAssistantStop = stopReason === "stop" && !hasToolCall;
				state.updateTurnBudget(state.result.usage.turns, terminalAssistantStop);
				const u = evt.message.usage;
				if (u) {
					state.result.usage.input += u.input || 0;
					state.result.usage.output += u.output || 0;
					state.result.usage.cacheRead += u.cacheRead || 0;
					state.result.usage.cacheWrite += u.cacheWrite || 0;
					state.result.usage.cost += u.cost?.total || 0;
					state.progress.tokens = state.result.usage.input + state.result.usage.output;
				}
				if (!state.result.model && evt.message.model) state.result.model = evt.message.model;
				if (evt.message.errorMessage) state.assistantError = evt.message.errorMessage;
				const assistantText = extractTextFromContent(evt.message.content);
				appendRecentOutput(state.progress, assistantText.split("\n").slice(-10));
				// Final assistant message: start the exit drain window.
				if (terminalAssistantStop) {
					if (!evt.message.errorMessage && assistantText.trim()) state.assistantError = undefined;
					state.cleanTerminalAssistantStopReceived ||= !evt.message.errorMessage;
					state.startFinalDrain();
				}
			}
			state.updateActivityState(now);
			state.fireUpdate();
		}

		if (evt.type === "tool_result_end" && evt.message) {
			(state.result.messages ??= []).push(evt.message);
			const resultText = extractTextFromContent(evt.message.content);
			if (state.options.toolBudget && state.pendingToolResult && resultText.includes("Tool budget hard limit reached")) {
				state.result.toolBudgetBlocked = true;
				state.result.toolBudget = toolBudgetState(state.options.toolBudget, state.progress.toolCount, state.pendingToolResult.tool);
			}
			appendRecentOutput(state.progress, resultText.split("\n").slice(-10));
			const toolSnapshot = state.pendingToolResult;
			state.pendingToolResult = undefined;
			if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
				recordMutatingFailure(state.mutatingFailures, {
					tool: toolSnapshot.tool,
					path: toolSnapshot.path,
					error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
					ts: now,
				}, state.mutatingFailureWindowMs);
				if (shouldEscalateMutatingFailures(state.mutatingFailures, state.controlConfig.failedToolAttemptsBeforeAttention)) {
					state.emitNeedsAttention(now, {
						message: `${state.agent.name} needs attention after repeated mutating tool failures`,
						reason: "tool_failures",
						currentTool: toolSnapshot.tool,
						currentPath: toolSnapshot.path,
						currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
						recentFailureSummary: summarizeRecentMutatingFailures(state.mutatingFailures),
					});
				}
			} else if (toolSnapshot?.mutates) {
				resetMutatingFailureState(state.mutatingFailures);
			}
			state.fireUpdate();
		}
	};
}
