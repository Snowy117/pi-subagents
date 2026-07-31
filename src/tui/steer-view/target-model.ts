import * as path from "node:path";
import type { SubagentState } from "../../shared/types.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../shared/types.ts";
import { listAsyncRuns, type AsyncRunSummary } from "../../runs/background/async-status.ts";
import { actionTargetDir } from "../../runs/shared/control-actions/paths.ts";
import { getProjectArtifactsDir } from "../../shared/artifacts.ts";

export type SteerViewTargetKind = "async" | "foreground";

export interface SteerViewTarget {
	key: string;
	kind: SteerViewTargetKind;
	runId: string;
	index: number;
	agent: string;
	status: string;
	active: boolean;
	updatedAt: number;
	transcriptPath?: string;
	outputFile?: string;
	recentOutput?: string;
	sessionFile?: string;
	asyncDir?: string;
	steerInboxDir?: string;
	actionControlDir?: string;
	steerCount?: number;
	trustedRoots?: string[];
}

export interface ListSteerViewTargetsOptions {
	asyncDirRoot?: string;
	resultsDir?: string;
	listRuns?: typeof listAsyncRuns;
}

function targetKey(kind: SteerViewTargetKind, runId: string, index: number): string {
	return `${kind}:${runId}:${index}`;
}

function isActive(status: string): boolean {
	return status === "running" || status === "queued" || status === "pending";
}

function asyncTarget(input: {
	runId: string;
	asyncDir: string;
	index: number;
	agent: string;
	status: string;
	updatedAt?: number;
	transcriptPath?: string;
	recentOutput?: string[];
	sessionFile?: string;
	steerCount?: number;
	cwd?: string;
}): SteerViewTarget {
	return {
		key: targetKey("async", input.runId, input.index),
		kind: "async",
		runId: input.runId,
		index: input.index,
		agent: input.agent,
		status: input.status,
		active: isActive(input.status),
		updatedAt: input.updatedAt ?? 0,
		transcriptPath: input.transcriptPath,
		outputFile: path.join(input.asyncDir, `output-${input.index}.log`),
		recentOutput: input.recentOutput?.at(-1),
		sessionFile: input.sessionFile,
		asyncDir: input.asyncDir,
		actionControlDir: actionTargetDir(path.join(input.asyncDir, "control"), input.index),
		steerCount: input.steerCount,
		trustedRoots: input.cwd ? [getProjectArtifactsDir(input.cwd)] : [],
	};
}

function fromMemory(state: SubagentState): SteerViewTarget[] {
	const targets: SteerViewTarget[] = [];
	for (const job of state.asyncJobs.values()) {
		const steps = job.steps?.length
			? job.steps
			: (job.agents ?? []).map((agent) => ({ agent, status: job.status === "queued" ? "pending" as const : "running" as const }));
		for (const [position, step] of steps.entries()) {
			const index = step.index ?? position;
			targets.push(asyncTarget({
				runId: job.asyncId, asyncDir: job.asyncDir, index, agent: step.agent,
				status: step.status ?? job.status, updatedAt: job.updatedAt,
				transcriptPath: step.transcriptPath, recentOutput: step.recentOutput,
				sessionFile: step.sessionFile, steerCount: step.steerCount,
				cwd: job.cwd,
			}));
		}
	}
	return targets;
}

function fromDisk(runs: AsyncRunSummary[]): SteerViewTarget[] {
	return runs.flatMap((run) => run.steps.map((step) => asyncTarget({
		runId: run.id, asyncDir: run.asyncDir, index: step.index, agent: step.agent,
		status: step.status, updatedAt: run.lastUpdate ?? run.startedAt,
		transcriptPath: step.transcriptPath, recentOutput: step.recentOutput,
		sessionFile: step.sessionFile, steerCount: step.steerCount,
		cwd: run.cwd,
	})));
}

