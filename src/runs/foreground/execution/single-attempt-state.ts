/**
 * Shared mutable state for `runSingleAttempt`.
 *
 * `runSingleAttempt` is one cohesive concurrent routine: it spawns a child pi
 * process and drives ~21 inline closures that share process-level mutable
 * state (proc, buffers, timers, flags, control-event queues, …). Those
 * closures were extracted into cohesive sibling modules. They cannot capture
 * each other across files, so every handler closes over ONE `SingleAttemptState`
 * reference. Mutating `state.foo` propagates identically to the original
 * inline-closure semantics, which preserves the concurrent control flow (R2).
 *
 * Data fields are the mutable locals that were previously `let`/`const` inside
 * the promise executor; the function fields are the extracted closures, wired
 * by the `attach*` helpers before the process starts emitting events.
 */

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { AgentConfig } from "../../../agents/agents.ts";
import { createJsonlWriter } from "../../../shared/jsonl-writer.ts";
import { createMutatingFailureState } from "../../shared/long-running-guard.ts";
import type {
	AgentProgress,
	ArtifactPaths,
	ControlEvent,
	ResolvedControlConfig,
	RunSyncOptions,
	SingleResult,
} from "../../../shared/types.ts";
import type { ChildTranscriptWriter } from "../../../shared/child-transcript.ts";
import type { SingleOutputSnapshot } from "../../shared/single-output.ts";

/** The `shared` argument bundle passed into `runSingleAttempt`. */
export interface SingleAttemptShared {
	sessionEnabled: boolean;
	systemPrompt: string;
	resolvedSkillNames?: string[];
	skillsWarning?: string;
	jsonlPath?: string;
	artifactPaths?: ArtifactPaths;
	transcriptWriter?: ChildTranscriptWriter;
	attemptNotes: string[];
	outputSnapshot?: SingleOutputSnapshot;
	originalTask?: string;
}

/** In-flight tool awaiting a `tool_result_end`, used by mutating-failure tracking. */
export interface PendingToolResult {
	tool: string;
	path?: string;
	mutates: boolean;
	startedAt?: number;
}

/** Input bundle used to initialize a `SingleAttemptState`. */
export interface SingleAttemptInputs {
	options: RunSyncOptions;
	agent: AgentConfig;
	shared: SingleAttemptShared;
	runtimeCwd: string;
	task: string;
	modelArg: string;
	startTime: number;
	controlConfig: ResolvedControlConfig;
	attemptTimeout: { timeoutMs: number; remainingMs: number; message: string } | undefined;
	args: string[];
	tempDir: string | undefined;
	spawnEnv: NodeJS.ProcessEnv;
}

/** Shared state for one `runSingleAttempt` invocation. */
export interface SingleAttemptState {
	// ---- stable inputs (set once at construction) ----
	readonly options: RunSyncOptions;
	readonly agent: AgentConfig;
	readonly shared: SingleAttemptShared;
	readonly runtimeCwd: string;
	readonly task: string;
	readonly modelArg: string;
	readonly startTime: number;
	readonly controlConfig: ResolvedControlConfig;
	readonly attemptTimeout: SingleAttemptInputs["attemptTimeout"];
	readonly args: string[];
	readonly tempDir: string | undefined;
	readonly spawnEnv: NodeJS.ProcessEnv;

	// ---- core outputs (fields mutated throughout) ----
	result: SingleResult;
	progress: AgentProgress;

	// ---- spawn process (assigned in executor) ----
	// `spawn` is always called with stdio `["ignore", "pipe", "pipe"]`, so stdin is
	// null and stdout/stderr are non-null `Readable` (matching the original).
	proc: ChildProcessByStdio<null, Readable, Readable>;
	jsonlWriter: ReturnType<typeof createJsonlWriter>;
	resolve: (code: number) => void;

	// ---- buffers ----
	buf: string;
	stderrBuf: string;

	// ---- lifecycle flags ----
	processClosed: boolean;
	settled: boolean;
	detached: boolean;
	intercomStarted: boolean;
	childExited: boolean;
	forcedTerminationSignal: boolean;
	cleanTerminalAssistantStopReceived: boolean;
	turnBudgetSoftReached: boolean;
	activeLongRunningNotified: boolean;
	observedMutationAttempt: boolean;
	interruptedByControl: boolean;
	assistantError: string | undefined;

	// ---- timers ----
	activityTimer: NodeJS.Timeout | undefined;
	timeoutTimer: NodeJS.Timeout | undefined;
	timeoutTerminationTimer: NodeJS.Timeout | undefined;
	timeoutHardKillTimer: NodeJS.Timeout | undefined;
	turnBudgetTerminationTimer: NodeJS.Timeout | undefined;
	turnBudgetHardKillTimer: NodeJS.Timeout | undefined;
	finalDrainTimer: NodeJS.Timeout | undefined;
	finalHardKillTimer: NodeJS.Timeout | undefined;

