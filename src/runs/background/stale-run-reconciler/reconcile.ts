import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../../shared/atomic-json.ts";
import { RESULTS_DIR, type NestedRunSummary } from "../../../shared/types.ts";
import { nestedSummaryFromAsyncStatus, projectNestedEvents, resolveNestedAsyncDir, writeNestedEvent, type NestedRoute } from "../../shared/nested-events.ts";
import {
	type KillFn,
	type ReconcileAsyncRunOptions,
	type ReconcileAsyncRunResult,
	readStatusFile,
} from "./reconcile-helpers.ts";
import { buildStartedStatus, terminal, terminalStatusFromResult, writeFailedRepair } from "./repair-builders.ts";

export type PidLiveness = "alive" | "dead" | "unknown";

function* nestedRuns(children: NestedRunSummary[] | undefined): Generator<NestedRunSummary> {
	for (const child of children ?? []) {
		yield child;
		yield* nestedRuns(child.children);
		yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
	}
}

export function reconcileNestedAsyncDescendants(route: NestedRoute, options: ReconcileAsyncRunOptions = {}): void {
	const registry = projectNestedEvents(route);
	for (const run of nestedRuns(registry.children)) {
		if (run.state !== "running" && run.state !== "queued") continue;
		const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
		if (!asyncDir) continue;
		const result = reconcileAsyncRun(asyncDir, {
			...options,
			resultsDir: path.join(options.resultsDir ?? RESULTS_DIR, "nested", route.rootRunId),
		});
		const status = result.status;
		if (!status) continue;
		if (!result.repaired && !terminal(status.state)) continue;
		const ts = options.now?.() ?? Date.now();
		writeNestedEvent(route, {
			type: terminal(status.state) ? "subagent.nested.completed" : "subagent.nested.updated",
			ts,
			parentRunId: run.parentRunId,
			parentStepIndex: run.parentStepIndex,
			child: nestedSummaryFromAsyncStatus(status, asyncDir, {
				id: run.id,
				parentRunId: run.parentRunId,
				parentStepIndex: run.parentStepIndex,
				depth: run.depth,
				path: run.path,
				mode: run.mode,
				ts,
			}),
		});
	}
}

export function checkPidLiveness(pid: number, kill: KillFn = process.kill): PidLiveness {
	try {
		kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as NodeJS.ErrnoException).code
			: undefined;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "unknown";
		return "unknown";
	}
}

export function reconcileAsyncRun(asyncDir: string, options: ReconcileAsyncRunOptions = {}): ReconcileAsyncRunResult {
	const now = options.now?.() ?? Date.now();
	const status = readStatusFile(asyncDir);
	const startedStatus = !status && options.startedRun ? buildStartedStatus(asyncDir, options.startedRun, now) : undefined;
	const effectiveStatus = status ?? startedStatus;
	if (!effectiveStatus) return { status: null, repaired: false };
	const statusPath = path.join(asyncDir, "status.json");
	for (const [index, step] of (effectiveStatus.steps ?? []).entries()) {
		const stepRecord = step as Record<string, unknown>;
		if (stepRecord.model !== undefined && typeof stepRecord.model !== "string") throw new Error(`Invalid async status file '${statusPath}': steps[${index}].model must be a string.`);
		if (stepRecord.thinking !== undefined && typeof stepRecord.thinking !== "string") throw new Error(`Invalid async status file '${statusPath}': steps[${index}].thinking must be a string.`);
	}

	const runId = effectiveStatus.runId || path.basename(asyncDir);
	const resultPath = path.join(options.resultsDir ?? RESULTS_DIR, `${runId}.json`);
	if (fs.existsSync(resultPath)) {
		const terminalStatus = effectiveStatus.state === "running" || effectiveStatus.state === "queued"
			? terminalStatusFromResult(effectiveStatus, resultPath, now)
			: undefined;
		if (terminalStatus) {
			writeAtomicJson(path.join(asyncDir, "status.json"), terminalStatus);
			return { status: terminalStatus, repaired: true, resultPath, message: "Existing async result file was used to repair stale running status." };
		}
		return { status: effectiveStatus, repaired: false, resultPath };
	}

	if (effectiveStatus.state !== "running" || typeof effectiveStatus.pid !== "number") {
		return { status: status ?? null, repaired: false, resultPath };
	}

	if (!status) {
		const startedAt = options.startedRun?.startedAt ?? effectiveStatus.startedAt;
		if (now - startedAt < (options.missingStatusGraceMs ?? 1000)) {
			return { status: null, repaired: false, resultPath };
		}
	}

	const liveness = checkPidLiveness(effectiveStatus.pid, options.kill);
	if (liveness !== "dead") {
		const staleAfterMs = options.staleAlivePidMs ?? 24 * 60 * 60 * 1000;
		const lastUpdate = effectiveStatus.lastUpdate ?? effectiveStatus.startedAt;
		if (now - lastUpdate <= staleAfterMs) return { status: status ?? null, repaired: false, resultPath };
		const message = `Async runner process ${effectiveStatus.pid} still has a live PID, but status has not updated for ${now - lastUpdate}ms. Marked run failed by stale-run reconciliation because PID ownership cannot be verified.`;
		return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now, message);
	}

	return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now);
}