function fromForeground(state: SubagentState): SteerViewTarget[] {
	const targets: SteerViewTarget[] = [];
	for (const child of state.foregroundLiveChildren?.values() ?? []) {
		targets.push({
			key: targetKey("foreground", child.runId, child.index), kind: "foreground",
			runId: child.runId, index: child.index, agent: child.agent, status: child.status,
			active: child.status === "running", updatedAt: child.updatedAt,
			transcriptPath: child.transcriptPath, steerInboxDir: child.steerInboxDir,
			actionControlDir: child.actionControlDir,
			trustedRoots: child.transcriptRoot ? [child.transcriptRoot] : [],
		});
	}
	for (const run of state.foregroundRuns?.values() ?? []) {
		for (const child of run.children) {
			targets.push({
				key: targetKey("foreground", run.runId, child.index), kind: "foreground",
				runId: run.runId, index: child.index, agent: child.agent, status: child.status,
				active: false, updatedAt: child.updatedAt ?? run.updatedAt,
				transcriptPath: child.transcriptPath, recentOutput: child.finalOutput,
				sessionFile: child.sessionFile,
				trustedRoots: [
					...(child.artifactPaths?.transcriptPath === child.transcriptPath ? [path.dirname(child.artifactPaths.transcriptPath)] : []),
					...(child.sessionFile ? [path.dirname(child.sessionFile)] : []),
				],
			});
		}
	}
	return targets;
}

function priority(target: SteerViewTarget, source: "memory" | "disk" | "foreground"): number {
	if (source === "foreground") return target.active ? 50 : 10;
	if (source === "memory") return target.active ? 40 : 20;
	return target.active ? 30 : 15;
}

function mergeTargetMetadata(preferred: SteerViewTarget, fallback: SteerViewTarget): SteerViewTarget {
	return {
		...fallback,
		...preferred,
		transcriptPath: preferred.transcriptPath ?? fallback.transcriptPath,
		outputFile: preferred.outputFile ?? fallback.outputFile,
		recentOutput: preferred.recentOutput ?? fallback.recentOutput,
		sessionFile: preferred.sessionFile ?? fallback.sessionFile,
		asyncDir: preferred.asyncDir ?? fallback.asyncDir,
		steerInboxDir: preferred.steerInboxDir ?? fallback.steerInboxDir,
		actionControlDir: preferred.actionControlDir ?? fallback.actionControlDir,
		steerCount: preferred.steerCount ?? fallback.steerCount,
		trustedRoots: [...new Set([...(preferred.trustedRoots ?? []), ...(fallback.trustedRoots ?? [])])],
	};
}

export function listSteerViewTargets(state: SubagentState, options: ListSteerViewTargetsOptions = {}): SteerViewTarget[] {
	let diskRuns: AsyncRunSummary[] = [];
	try {
		diskRuns = (options.listRuns ?? listAsyncRuns)(options.asyncDirRoot ?? ASYNC_DIR, {
			states: ["queued", "running"], sessionId: state.currentSessionId ?? undefined,
			resultsDir: options.resultsDir ?? RESULTS_DIR,
		});
	} catch {
		// The in-memory registry remains usable when cross-session filesystem discovery fails.
	}
	const merged = new Map<string, { target: SteerViewTarget; priority: number }>();
	for (const [source, targets] of [
		["disk", fromDisk(diskRuns)],
		["memory", fromMemory(state)],
		["foreground", fromForeground(state)],
	] as const) {
		for (const target of targets) {
			const rank = priority(target, source);
			const current = merged.get(target.key);
			if (!current || rank > current.priority || (rank === current.priority && target.updatedAt > current.target.updatedAt)) {
				merged.set(target.key, { target: current ? mergeTargetMetadata(target, current.target) : target, priority: rank });
			} else {
				current.target = mergeTargetMetadata(current.target, target);
			}
		}
	}
	return [...merged.values()].map(({ target }) => target).sort((left, right) =>
		Number(right.active) - Number(left.active)
		|| right.updatedAt - left.updatedAt
		|| left.runId.localeCompare(right.runId)
		|| left.index - right.index);
}

export function hasActiveSteerViewTarget(state: SubagentState, options: ListSteerViewTargetsOptions = {}): boolean {
	return listSteerViewTargets(state, options).some((target) => target.active);
}
