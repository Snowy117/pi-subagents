/** parallel-path-helpers (extracted from parallel-path.ts; internal-only). */

import { resolveSubagentIntercomTarget } from "../../../intercom/intercom-bridge.ts";
import { type ModelInfo } from "../../../shared/model-info.ts";
import { type AgentProgress, type ControlEvent, type Details, type ResolvedToolBudget, type SingleResult, type SubagentState } from "../../../shared/types.ts";
import { getSingleResultOutput } from "../../../shared/utils.ts";
import { DEFAULT_GLOBAL_CONCURRENCY_LIMIT, Semaphore, aggregateParallelOutputs } from "../../shared/parallel-utils.ts";
import { type WorktreeSetup } from "../../shared/worktree.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { buildParallelWorktreeSuffix } from "./parallel-helpers.ts";
import { type ExecutionContextData, type ExecutorDeps, type ForegroundParallelRunInput, type TaskParam } from "./types.ts";


type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;


export interface ForegroundParallelRunInputLocals {
	taskTexts: string[];
	modelOverrides: (string | undefined)[];
	behaviors: ForegroundParallelRunInput["behaviors"];
	maxSubagentDepths: number[];
	availableModels: ModelInfo[];
	onControlEvent: (event: ControlEvent) => void;
	childIntercomTarget: typeof resolveSubagentIntercomTarget | undefined;
	foregroundControl: ForegroundControl | undefined;
	parallelConcurrency: number;
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	worktreeSetup: WorktreeSetup | undefined;
	deadlineAt: number | undefined;
	parallelProgressDir: string;
	outputBaseDir: string;
	toolBudgets: (ResolvedToolBudget | undefined)[];
	parallelProgressPrecreated: boolean;
	firstProgressIndex: number;
}


export function buildForegroundParallelRunInput(
	data: ExecutionContextData,
	deps: ExecutorDeps,
	locals: ForegroundParallelRunInputLocals,
): ForegroundParallelRunInput {
	const { params, effectiveCwd, agents, ctx, signal, runId, sessionDirForIndex, sessionFileForIndex, sessionFileForTask, thinkingOverrideForTask, shareEnabled, artifactConfig, artifactsDir, onUpdate, controlConfig } = data;
	const {
		taskTexts,
		modelOverrides,
		behaviors,
		maxSubagentDepths,
		availableModels,
		onControlEvent,
		childIntercomTarget,
		foregroundControl,
		parallelConcurrency,
		liveResults,
		liveProgress,
		worktreeSetup,
		deadlineAt,
		parallelProgressDir,
		outputBaseDir,
		toolBudgets,
		parallelProgressPrecreated,
		firstProgressIndex,
	} = locals;
	const tasks = params.tasks!;
	return {
		tasks,
		taskTexts,
		agents,
		ctx,
		state: deps.state,
		persistentChildRegistry: deps.persistentChildRegistry,
		intercomEvents: deps.pi.events,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		outputBaseDir,
		maxOutput: params.maxOutput,
		paramsCwd: effectiveCwd,
		progressDir: parallelProgressDir,
		availableModels,
		modelScope: data.modelScope,
		modelOverrides,
		behaviors,
		firstProgressIndex: parallelProgressPrecreated ? -1 : firstProgressIndex,
		controlConfig,
		onControlEvent,
		childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
		orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
		foregroundControl,
		concurrencyLimit: parallelConcurrency,
		globalSemaphore: new Semaphore(deps.config.globalConcurrencyLimit ?? DEFAULT_GLOBAL_CONCURRENCY_LIMIT),
		maxSubagentDepths,
		liveResults,
		liveProgress,
		onUpdate,
		worktreeSetup,
		timeoutMs: data.timeoutMs,
		deadlineAt,
		turnBudget: data.turnBudget,
		toolBudgets,
	};
}


export function buildParallelSuccessResult(
	results: SingleResult[],
	details: Details,
	opts: { worktreeSetup?: WorktreeSetup; artifactsDir: string; tasks: TaskParam[]; backgroundRequestedWhileClarifying: boolean },
): AgentToolResult<Details> {
	const worktreeSuffix = buildParallelWorktreeSuffix(opts.worktreeSetup, opts.artifactsDir, opts.tasks);
	const ok = results.filter((result) => result.exitCode === 0).length;
	const downgradeNote = opts.backgroundRequestedWhileClarifying ? " (background requested, but clarify kept this run foreground)" : "";
	const aggregatedOutput = aggregateParallelOutputs(
		results.map((result) => ({
			agent: result.agent,
			output: result.truncation?.text || getSingleResultOutput(result),
			exitCode: result.exitCode,
			error: result.error,
			timedOut: result.timedOut,
		})),
		(i, agent) => `=== Task ${i + 1}: ${agent} ===`,
	);
	const summary = `${ok}/${results.length} succeeded${downgradeNote}`;
	const fullContent = worktreeSuffix
		? `${summary}\n\n${aggregatedOutput}\n\n${worktreeSuffix}`
		: `${summary}\n\n${aggregatedOutput}`;
	return {
		content: [{ type: "text", text: fullContent }],
		details,
	};
}