	// ---- cleanup handles ----
	removeAbortListener: (() => void) | undefined;
	removeInterruptListener: (() => void) | undefined;
	clearStdioGuard: () => void;
	unsubscribeIntercomDetach: (() => void) | undefined;

	// ---- control-event state ----
	allControlEvents: ControlEvent[];
	pendingControlEvents: ControlEvent[];
	emittedControlEventKeys: Set<string>;
	pendingToolResult: PendingToolResult | undefined;
	readonly mutatingFailures: ReturnType<typeof createMutatingFailureState>;
	readonly mutatingFailureWindowMs: number;

	// ---- extracted handler closures (wired by attach* helpers) ----
	clearTurnBudgetTimers: () => void;
	clearTimeoutTimers: () => void;
	clearFinalDrainTimers: () => void;
	startFinalDrain: () => void;
	finish: (code: number) => void;
	detachForIntercom: () => void;
	currentToolDurationMs: (now: number) => number | undefined;
	emitControlEvent: (event: ControlEvent) => void;
	drainPendingControlEvents: () => ControlEvent[] | undefined;
	emitNeedsAttention: (
		now: number,
		input?: {
			message?: string;
			reason?: ControlEvent["reason"];
			recentFailureSummary?: string;
			currentTool?: string;
			currentPath?: string;
			currentToolDurationMs?: number;
		},
	) => boolean;
	emitActiveLongRunning: (now: number, reason: ControlEvent["reason"]) => boolean;
	updateActivityState: (now: number) => boolean;
	requestTurnBudgetAbort: (turnCount: number) => void;
	updateTurnBudget: (turnCount: number, terminalAssistantStop: boolean) => void;
	emitUpdateSnapshot: (text: string) => void;
	fireUpdate: () => void;
	processLine: (line: string) => void;
}

export function createSingleAttemptState(input: SingleAttemptInputs): SingleAttemptState {
	return {
		options: input.options,
		agent: input.agent,
		shared: input.shared,
		runtimeCwd: input.runtimeCwd,
		task: input.task,
		modelArg: input.modelArg,
		startTime: input.startTime,
		controlConfig: input.controlConfig,
		attemptTimeout: input.attemptTimeout,
		args: input.args,
		tempDir: input.tempDir,
		spawnEnv: input.spawnEnv,

		// `result` and `progress` are constructed by the caller and assigned
		// onto the state object so all handlers mutate the same references.
		result: undefined as unknown as SingleResult,
		progress: undefined as unknown as AgentProgress,
		proc: undefined as unknown as ChildProcessByStdio<null, Readable, Readable>,
		jsonlWriter: undefined as unknown as ReturnType<typeof createJsonlWriter>,
		resolve: (() => undefined) as (code: number) => void,

		buf: "",
		stderrBuf: "",

		processClosed: false,
		settled: false,
		detached: false,
		intercomStarted: false,
		childExited: false,
		forcedTerminationSignal: false,
		cleanTerminalAssistantStopReceived: false,
		turnBudgetSoftReached: false,
		activeLongRunningNotified: false,
		observedMutationAttempt: false,
		interruptedByControl: false,
		assistantError: undefined,

		activityTimer: undefined,
		timeoutTimer: undefined,
		timeoutTerminationTimer: undefined,
		timeoutHardKillTimer: undefined,
		turnBudgetTerminationTimer: undefined,
		turnBudgetHardKillTimer: undefined,
		finalDrainTimer: undefined,
		finalHardKillTimer: undefined,

		removeAbortListener: undefined,
		removeInterruptListener: undefined,
		clearStdioGuard: () => {},
		unsubscribeIntercomDetach: undefined,

		allControlEvents: [],
		pendingControlEvents: [],
		emittedControlEventKeys: new Set<string>(),
		pendingToolResult: undefined,
		mutatingFailures: createMutatingFailureState(),
		mutatingFailureWindowMs: 5 * 60_000,

		// Handler closures — replaced by the attach* helpers before any event fires.
		clearTurnBudgetTimers: () => {},
		clearTimeoutTimers: () => {},
		clearFinalDrainTimers: () => {},
		startFinalDrain: () => {},
		finish: () => {},
		detachForIntercom: () => {},
		currentToolDurationMs: () => undefined,
		emitControlEvent: () => {},
		drainPendingControlEvents: () => undefined,
		emitNeedsAttention: () => false,
		emitActiveLongRunning: () => false,
		updateActivityState: () => false,
		requestTurnBudgetAbort: () => {},
		updateTurnBudget: () => {},
		emitUpdateSnapshot: () => {},
		fireUpdate: () => {},
		processLine: () => {},
	};
}
