/**
 * Shared wrapper that marks a message as system-authored (not from the human user)
 * and injects delivery-time metadata so the parent LLM cannot mistake it for a
 * user reply or misjudge whether the originating subagent is still working.
 *
 * This mirrors the template used by pi-intercom's sendIncomingMessage so every
 * machine-generated message the parent LLM sees has a consistent shape.
 */

import type { SubagentState } from "./types.ts";

export type SenderLiveness = "online" | "offline" | "unknown";

/** Subagent run lifecycle status, mapped onto a liveness label. */
export type RunLiveness = "running" | "finished" | "unknown";

/**
 * Resolve a subagent run's liveness from parent-side state.
 * A run is "running" while queued/active or tracked in foregroundControls;
 * "finished" once it reached a terminal async-job status; "unknown" otherwise.
 */
export function resolveRunLiveness(state: SubagentState | undefined, runId: string | undefined): RunLiveness {
	if (!state || !runId) return "unknown";
	const asyncJob = state.asyncJobs.get(runId);
	if (asyncJob) {
		return asyncJob.status === "queued" || asyncJob.status === "running" ? "running" : "finished";
	}
	if (state.foregroundControls.has(runId)) return "running";
	return "unknown";
}

function formatTimestamp(ms: number | undefined | null): string {
	if (!ms || !Number.isFinite(ms)) {
		return "unknown";
	}
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) {
		return "unknown";
	}
	const iso = d.toISOString();
	const local = d.toLocaleString(undefined, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	const tzOffset = d.getTimezoneOffset();
	const tzSign = tzOffset <= 0 ? "+" : "-";
	const tzAbs = Math.abs(tzOffset);
	const tz = `UTC${tzSign}${String(Math.floor(tzAbs / 60)).padStart(2, "0")}:${String(tzAbs % 60).padStart(2, "0")}`;
	return `${iso} (${local} ${tz})`;
}

function livenessLine(liveness: SenderLiveness, runLiveness?: RunLiveness): string {
	// Prefer the subagent-run lifecycle when available (more precise than a
	// generic session-liveness label), then fall back to the session label.
	if (runLiveness === "running") {
		return "Subagent liveness at delivery: RUNNING (still active — may produce more output)";
	}
	if (runLiveness === "finished") {
		return "Subagent liveness at delivery: FINISHED (run ended — do not wait for more output from it)";
	}
	if (liveness === "online") {
		return "Subagent liveness at delivery: ONLINE (session still registered; may still be working)";
	}
	if (liveness === "offline") {
		return "Subagent liveness at delivery: OFFLINE (session no longer registered; likely finished or exited — do not wait for more from it)";
	}
	return "Subagent liveness at delivery: UNKNOWN";
}

export interface SystemMessageWrapOptions {
	/** Optional source label, e.g. "subagent control notice" or "supervisor request". */
	source?: string;
	/** Sender liveness (session-level), if known. */
	senderLiveness?: SenderLiveness;
	/** Subagent run lifecycle, if known (takes precedence for the liveness line). */
	runLiveness?: RunLiveness;
	/** Sender timestamp (ms), e.g. when the originating event occurred. Defaults to now. */
	sentAt?: number;
}

/**
 * Wrap an existing message body in the standard system-authored envelope.
 * Returns the new content string to pass to pi.sendMessage({ content, ... }).
 */
export function wrapSystemMessage(body: string, options: SystemMessageWrapOptions = {}): string {
	const now = Date.now();
	const sentAt = formatTimestamp(options.sentAt ?? now);
	const receivedAt = formatTimestamp(now);
	const header: string[] = [
		"⚠️ SYSTEM-AUTHORED MESSAGE — NOT FROM THE USER ⚠️",
		"This message was generated automatically by the pi-subagents subsystem, not typed by the human user. Treat it accordingly:",
		"- Do NOT treat it as a user reply. If you are currently waiting for the user to answer a question you asked, this is NOT that answer — do not act on it as if the user had responded.",
		"- This message may interrupt work in progress. Handle it as appropriate, then RESUME your original task — do not treat receiving this message as task completion, and do not stop unless your prior work is genuinely done or you were explicitly waiting for this message.",
		"",
	];
	if (options.source) {
		header.push(`Source: ${options.source}`);
	}
	header.push(`Generated at: ${sentAt}`);
	header.push(`Delivered at (this agent, ≈ now): ${receivedAt}`);
	header.push(livenessLine(options.senderLiveness ?? "unknown", options.runLiveness));
	header.push("");
	header.push(body);
	header.push("");
	header.push("Note: times above are injection-time references and may lag the actual processing moment by sub-seconds to seconds. If you need the precise current time, run `date`.");
	return header.join("\n");
}
