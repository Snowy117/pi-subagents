import * as fs from "node:fs";
import * as path from "node:path";
import { type ActivityState, type AsyncJobStep, type AsyncParallelGroupStatus, type AsyncStatus, type CostSummary, type NestedRunSummary, type SubagentRunMode, type TokenUsage, type TurnBudgetState } from "../../../shared/types.ts";
import { attachRootChildrenToSteps, type NestedRoute, projectNestedEvents } from "../../shared/nested-events.ts";
import { normalizeParallelGroups } from "../parallel-groups.ts";

export interface AsyncRunStepSummary {
	index: number;
	agent: string;
	label?: string;
	phase?: string;
	outputName?: string;
	structured?: boolean;
	status: AsyncJobStep["status"];
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools?: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput?: string[];
	turnCount?: number;
	toolCount?: number;
	steerCount?: number;
	lastSteerAt?: number;
	durationMs?: number;
	tokens?: TokenUsage;
	totalCost?: CostSummary;
	skills?: string[];
	model?: string;
	thinking?: string;
	attemptedModels?: string[];
	error?: string;
	timedOut?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	children?: NestedRunSummary[];
}

export interface AsyncRunSummary {
	id: string;
	asyncDir: string;
	sessionId?: string;
	state: "queued" | "running" | "complete" | "failed" | "paused";
	error?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	steerCount?: number;
	lastSteerAt?: number;
	mode: SubagentRunMode;
	cwd?: string;
	startedAt: number;
	lastUpdate?: number;
	endedAt?: number;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	currentStep?: number;
	chainStepCount?: number;
	pendingAppends?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps: AsyncRunStepSummary[];
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	totalCost?: CostSummary;
	sessionFile?: string;
	nestedChildren?: NestedRunSummary[];
	nestedWarnings?: string[];
}

