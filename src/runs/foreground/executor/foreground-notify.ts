/** foreground-notify (split from subagent-executor.ts; internal-only). */

import { deliverSubagentResultIntercomEvent, resolveSubagentResultStatus } from "../../../intercom/result-intercom.ts";
import { type IntercomEventBus, type SingleResult, type SubagentRunMode, type SubagentState, SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../../shared/types.ts";


/**
 * Foreground-detached children are tracked only in memory, so the
 * result-watcher (which drives async completion notifications) never sees
 * them. Emit its completion event here so the parent is notified, and
 * deliver a best-effort intercom result receipt mirroring the async path.
 */
export function notifyForegroundDetachedCompletion(input: {
	events: IntercomEventBus;
	state: SubagentState;
	runId: string;
	mode: SubagentRunMode;
	index: number;
	result: SingleResult;
	orchestratorIntercomTarget?: string;
}): void {
	const sessionId = input.state.currentSessionId;
	const success = input.result.exitCode === 0 && !input.result.error;
	const summary = input.result.finalOutput ?? input.result.error ?? "";
	input.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
		id: input.runId,
		agent: input.result.agent,
		success,
		summary,
		...(input.result.exitCode !== undefined ? { exitCode: input.result.exitCode } : {}),
		...(input.result.interrupted ? { state: "paused" } : {}),
		timestamp: Date.now(),
		...(input.result.progressSummary?.durationMs !== undefined ? { durationMs: input.result.progressSummary.durationMs } : {}),
		...(input.result.sessionFile ? { sessionFile: input.result.sessionFile } : {}),
		sessionId,
		taskIndex: input.index,
		...(input.mode === "single" ? { totalTasks: 1 } : {}),
	});
	if (input.orchestratorIntercomTarget) {
		const status = resolveSubagentResultStatus({ exitCode: input.result.exitCode, interrupted: input.result.interrupted, success });
		void deliverSubagentResultIntercomEvent(input.events, {
			to: input.orchestratorIntercomTarget,
			runId: input.runId,
			mode: input.mode,
			source: "foreground",
			children: [{
				agent: input.result.agent,
				status,
				summary: summary.trim() || "(no output)",
				index: input.index,
				...(input.result.sessionFile ? { sessionPath: input.result.sessionFile } : {}),
			}],
		}).catch(() => undefined);
	}
}
