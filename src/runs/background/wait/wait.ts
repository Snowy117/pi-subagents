import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type AsyncRunSummary } from "../async-status.ts";
import { type Details } from "../../../shared/types.ts";
import { formatDuration } from "../../../shared/formatters.ts";
import {
	ACTIVE_STATES,
	type WaitDeps,
	type WaitParams,
	activeRunsForSession,
	allRunsForSession,
	attentionRunsForSession,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_TIMEOUT_MS,
	MIN_POLL_INTERVAL_MS,
	needsAttention,
	result,
	summarizeTerminalRuns,
	waitForWake,
} from "./helpers.ts";

/**
 * Block until the targeted async runs finish, the timeout elapses, or the turn
 * is aborted. Resolves with a short human-readable summary either way.
 */
export async function waitForSubagents(
	params: WaitParams,
	signal: AbortSignal | undefined,
	deps: WaitDeps,
): Promise<AgentToolResult<Details>> {
	if (deps.enabled === false) {
		return result("Wait tool is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED; returning immediately without blocking background subagent runs. Active runs keep going, and you can inspect them with subagent({ action: \"status\" }) or wait for completion notifications.");
	}
	const now = deps.now ?? Date.now;
	const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	const timeoutMs = params.timeoutMs !== undefined && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
	const startedAt = now();

	// A single named run always means "wait until that one is done", regardless
	// of `all`. Otherwise `all` decides: true → every run terminal; false → the
	// first run to finish.
	const waitForAll = params.id ? true : params.all === true;

	let active: AsyncRunSummary[];
	try {
		active = activeRunsForSession(params, deps);
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}

	if (active.length === 0) {
		const finished = params.id
			? `No active run matched "${params.id}". Nothing to wait for.`
			: "No active async runs in this session. Nothing to wait for.";
		return result(finished);
	}
	if (params.id) {
		const exact = active.filter((run) => run.id === params.id);
		if (exact.length === 1) active = exact;
		else if (active.length > 1) {
			return result(`Ambiguous async run id prefix "${params.id}" matched ${active.length} active runs: ${active.map((run) => run.id).join(", ")}. Pass a longer id.`, true);
		}
	}
	const waitParams = params.id ? { ...params, id: active[0]!.id } : params;

	// The set of runs in flight when the wait began. In first-completion mode we
	// return as soon as any of THESE leaves the active set — a run spawned by a
	// concurrent turn shouldn't satisfy this wait.
	const initialIds = new Set(active.map((run) => run.id));
	const initialCount = initialIds.size;
	let pending = active.filter((run) => !needsAttention(run));

	const done = (active: AsyncRunSummary[], attention: AsyncRunSummary[]): boolean => {
		// A run needing attention always breaks the wait, in either mode: the
		// caller has to act on it (nudge/resume/interrupt) and blocking longer
		// helps nothing.
		if (attention.length > 0) return true;
		if (waitForAll) return active.every((run) => !initialIds.has(run.id));
		// First-completion: satisfied once any initially-pending run is gone.
		const stillActiveInitial = active.filter((run) => initialIds.has(run.id));
		return stillActiveInitial.length < initialCount;
	};

	let attention = active.filter((run) => needsAttention(run));

	while (!done(pending, attention)) {
		if (signal?.aborted) {
			const stillActive = pending.map((run) => `${run.id} (${run.state})`).join(", ");
			return result(`Wait aborted after ${formatDuration(now() - startedAt)}. Still active: ${stillActive}.`, true);
		}
		if (now() - startedAt >= timeoutMs) {
			const stillActive = pending.map((run) => `${run.id} (${run.state})`).join(", ");
			return result(
				`Wait timed out after ${formatDuration(timeoutMs)} with ${pending.length} run(s) still active: ${stillActive}. `
					+ `The runs are detached and keep going; call wait again or inspect with subagent({ action: "status" }).`,
				true,
			);
		}
		await waitForWake(pollIntervalMs, signal, deps);
		try {
			active = activeRunsForSession(waitParams, deps);
			pending = active.filter((run) => !needsAttention(run));
			attention = attentionRunsForSession(waitParams, deps, initialIds);
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), true);
		}
	}

	// Report how the finished run(s) came out. In first-completion mode, name the
	// runs from the initial set that are now terminal.
	let terminalSummary = "";
	let finishedCount = 0;
	try {
		const allNow = allRunsForSession(waitParams, deps);
		const terminal = allNow.filter((run) => !ACTIVE_STATES.includes(run.state) && initialIds.has(run.id));
		finishedCount = terminal.length;
		terminalSummary = summarizeTerminalRuns(terminal);
	} catch {
		// Summary is best-effort; the important part is that the wait resolved.
	}

	const attentionNote = attention.length > 0
		? ` ${attention.length} run(s) need attention: ${attention.map((r) => r.id).join(", ")} — inspect with subagent({ action: "status" }) then nudge/resume/interrupt.`
		: "";

	const stillRunning = pending.filter((run) => initialIds.has(run.id)).length;
	const elapsed = formatDuration(now() - startedAt);
	const outcome = terminalSummary ? ` Outcome: ${terminalSummary}.` : "";

	if (waitForAll) {
		const scope = params.id ? `run "${params.id}"` : `${initialCount} async run(s)`;
		const status = attention.length > 0 ? "attention required" : "done";
		const notificationText = attention.length > 0
			? "Relevant completion/control events have been observed; inspect status if the notification is not visible yet."
			: "Completion events have been observed; inspect status if the notification is not visible yet.";
		return result(
			`Waited ${elapsed} for ${scope}; ${status}.${outcome}${attentionNote} ${notificationText}`,
		);
	}

	// First-completion mode.
	const remainder = stillRunning > 0
		? ` ${stillRunning} run(s) still in flight — call wait again to catch the next one.`
		: attention.length > 0
			? " No other runs are waitable until attention is handled."
			: " No runs remain in flight.";
	const progress = attention.length > 0 && finishedCount === 0
		? `${attention.length} of ${initialCount} run(s) need attention`
		: `${finishedCount} of ${initialCount} run(s) finished`;
	const notificationText = finishedCount > 0
		? " Completion events for the finished run(s) have been observed; inspect status if the notification is not visible yet."
		: " Relevant control events have been observed; inspect status if the notification is not visible yet.";
	return result(
		`Waited ${elapsed}; ${progress}.${outcome}${attentionNote}${remainder}${notificationText}`,
	);
}