export interface AsyncRunListOptions {
	states?: Array<AsyncRunSummary["state"]>;
	sessionId?: string;
	limit?: number;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	reconcile?: boolean;
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function isAsyncRunDir(root: string, entry: string): boolean {
	const entryPath = path.join(root, entry);
	try {
		return fs.statSync(entryPath).isDirectory();
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw new Error(`Failed to inspect async run path '${entryPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function outputFileMtime(outputFile: string | undefined): number | undefined {
	if (!outputFile) return undefined;
	try {
		return fs.statSync(outputFile).mtimeMs;
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to inspect async output file '${outputFile}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function deriveAsyncActivityState(asyncDir: string, status: AsyncStatus): { activityState?: ActivityState; lastActivityAt?: number } {
	if (status.state !== "running") return { activityState: status.activityState, lastActivityAt: status.lastActivityAt };
	const outputPath = status.outputFile ? (path.isAbsolute(status.outputFile) ? status.outputFile : path.join(asyncDir, status.outputFile)) : undefined;
	const currentStep = typeof status.currentStep === "number" ? status.steps?.[status.currentStep] : undefined;
	return {
		activityState: status.activityState,
		lastActivityAt: status.lastActivityAt ?? outputFileMtime(outputPath) ?? currentStep?.lastActivityAt ?? currentStep?.startedAt ?? status.startedAt,
	};
}

export function statusToSummary(asyncDir: string, status: AsyncStatus & { cwd?: string }, nestedWarnings: string[] = [], nestedRoute?: NestedRoute): AsyncRunSummary {
	if (status.sessionId !== undefined && typeof status.sessionId !== "string") {
		throw new Error(`Invalid async status '${path.join(asyncDir, "status.json")}': sessionId must be a string.`);
	}
	const { activityState, lastActivityAt } = deriveAsyncActivityState(asyncDir, status);
	const steps = status.steps ?? [];
	const chainStepCount = status.chainStepCount ?? steps.length;
	const parallelGroups = normalizeParallelGroups(status.parallelGroups, steps.length, chainStepCount);
	let nestedChildren: NestedRunSummary[] = [];
	if (nestedWarnings.length === 0 && nestedRoute) {
		try {
			// The route is resolved by the caller via buildNestedRouteIndex, so this
			// avoids a fresh scan of the nested-events directory per run.
			nestedChildren = projectNestedEvents(nestedRoute)?.children ?? [];
		} catch (error) {
			nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
		}
	}
	const summarizedSteps = steps.map((step, index) => {
		const stepActivityState = step.activityState;
		const stepLastActivityAt = step.lastActivityAt;
		return {
			index,
			agent: step.agent,
			...(step.label ? { label: step.label } : {}),
			...(step.phase ? { phase: step.phase } : {}),
			...(step.outputName ? { outputName: step.outputName } : {}),
			...(step.structured ? { structured: step.structured } : {}),
			status: step.status,
			...(stepActivityState ? { activityState: stepActivityState } : {}),
			...(stepLastActivityAt ? { lastActivityAt: stepLastActivityAt } : {}),
			...(step.currentTool ? { currentTool: step.currentTool } : {}),
			...(step.currentToolArgs ? { currentToolArgs: step.currentToolArgs } : {}),
			...(step.currentToolStartedAt ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
			...(step.currentPath ? { currentPath: step.currentPath } : {}),
			...(step.recentTools ? { recentTools: step.recentTools.map((tool) => ({ ...tool })) } : {}),
			...(step.recentOutput ? { recentOutput: [...step.recentOutput] } : {}),
			...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
			...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
			...(step.steerCount !== undefined ? { steerCount: step.steerCount } : {}),
			...(step.lastSteerAt !== undefined ? { lastSteerAt: step.lastSteerAt } : {}),
			...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
			...(step.tokens ? { tokens: step.tokens } : {}),
			...(step.totalCost ? { totalCost: step.totalCost } : {}),
			...(step.skills ? { skills: step.skills } : {}),
			...(step.model ? { model: step.model } : {}),
			...(step.thinking ? { thinking: step.thinking } : {}),
			...(step.attemptedModels ? { attemptedModels: step.attemptedModels } : {}),
			...(step.error ? { error: step.error } : {}),
			...(step.timedOut !== undefined ? { timedOut: step.timedOut } : {}),
			...(step.turnBudget ? { turnBudget: step.turnBudget } : {}),
			...(step.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: step.turnBudgetExceeded } : {}),
			...(step.wrapUpRequested !== undefined ? { wrapUpRequested: step.wrapUpRequested } : {}),
			...(step.children?.length ? { children: step.children } : {}),
		};
	});
	attachRootChildrenToSteps(status.runId || path.basename(asyncDir), summarizedSteps, nestedChildren);
	return {
		id: status.runId || path.basename(asyncDir),
		asyncDir,
		...(status.sessionId ? { sessionId: status.sessionId } : {}),
		state: status.state,
		...(status.error ? { error: status.error } : {}),
		activityState,
		lastActivityAt,
		currentTool: status.currentTool,
		currentToolStartedAt: status.currentToolStartedAt,
		currentPath: status.currentPath,
		turnCount: status.turnCount,
		toolCount: status.toolCount,
		steerCount: status.steerCount,
		lastSteerAt: status.lastSteerAt,
		mode: status.mode,
		cwd: status.cwd,
		startedAt: status.startedAt,
		lastUpdate: status.lastUpdate,
		endedAt: status.endedAt,
		...(status.timeoutMs !== undefined ? { timeoutMs: status.timeoutMs } : {}),
		...(status.deadlineAt !== undefined ? { deadlineAt: status.deadlineAt } : {}),
		...(status.timedOut !== undefined ? { timedOut: status.timedOut } : {}),
		...(status.turnBudget ? { turnBudget: status.turnBudget } : {}),
		...(status.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: status.turnBudgetExceeded } : {}),
		...(status.wrapUpRequested !== undefined ? { wrapUpRequested: status.wrapUpRequested } : {}),
		currentStep: status.currentStep,
		...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
		...(status.pendingAppends !== undefined ? { pendingAppends: status.pendingAppends } : {}),
		...(parallelGroups.length ? { parallelGroups } : {}),
		steps: summarizedSteps,
		...(nestedChildren.length ? { nestedChildren } : {}),
		...(nestedWarnings.length ? { nestedWarnings } : {}),
		...(status.sessionDir ? { sessionDir: status.sessionDir } : {}),
		...(status.outputFile ? { outputFile: status.outputFile } : {}),
		...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
		...(status.totalCost ? { totalCost: status.totalCost } : {}),
		...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
	};
}

export function sortRuns(runs: AsyncRunSummary[]): AsyncRunSummary[] {
	const rank = (state: AsyncRunSummary["state"]): number => {
		switch (state) {
			case "running": return 0;
			case "queued": return 1;
			case "failed": return 2;
			case "paused": return 2;
			case "complete": return 3;
		}
	};
	return [...runs].sort((a, b) => {
		const byState = rank(a.state) - rank(b.state);
		if (byState !== 0) return byState;
		const aTime = a.lastUpdate ?? a.endedAt ?? a.startedAt;
		const bTime = b.lastUpdate ?? b.endedAt ?? b.startedAt;
		return bTime - aTime;
	});
}
