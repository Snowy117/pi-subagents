import * as fs from "node:fs";
import * as path from "node:path";
import { type AsyncStatus } from "../../../shared/types.ts";
import { readStatus } from "../../../shared/utils.ts";
import { buildNestedRouteIndex, type NestedRoute } from "../../shared/nested-events.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "../stale-run-reconciler.ts";
import {
	type AsyncRunListOptions,
	type AsyncRunSummary,
	getErrorMessage,
	isAsyncRunDir,
	isNotFoundError,
	sortRuns,
	statusToSummary,
} from "./summary.ts";

export function listAsyncRuns(asyncDirRoot: string, options: AsyncRunListOptions = {}): AsyncRunSummary[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(asyncDirRoot).filter((entry) => isAsyncRunDir(asyncDirRoot, entry));
	} catch (error) {
		if (isNotFoundError(error)) return [];
		throw new Error(`Failed to list async runs in '${asyncDirRoot}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	const allowedStates = options.states ? new Set(options.states) : undefined;
	const runs: AsyncRunSummary[] = [];
	// Route resolution for every run shares a single index built from the
	// nested-events directory, so the per-run lookup is O(1) instead of scanning
	// the directory once per run. The index is built lazily on first use, so
	// load-time restoration (which only wants queued/running runs) skips it
	// entirely when no active runs match.
	let nestedRouteIndex: Map<string, NestedRoute> | undefined;
	const resolveNestedRoute = (rootRunId: string): NestedRoute | undefined => {
		if (!nestedRouteIndex) nestedRouteIndex = buildNestedRouteIndex();
		return nestedRouteIndex.get(rootRunId);
	};
	for (const entry of entries) {
		const asyncDir = path.join(asyncDirRoot, entry);
		const reconciliation = options.reconcile === false
			? undefined
			: reconcileAsyncRun(asyncDir, { resultsDir: options.resultsDir, kill: options.kill, now: options.now });
		const status = (reconciliation?.status ?? readStatus(asyncDir)) as (AsyncStatus & { cwd?: string }) | null;
		if (!status) continue;
		// Filter before the nested-route lookup: the lookup builds an index over
		// the nested-events directory, so deferring it for filtered-out runs keeps
		// restoration at load from scanning that directory when no active runs
		// match.
		if (allowedStates && !allowedStates.has(status.state)) continue;
		if (options.sessionId && status.sessionId !== options.sessionId) continue;
		const nestedWarnings: string[] = [];
		let nestedRoute: NestedRoute | undefined;
		try {
			nestedRoute = resolveNestedRoute(status.runId || path.basename(asyncDir));
			if (nestedRoute) reconcileNestedAsyncDescendants(nestedRoute, { resultsDir: options.resultsDir, kill: options.kill, now: options.now });
		} catch (error) {
			nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
		}
		const summary = statusToSummary(asyncDir, status, nestedWarnings, nestedRoute);
		runs.push(summary);
	}

	const sorted = sortRuns(runs);
	return options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
}
