import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { listAsyncRuns, type AsyncRunSummary } from "../async-status.ts";
import {
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type Details,
	type ForegroundResumeRun,
	type SubagentState,
} from "../../../shared/types.ts";

/** States that mean a run is still in flight (not yet resolved). */
const ACTIVE_STATES: ReadonlyArray<AsyncRunSummary["state"]> = ["queued", "running"];

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MIN_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface WaitParams {
	/** Optional run id/prefix to wait for. When omitted, waits across every active run in this session. */
	id?: string;
	/**
	 * When true, block until EVERY active run in this session (or matching `id`)
	 * is terminal. Default false: return as soon as the first run finishes, so a
	 * fleet manager can spawn a replacement and wait again. Ignored when `id`
	 * targets a single run.
	 */
	all?: boolean;
	/** Give up after this many milliseconds. Defaults to 30 minutes. */
	timeoutMs?: number;
}

/** Minimal event-bus surface wait subscribes to (matches pi.events). */
export interface WaitEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface WaitDeps {
	state: SubagentState;
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	pollIntervalMs?: number;
	/** False makes the tool return immediately without blocking active async runs. */
	enabled?: boolean;
	/** Injectable sleep for tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/**
	 * Optional event bus (pi.events). When provided, wait wakes immediately on a
	 * subagent completion/control event instead of waiting out the poll interval;
	 * the poll then remains as a reconciliation fallback (crashed runners, missed
	 * events). Omit in tests that want pure poll behavior.
	 */
	events?: WaitEventBus;
}

export { DEFAULT_POLL_INTERVAL_MS, DEFAULT_TIMEOUT_MS, MIN_POLL_INTERVAL_MS };

/** Bus channels that indicate a run changed state or needs attention. */
const WAKE_CHANNELS = [
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
];

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Sleep up to `ms`, but wake early if a subagent event fires on the bus (or the
 * turn aborts). Returns when the first of those happens. With no bus this is a
 * plain sleep, so the poll interval alone drives progress.
 */
export function waitForWake(ms: number, signal: AbortSignal | undefined, deps: WaitDeps): Promise<void> {
	const sleep = deps.sleep ?? defaultSleep;
	const events = deps.events;
	if (!events) return sleep(ms, signal);
	return new Promise((resolve) => {
		let settled = false;
		const unsubs: Array<() => void> = [];
		const wakeController = new AbortController();
		const done = () => {
			if (settled) return;
			settled = true;
			wakeController.abort();
			signal?.removeEventListener("abort", done);
			for (const u of unsubs) {
				try { u(); } catch { /* best effort */ }
			}
			resolve();
		};
		if (signal?.aborted) {
			done();
			return;
		}
		signal?.addEventListener("abort", done, { once: true });
		for (const channel of WAKE_CHANNELS) {
			try { unsubs.push(events.on(channel, done)); } catch { /* ignore bad channel */ }
		}
		// Poll-interval fallback so we still reconcile even if no event arrives.
		// The local signal cancels that fallback timer when an event wakes us first.
		void sleep(ms, wakeController.signal).then(done);
	});
}

function matchesId(run: AsyncRunSummary, id: string): boolean {
	return run.id === id || run.id.startsWith(id);
}

function foregroundChildState(status: ForegroundResumeRun["children"][number]["status"]): AsyncRunSummary["state"] {
	switch (status) {
		case "detached": return "running";
		case "failed": return "failed";
		case "paused": return "paused";
		default: return "complete";
	}
}

function foregroundRunEffectiveState(run: ForegroundResumeRun): AsyncRunSummary["state"] {
	if (run.children.some((child) => child.status === "detached")) return "running";
	const childStates = run.children.map((child) => foregroundChildState(child.status));
	if (childStates.some((state) => state === "failed")) return "failed";
	if (childStates.some((state) => state === "paused")) return "paused";
	return "complete";
}

function foregroundRunToWaitSummary(run: ForegroundResumeRun): AsyncRunSummary {
	return {
		id: run.runId,
		asyncDir: "",
		state: foregroundRunEffectiveState(run),
		mode: run.mode,
		cwd: run.cwd,
		startedAt: run.updatedAt,
		lastUpdate: run.updatedAt,
		steps: [],
	};
}

function foregroundRunsForWait(state: SubagentState, params: WaitParams): AsyncRunSummary[] {
	if (!state.foregroundRuns?.size) return [];
	let runs = [...state.foregroundRuns.values()];
	if (params.id) {
		const id = params.id;
		runs = runs.filter((run) => run.runId === id || run.runId.startsWith(id));
	}
	return runs.map(foregroundRunToWaitSummary);
}

function mergeUniqueById(runs: AsyncRunSummary[]): AsyncRunSummary[] {
	const seen = new Set<string>();
	const merged: AsyncRunSummary[] = [];
	for (const run of runs) {
		if (seen.has(run.id)) continue;
		seen.add(run.id);
		merged.push(run);
	}
	return merged;
}

/** A running run that has flagged it needs the parent's attention. */
export function needsAttention(run: AsyncRunSummary): boolean {
	return run.activityState === "needs_attention";
}

/** Queued/running runs from this session, including runs that need attention. */
export function activeRunsForSession(params: WaitParams, deps: WaitDeps): AsyncRunSummary[] {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const asyncRuns = listAsyncRuns(asyncDirRoot, {
		states: [...ACTIVE_STATES],
		sessionId: deps.state.currentSessionId ?? undefined,
		resultsDir,
		kill: deps.kill,
		now: deps.now,
	});
	const foregroundRuns = foregroundRunsForWait(deps.state, params).filter((run) => ACTIVE_STATES.includes(run.state));
	const runs = mergeUniqueById([...asyncRuns, ...foregroundRuns]);
	return params.id ? runs.filter((run) => matchesId(run, params.id!)) : runs;
}

/** Runs (from the initial set) currently flagged needs_attention, for reporting. */
export function attentionRunsForSession(params: WaitParams, deps: WaitDeps, initialIds: Set<string>): AsyncRunSummary[] {
	return activeRunsForSession(params, deps).filter((run) => needsAttention(run) && initialIds.has(run.id));
}

/** All runs (any state) for this session, for the final summary. */
export function allRunsForSession(params: WaitParams, deps: WaitDeps): AsyncRunSummary[] {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const asyncRuns = listAsyncRuns(asyncDirRoot, {
		sessionId: deps.state.currentSessionId ?? undefined,
		resultsDir,
		kill: deps.kill,
		now: deps.now,
	});
	const runs = mergeUniqueById([...asyncRuns, ...foregroundRunsForWait(deps.state, params)]);
	return params.id ? runs.filter((run) => matchesId(run, params.id!)) : runs;
}

export function summarizeTerminalRuns(runs: AsyncRunSummary[]): string {
	if (runs.length === 0) return "";
	const counts = { complete: 0, failed: 0, paused: 0 } as Record<string, number>;
	for (const run of runs) {
		if (run.state in counts) counts[run.state] += 1;
	}
	const parts: string[] = [];
	if (counts.complete) parts.push(`${counts.complete} complete`);
	if (counts.failed) parts.push(`${counts.failed} failed`);
	if (counts.paused) parts.push(`${counts.paused} paused`);
	return parts.join(", ");
}

export function result(text: string, isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

export { ACTIVE_STATES };
