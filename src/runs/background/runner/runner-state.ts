import * as path from "node:path";
import { initialTurnBudgetState } from "../../shared/turn-budget.ts";
import { initialToolBudgetState } from "../../shared/tool-budget.ts";
import { DEFAULT_CONTROL_CONFIG } from "../../shared/subagent-control.ts";
import { createMutatingFailureState } from "../../shared/long-running-guard.ts";
import {
	DEFAULT_GLOBAL_CONCURRENCY_LIMIT,
	Semaphore,
	flattenSteps,
	isDynamicRunnerGroup,
	isParallelGroup,
	type RunnerSubagentStep,
} from "../../shared/parallel-utils.ts";
import { resolveAsyncStepTranscriptPath } from "./parallel-helpers.ts";
import { SUBAGENT_LIFECYCLE_ARTIFACT_VERSION } from "../../../shared/types.ts";
import type {
	ActivityState,
	ArtifactConfig,
	ChainOutputMap,
	MaxOutputConfig,
	ResolvedControlConfig,
	TokenUsage,
	TurnBudgetState,
} from "../../../shared/types.ts";
import type {
	RunnerStatusPayload,
	RunnerStatusStep,
	StepResult,
	SubagentRunConfig,
} from "./types.ts";
import type { SteerRequest } from "../control-channel.ts";

export type StepOutcome = { nextFlatIndex: number; breakLoop: boolean };

/** Snapshot of a pending mutating tool execution tracked across start/end events. */
export interface PendingToolResult {
	tool: string;
	path?: string;
	mutates: boolean;
	startedAt?: number;
}

/**
 * Shared mutable state for a single `runSubagent` invocation.
 *
 * Every closure and step branch operates on this object by reference, so that
 * mutations performed in one module are immediately visible everywhere else.
 * This preserves the by-reference capture semantics the original inline
 * closures relied on (e.g. `interrupted`, `timedOut`, `statusPayload`).
 */
export interface RunnerState {
	/** The originating run configuration (its `steps` array is mutated in place
	 *  by chain-append handling). */
	config: SubagentRunConfig;
	// --- config-derived convenience aliases (consts) ---
	id: string;
	cwd: string;
	placeholder: string;
	taskIndex?: number;
	totalTasks?: number;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	overallStartTime: number;
	shareEnabled: boolean;
	asyncDir: string;
	statusPath: string;
	eventsPath: string;
	logPath: string;
	controlConfig: ResolvedControlConfig;
	timeoutMessage: string | undefined;
	timeoutAbortController: AbortController;
	sessionEnabled: boolean;
	flatSteps: RunnerSubagentStep[];
	initialFlatStepCount: number;
	mutatingFailureWindowMs: number;
	globalSemaphore: Semaphore;
	// --- mutable state (originally `let` or mutated-in-place objects) ---
	statusPayload: RunnerStatusPayload;
	previousOutput: string;
	outputs: ChainOutputMap;
	results: StepResult[];
	activeChildInterrupts: Map<number, () => void>;
	activeChildTimeouts: Map<number, () => void>;
	activeChildTurnBudgetAborts: Map<number, (message: string, state?: TurnBudgetState) => void>;
	pendingStepSteers: SteerRequest[];
	interrupted: boolean;
	currentActivityState: ActivityState | undefined;
	activityTimer: NodeJS.Timeout | undefined;
	timeoutTimer: NodeJS.Timeout | undefined;
	timedOut: boolean;
	turnBudgetExceeded: boolean;
	previousCumulativeTokens: TokenUsage;
	latestSessionFile: string | undefined;
	emittedControlEventKeys: Set<string>;
	activeLongRunningSteps: Set<number>;
	mutatingFailureStates: Array<ReturnType<typeof createMutatingFailureState>>;
	pendingToolResults: Array<PendingToolResult | undefined>;
}

/** Result of building the initial status payload + derived step metadata. */
interface InitialStatus {
	initialStatusSteps: RunnerStatusStep[];
	parallelGroups: Array<{ start: number; count: number; stepIndex: number }>;
	initialFlatStepCount: number;
	flatSteps: RunnerSubagentStep[];
	sessionEnabled: boolean;
}

/**
 * Build the flat list of initial status steps + parallel-group index ranges
 * from the run's step definitions. Extracted verbatim from the original
 * `runSubagent` body (pure derivation, no mutation of shared state).
 */
function buildInitialStatus(config: SubagentRunConfig, id: string, artifactsDir: string | undefined, artifactConfig: Partial<ArtifactConfig> | undefined): InitialStatus {
	const steps = config.steps;
	const flatSteps = flattenSteps(steps);
	const initialFlatStepCount = flatSteps.length;
	const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
	const initialStatusSteps: RunnerStatusStep[] = [];
	let flatStepCount = 0;
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		if (isParallelGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: step.parallel.length, stepIndex });
			for (const task of step.parallel) {
				const taskFlatIndex = flatStepCount;
				const transcriptPath = resolveAsyncStepTranscriptPath({ artifactsDir, artifactConfig, runId: id, agent: task.agent, flatIndex: taskFlatIndex, flatStepCount: initialFlatStepCount });
				initialStatusSteps.push({
					agent: task.agent,
					phase: task.phase,
					label: task.label,
					outputName: task.outputName,
					structured: task.structured,
					status: "pending",
					...(task.toolBudget ? { toolBudget: initialToolBudgetState(task.toolBudget) } : {}),
					...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
					...(transcriptPath ? { transcriptPath } : {}),
					skills: task.skills,
					model: task.model,
					thinking: task.thinking,
					attemptedModels: task.modelCandidates && task.modelCandidates.length > 0 ? task.modelCandidates : task.model ? [task.model] : undefined,
					recentTools: [],
					recentOutput: [],
				});
				flatStepCount++;
			}
		} else if (isDynamicRunnerGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: 1, stepIndex });
			initialStatusSteps.push({
				agent: `expand:${step.parallel.agent}`,
				phase: step.phase ?? step.parallel.phase,
				label: step.label ?? step.parallel.label ?? `Dynamic fanout (${step.collect.as})`,
				outputName: step.collect.as,
				structured: Boolean(step.collect.outputSchema),
				status: "pending",
				...(step.parallel.toolBudget ? { toolBudget: initialToolBudgetState(step.parallel.toolBudget) } : {}),
				recentTools: [],
				recentOutput: [],
			});
			flatStepCount++;
		} else {
			const stepFlatIndex = flatStepCount;
			const transcriptPath = resolveAsyncStepTranscriptPath({ artifactsDir, artifactConfig, runId: id, agent: step.agent, flatIndex: stepFlatIndex, flatStepCount: initialFlatStepCount });
			initialStatusSteps.push({
				agent: step.agent,
				phase: step.phase,
				label: step.label,
				outputName: step.outputName,
				structured: step.structured,
				status: "pending",
				...(step.toolBudget ? { toolBudget: initialToolBudgetState(step.toolBudget) } : {}),
				...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
				...(transcriptPath ? { transcriptPath } : {}),
				skills: step.skills,
				model: step.model,
				thinking: step.thinking,
				attemptedModels: step.modelCandidates && step.modelCandidates.length > 0 ? step.modelCandidates : step.model ? [step.model] : undefined,
				recentTools: [],
				recentOutput: [],
			});
			flatStepCount++;
		}
	}
	const sessionEnabled = Boolean(config.sessionDir)
		|| config.share === true
		|| flatSteps.some((step) => Boolean(step.sessionFile));
	return { initialStatusSteps, parallelGroups, initialFlatStepCount, flatSteps, sessionEnabled };
}

/**
 * Initialize the full shared state for a run. Mirrors exactly the variable
 * declarations at the top of the original `runSubagent`, including the
 * initial status payload construction.
 */
export function createRunnerState(config: SubagentRunConfig): RunnerState {
	const { id, cwd, placeholder, taskIndex, totalTasks, maxOutput, artifactsDir, artifactConfig } = config;
	const overallStartTime = Date.now();
	const asyncDir = config.asyncDir;
	const statusPath = path.join(asyncDir, "status.json");
	const eventsPath = path.join(asyncDir, "events.jsonl");
	const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
	const controlConfig = config.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	const timeoutMessage = config.timeoutMs !== undefined ? `Subagent timed out after ${config.timeoutMs}ms.` : undefined;
	const timeoutAbortController = new AbortController();
	const globalSemaphore = new Semaphore(config.globalConcurrencyLimit ?? DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
	const initial = buildInitialStatus(config, id, artifactsDir, artifactConfig);
	const statusPayload: RunnerStatusPayload = {
		lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
		runId: id,
		...(config.sessionId ? { sessionId: config.sessionId } : {}),
		mode: config.resultMode ?? (initial.flatSteps.length > 1 ? "chain" : "single"),
		state: "running",
		lastActivityAt: overallStartTime,
		startedAt: overallStartTime,
		lastUpdate: overallStartTime,
		...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
		...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
		...(config.turnBudget ? { turnBudget: initialTurnBudgetState(config.turnBudget) } : {}),
		...(config.toolBudget ? { toolBudget: initialToolBudgetState(config.toolBudget) } : {}),
		pid: process.pid,
		cwd,
		currentStep: 0,
		chainStepCount: config.steps.length,
		parallelGroups: initial.parallelGroups,
		workflowGraph: config.workflowGraph,
		steps: initial.initialStatusSteps,
		artifactsDir,
		sessionDir: config.sessionDir,
		outputFile: path.join(asyncDir, "output-0.log"),
	};
	return {
		config,
		id,
		cwd,
		placeholder,
		taskIndex,
		totalTasks,
		maxOutput,
		artifactsDir,
		artifactConfig,
		overallStartTime,
		shareEnabled: config.share === true,
		asyncDir,
		statusPath,
		eventsPath,
		logPath,
		controlConfig,
		timeoutMessage,
		timeoutAbortController,
		sessionEnabled: initial.sessionEnabled,
		flatSteps: initial.flatSteps,
		initialFlatStepCount: initial.initialFlatStepCount,
		mutatingFailureWindowMs: 5 * 60_000,
		globalSemaphore,
		statusPayload,
		previousOutput: "",
		outputs: {},
		results: [],
		activeChildInterrupts: new Map(),
		activeChildTimeouts: new Map(),
		activeChildTurnBudgetAborts: new Map(),
		pendingStepSteers: [],
		interrupted: false,
		currentActivityState: undefined,
		activityTimer: undefined,
		timeoutTimer: undefined,
		timedOut: false,
		turnBudgetExceeded: false,
		previousCumulativeTokens: { input: 0, output: 0, total: 0 },
		latestSessionFile: undefined,
		emittedControlEventKeys: new Set(),
		activeLongRunningSteps: new Set(),
		mutatingFailureStates: initial.initialStatusSteps.map(() => createMutatingFailureState()),
		pendingToolResults: initial.initialStatusSteps.map(() => undefined),
	};
}
