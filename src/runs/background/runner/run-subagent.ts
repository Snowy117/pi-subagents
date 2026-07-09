import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../../shared/atomic-json.ts";
import {
	consumeInterruptRequest,
	deliverInterruptRequest,
	deliverTimeoutRequest,
	enqueueStepSteer,
	stepSteerInboxDir,
	watchAsyncControlInbox,
	type SteerRequest,
} from "../control-channel.ts";
import { parseSessionTokens } from "../../../shared/session-tokens.ts";
import { resolveSubagentIntercomTarget } from "../../../intercom/intercom-bridge.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../../shared/worktree.ts";
import { resolveEffectiveThinking } from "../../../shared/model-info.ts";
import { appendRunnerStepsToStatus, consumeChainAppendRequests, countPendingChainAppendRequests } from "../chain-append.ts";
import { initialTurnBudgetState, shouldAbortForTurnBudget, turnBudgetExceededMessage, turnBudgetSoftNote, turnBudgetState } from "../../shared/turn-budget.ts";
import { initialToolBudgetState, toolBudgetState } from "../../shared/tool-budget.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
} from "../../shared/subagent-control.ts";
import { acceptanceFailureMessage, aggregateAcceptanceReport, evaluateAcceptance, stripAcceptanceReport } from "../../shared/acceptance.ts";
import { nestedSummaryFromAsyncStatus, projectNestedEvents, resolveNestedAsyncDir, writeNestedEvent } from "../../shared/nested-events.ts";
import { applyThinkingSuffix } from "../../shared/pi-args.ts";
import { DynamicFanoutError, collectDynamicResults, materializeDynamicParallelStep, validateDynamicCollection } from "../../shared/dynamic-fanout.ts";
import { outputEntryFromAsyncResult } from "../../shared/chain-outputs.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	isMutatingTool,
	nextLongRunningTrigger,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../../shared/long-running-guard.ts";
import { extractTextFromContent, extractToolArgsPreview } from "../../../shared/utils.ts";
import {
	DEFAULT_MAX_OUTPUT,
	SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
	truncateOutput,
	type ActivityState,
	type ChainOutputMap,
	type CostSummary,
	type NestedRunSummary,
	type TokenUsage,
	type TurnBudgetState,
} from "../../../shared/types.ts";
import {
	DEFAULT_GLOBAL_CONCURRENCY_LIMIT,
	MAX_PARALLEL_CONCURRENCY,
	Semaphore,
	aggregateParallelOutputs,
	flattenSteps,
	isDynamicRunnerGroup,
	isParallelGroup,
	mapConcurrent,
	type RunnerSubagentStep as SubagentStep,
} from "../../shared/parallel-utils.ts";
import { appendJsonl } from "./event-logging.ts";
import { appendRecentStepOutput, findLatestSessionFile, isTerminalAssistantStop, resetStepLiveDetail, tokenUsageFromAttempts } from "./usage-helpers.ts";
import {
	appendParallelWorktreeSummary,
	ensureParallelProgressFile,
	markParallelGroupRunning,
	markParallelGroupSetupFailure,
	prepareParallelTaskRun,
	resolveAsyncStepTranscriptPath,
} from "./parallel-helpers.ts";
import { createShareLink, exportSessionHtml } from "./share-export.ts";
import { writeRunLog } from "./run-log.ts";
import { runSingleStep, type SingleStepResult } from "./run-single-step.ts";
import type { ChildEvent, RunnerStatusPayload, RunnerStatusStep, StepResult, SubagentRunConfig } from "./types.ts";

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

export async function runSubagent(config: SubagentRunConfig): Promise<void> {
	const { id, steps, resultPath, cwd, placeholder, taskIndex, totalTasks, maxOutput, artifactsDir, artifactConfig } =
		config;
	const globalSemaphore = new Semaphore(config.globalConcurrencyLimit ?? DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
	let previousOutput = "";
	const outputs: ChainOutputMap = {};
	const results: StepResult[] = [];
	const overallStartTime = Date.now();
	const shareEnabled = config.share === true;
	const asyncDir = config.asyncDir;
	const statusPath = path.join(asyncDir, "status.json");
	const eventsPath = path.join(asyncDir, "events.jsonl");
	const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
	const controlConfig = config.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	const activeChildInterrupts = new Map<number, () => void>();
	const activeChildTimeouts = new Map<number, () => void>();
	const activeChildTurnBudgetAborts = new Map<number, (message: string, state?: TurnBudgetState) => void>();
	const pendingStepSteers: SteerRequest[] = [];
	let interrupted = false;
	let currentActivityState: ActivityState | undefined;
	let activityTimer: NodeJS.Timeout | undefined;
	let timeoutTimer: NodeJS.Timeout | undefined;
	let timedOut = false;
	let turnBudgetExceeded = false;
	const timeoutMessage = config.timeoutMs !== undefined ? `Subagent timed out after ${config.timeoutMs}ms.` : undefined;
	const timeoutAbortController = new AbortController();
	let previousCumulativeTokens: TokenUsage = { input: 0, output: 0, total: 0 };
	let latestSessionFile: string | undefined;

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
		|| shareEnabled
		|| flatSteps.some((step) => Boolean(step.sessionFile));
	const statusPayload: RunnerStatusPayload = {
		lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
		runId: id,
		...(config.sessionId ? { sessionId: config.sessionId } : {}),
		mode: config.resultMode ?? (flatSteps.length > 1 ? "chain" : "single"),
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
		chainStepCount: steps.length,
		parallelGroups,
		workflowGraph: config.workflowGraph,
		steps: initialStatusSteps,
		artifactsDir,
		sessionDir: config.sessionDir,
		outputFile: path.join(asyncDir, "output-0.log"),
	};

	fs.mkdirSync(asyncDir, { recursive: true });
	writeAtomicJson(statusPath, statusPayload);
	const emitNestedSelfEvent = (type: "subagent.nested.updated" | "subagent.nested.completed"): void => {
		if (!config.nestedRoute || !config.nestedSelf) return;
		try {
			writeNestedEvent(config.nestedRoute, {
				type,
				ts: Date.now(),
				parentRunId: config.nestedSelf.parentRunId,
				parentStepIndex: config.nestedSelf.parentStepIndex,
				child: nestedSummaryFromAsyncStatus(statusPayload, asyncDir, {
					id,
					parentRunId: config.nestedSelf.parentRunId,
					parentStepIndex: config.nestedSelf.parentStepIndex,
					depth: config.nestedSelf.depth,
					path: config.nestedSelf.path,
					mode: statusPayload.mode,
					ts: Date.now(),
				}),
			});
		} catch (error) {
			console.error("Failed to emit nested async status event:", error);
		}
	};
	const refreshWorkflowGraph = (): void => {
		if (!config.workflowGraph) return;
		const graph = structuredClone(statusPayload.workflowGraph ?? config.workflowGraph);
		const normalize = (status: RunnerStatusStep["status"]): "pending" | "running" | "completed" | "failed" | "paused" | "detached" => {
			if (status === "complete" || status === "completed") return "completed";
			if (status === "running" || status === "failed" || status === "paused" || status === "pending") return status;
			return "pending";
		};
		const updateNode = (node: NonNullable<typeof graph.nodes>[number]): void => {
			if (node.flatIndex !== undefined) {
				const step = statusPayload.steps[node.flatIndex];
				if (step) {
					node.status = normalize(step.status);
					node.error = step.error;
					node.acceptanceStatus = step.acceptance?.status;
				}
				if (statusPayload.currentStep === node.flatIndex) graph.currentNodeId = node.id;
			}
			for (const child of node.children ?? []) updateNode(child);
			if (node.children?.length) {
				if (node.children.every((child) => child.status === "completed")) node.status = "completed";
				else if (node.children.some((child) => child.status === "running")) node.status = "running";
				else if (node.children.some((child) => child.status === "failed")) node.status = "failed";
				else if (node.children.some((child) => child.status === "paused")) node.status = "paused";
			}
			if (node.error) node.status = "failed";
		};
		for (const node of graph.nodes) updateNode(node);
		statusPayload.workflowGraph = graph;
	};
	const writeStatusPayload = (): void => {
		refreshWorkflowGraph();
		writeAtomicJson(statusPath, statusPayload);
		emitNestedSelfEvent(statusPayload.state === "running" || statusPayload.state === "queued" ? "subagent.nested.updated" : "subagent.nested.completed");
	};
	const registerStepInterrupt = (flatIndex: number, interrupt: (() => void) | undefined): void => {
		if (!interrupt) {
			activeChildInterrupts.delete(flatIndex);
			return;
		}
		activeChildInterrupts.set(flatIndex, interrupt);
		if (interrupted) interrupt();
	};
	const registerStepTimeout = (flatIndex: number, interrupt: (() => void) | undefined): void => {
		if (!interrupt) {
			activeChildTimeouts.delete(flatIndex);
			return;
		}
		activeChildTimeouts.set(flatIndex, interrupt);
		if (timedOut) interrupt();
	};
	const registerStepTurnBudgetAbort = (flatIndex: number, abort: ((message: string, state?: TurnBudgetState) => void) | undefined): void => {
		if (!abort) {
			activeChildTurnBudgetAborts.delete(flatIndex);
			return;
		}
		activeChildTurnBudgetAborts.set(flatIndex, abort);
	};
	const interruptActiveChildren = (): void => {
		for (const interrupt of [...activeChildInterrupts.values()]) interrupt();
	};
	const timeoutActiveChildren = (): void => {
		for (const interrupt of [...activeChildTimeouts.values()]) interrupt();
	};
	const nestedRuns = function* (children: NestedRunSummary[] | undefined): Generator<NestedRunSummary> {
		for (const child of children ?? []) {
			yield child;
			yield* nestedRuns(child.children);
			yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
		}
	};
	const interruptNestedAsyncDescendants = (): void => {
		if (!config.nestedRoute) return;
		let registry: ReturnType<typeof projectNestedEvents>;
		try {
			registry = projectNestedEvents(config.nestedRoute);
		} catch (error) {
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.nested.interrupt_failed",
				ts: Date.now(),
				runId: id,
				message: error instanceof Error ? error.message : String(error),
			}));
			return;
		}
		for (const run of nestedRuns(registry.children)) {
			if (run.state !== "running" && run.state !== "queued") continue;
			const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(config.nestedRoute.rootRunId, run);
			if (!nestedAsyncDir) continue;
			try {
				deliverInterruptRequest({ asyncDir: nestedAsyncDir, pid: run.pid, source: "ancestor-interrupt" });
			} catch (error) {
				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.nested.interrupt_failed",
					ts: Date.now(),
					runId: id,
					targetRunId: run.id,
					message: error instanceof Error ? error.message : String(error),
				}));
			}
		}
	};
	const timeoutNestedAsyncDescendants = (): void => {
		if (!config.nestedRoute) return;
		let registry: ReturnType<typeof projectNestedEvents>;
		try {
			registry = projectNestedEvents(config.nestedRoute);
		} catch (error) {
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.nested.timeout_failed",
				ts: Date.now(),
				runId: id,
				message: error instanceof Error ? error.message : String(error),
			}));
			return;
		}
		for (const run of nestedRuns(registry.children)) {
			if (run.state !== "running" && run.state !== "queued") continue;
			const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(config.nestedRoute.rootRunId, run);
			if (!nestedAsyncDir) continue;
			try {
				deliverTimeoutRequest({ asyncDir: nestedAsyncDir, pid: run.pid, source: "ancestor-timeout" });
			} catch (error) {
				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.nested.timeout_failed",
					ts: Date.now(),
					runId: id,
					targetRunId: run.id,
					message: error instanceof Error ? error.message : String(error),
				}));
			}
		}
	};
	const pausedStepResult = (agent: string): SingleStepResult => ({
		agent,
		output: "Paused after interrupt. Waiting for explicit next action.",
		exitCode: 0,
		interrupted: true,
	});
	const timedOutStepResult = (agent: string): SingleStepResult => ({
		agent,
		output: timeoutMessage ?? "Subagent timed out.",
		error: timeoutMessage ?? "Subagent timed out.",
		exitCode: 1,
		timedOut: true,
	});
	const consumePendingAppendRequests = (): void => {
		if (statusPayload.mode !== "chain" || statusPayload.state !== "running") return;
		const requests = consumeChainAppendRequests(asyncDir);
		if (requests.length === 0) {
			const pendingAppends = countPendingChainAppendRequests(asyncDir);
			if ((statusPayload.pendingAppends ?? 0) !== pendingAppends) {
				statusPayload.pendingAppends = pendingAppends;
				statusPayload.lastUpdate = Date.now();
				writeStatusPayload();
			}
			return;
		}
		const appendedSteps = requests.flatMap((request) => request.steps);
		steps.push(...appendedSteps);
		const now = Date.now();
		const pendingAppends = countPendingChainAppendRequests(asyncDir);
		const added = appendRunnerStepsToStatus({
			status: statusPayload,
			steps: appendedSteps,
			now,
			pendingAppends,
		});
		mutatingFailureStates.push(...Array.from({ length: added.addedFlatSteps }, () => createMutatingFailureState()));
		pendingToolResults.push(...Array.from({ length: added.addedFlatSteps }, () => undefined));
		if (config.childIntercomTargets) {
			config.childIntercomTargets = statusPayload.steps.map((statusStep, index) => resolveSubagentIntercomTarget(id, statusStep.agent, index));
		}
		writeStatusPayload();
		for (const request of requests) {
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.chain.append.accepted",
				ts: now,
				runId: id,
				requestId: request.id,
				stepCount: request.steps.length,
				pendingAppends,
			}));
		}
	};
	const markDynamicGraphGroup = (stepIndex: number, status: "completed" | "failed" | "running", error?: string, acceptance?: import("../../../shared/types.ts").AcceptanceLedger): void => {
		const groupNode = statusPayload.workflowGraph?.nodes.find((node) => node.id === `step-${stepIndex}`);
		if (!groupNode) return;
		groupNode.status = status;
		groupNode.error = error;
		groupNode.acceptanceStatus = acceptance?.status ?? groupNode.acceptanceStatus;
	};

	const stepOutputActivityAt = (index: number): number => {
		const step = statusPayload.steps[index];
		let lastActivityAt = step?.lastActivityAt ?? step?.startedAt ?? overallStartTime;
		const outputPath = path.join(asyncDir, `output-${index}.log`);
		try {
			lastActivityAt = Math.max(lastActivityAt, fs.statSync(outputPath).mtimeMs);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(`Failed to inspect async output file '${outputPath}':`, error);
			}
		}
		return lastActivityAt;
	};
	const emittedControlEventKeys = new Set<string>();
	const activeLongRunningSteps = new Set<number>();
	const mutatingFailureStates = initialStatusSteps.map(() => createMutatingFailureState());
	const pendingToolResults: Array<{ tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined> = initialStatusSteps.map(() => undefined);
	const mutatingFailureWindowMs = 5 * 60_000;
	const appendControlEvent = (event: ReturnType<typeof buildControlEvent>) => {
		if (!controlConfig.enabled) return;
		const childIntercomTarget = config.childIntercomTargets?.[event.index ?? statusPayload.currentStep];
		const channels = event.type === "active_long_running"
			? controlConfig.notifyChannels.filter((channel) => channel !== "intercom")
			: controlConfig.notifyChannels;
		if (channels.length === 0 || !claimControlNotification(controlConfig, event, emittedControlEventKeys, childIntercomTarget)) return;
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.control",
			event,
			channels,
			childIntercomTarget,
			noticeText: formatControlNoticeMessage(event, childIntercomTarget),
			...(config.controlIntercomTarget && channels.includes("intercom") ? {
				intercom: {
					to: config.controlIntercomTarget,
					message: formatControlIntercomMessage(event, childIntercomTarget),
				},
			} : {}),
		}));
	};
	const syncTopLevelCurrentTool = (): void => {
		const activeStep = statusPayload.steps
			.filter((step) => step.status === "running" && typeof step.currentTool === "string" && step.currentTool.length > 0)
			.sort((left, right) => (right.currentToolStartedAt ?? 0) - (left.currentToolStartedAt ?? 0))[0];
		statusPayload.currentTool = activeStep?.currentTool;
		statusPayload.currentToolStartedAt = activeStep?.currentToolStartedAt;
		statusPayload.currentPath = activeStep?.currentPath;
	};
	const maybeEmitActiveLongRunning = (flatIndex: number, now: number): boolean => {
		if (!controlConfig.enabled || activeLongRunningSteps.has(flatIndex)) return false;
		const step = statusPayload.steps[flatIndex];
		if (!step || step.status !== "running" || step.activityState === "needs_attention") return false;
		const reason = nextLongRunningTrigger(controlConfig, {
			startedAt: step.startedAt ?? overallStartTime,
			now,
			turns: step.turnCount ?? 0,
			tokens: step.tokens?.total ?? 0,
		});
		if (!reason) return false;
		activeLongRunningSteps.add(flatIndex);
		const previous = step.activityState;
		step.activityState = "active_long_running";
		statusPayload.activityState = statusPayload.activityState === "needs_attention" ? "needs_attention" : "active_long_running";
		const event = buildControlEvent({
			type: "active_long_running",
			from: previous,
			to: "active_long_running",
			runId: id,
			agent: step.agent,
			index: flatIndex,
			ts: now,
			message: `${step.agent} is still active but long-running`,
			reason,
			turns: step.turnCount,
			tokens: step.tokens?.total,
			toolCount: step.toolCount,
			currentTool: step.currentTool,
			currentToolDurationMs: step.currentToolStartedAt ? Math.max(0, now - step.currentToolStartedAt) : undefined,
			currentPath: step.currentPath,
			elapsedMs: now - (step.startedAt ?? overallStartTime),
		});
		appendControlEvent(event);
		return true;
	};
	const deliverSteerRequest = (request: SteerRequest): void => {
		if (statusPayload.state !== "running") return;
		const runningIndexes = statusPayload.steps
			.map((step, index) => ({ step, index }))
			.filter(({ step }) => step.status === "running")
			.map(({ index }) => index);
		const targets = request.targetIndex !== undefined ? [request.targetIndex] : runningIndexes;
		const now = Date.now();
		const accepted: number[] = [];
		const rejected: Array<{ index: number; reason: string }> = [];
		for (const index of targets) {
			const step = statusPayload.steps[index];
			if (!step) {
				rejected.push({ index, reason: "child index out of range" });
				continue;
			}
			if (step.status !== "running") {
				rejected.push({ index, reason: `child is ${step.status}` });
				continue;
			}
			enqueueStepSteer(asyncDir, index, request);
			step.steerCount = (step.steerCount ?? 0) + 1;
			step.lastSteerAt = now;
			accepted.push(index);
		}
		if (accepted.length > 0) {
			statusPayload.steerCount = (statusPayload.steerCount ?? 0) + accepted.length;
			statusPayload.lastSteerAt = now;
			statusPayload.lastUpdate = now;
			writeStatusPayload();
		}
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.steer.requested",
			ts: now,
			runId: id,
			requestId: request.id,
			message: request.message,
			...(request.source ? { source: request.source } : {}),
			...(request.targetIndex !== undefined ? { targetIndex: request.targetIndex } : {}),
			acceptedIndexes: accepted,
			...(rejected.length ? { rejected } : {}),
		}));
	};
	const flushPendingStepSteers = (flatIndex: number): void => {
		const remaining: SteerRequest[] = [];
		for (const request of pendingStepSteers.splice(0)) {
			if (request.targetIndex === undefined) deliverSteerRequest({ ...request, targetIndex: flatIndex });
			else if (request.targetIndex === flatIndex) deliverSteerRequest(request);
			else remaining.push(request);
		}
		pendingStepSteers.push(...remaining);
	};
	const updateStepModel = (flatIndex: number, model: string | undefined, thinking: string | undefined, now = Date.now()): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		step.model = model;
		step.thinking = thinking;
		statusPayload.lastUpdate = now;
		writeStatusPayload();
	};
	const updateStepTurnBudget = (flatIndex: number, turnCount: number, now: number, terminalAssistantStop: boolean): void => {
		const budget = config.turnBudget;
		const step = statusPayload.steps[flatIndex];
		if (!budget || !step || timedOut || turnBudgetExceeded || step.turnBudgetExceeded) return;
		if (turnCount < budget.maxTurns) {
			const state: TurnBudgetState = { ...budget, outcome: "within-budget", turnCount };
			step.turnBudget = state;
			statusPayload.turnBudget = state;
			return;
		}
		const state = turnBudgetState(budget, turnCount, false);
		step.turnBudget = state;
		statusPayload.turnBudget = state;
		if (!step.wrapUpRequested) {
			step.wrapUpRequested = true;
			statusPayload.wrapUpRequested = true;
			appendRecentStepOutput(step, [turnBudgetSoftNote(budget, turnCount)]);
		}
		if (!shouldAbortForTurnBudget(budget, turnCount, terminalAssistantStop)) return;
		const exceededState = turnBudgetState(budget, turnCount, true);
		const message = turnBudgetExceededMessage(budget, turnCount);
		step.turnBudget = exceededState;
		step.turnBudgetExceeded = true;
		step.wrapUpRequested = true;
		step.error = message;
		turnBudgetExceeded = true;
		statusPayload.turnBudget = exceededState;
		statusPayload.turnBudgetExceeded = true;
		statusPayload.wrapUpRequested = true;
		statusPayload.error = message;
		statusPayload.lastUpdate = now;
		appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.turn_budget_exceeded", ts: now, runId: id, stepIndex: flatIndex, agent: step.agent, turnCount, maxTurns: budget.maxTurns, graceTurns: budget.graceTurns, message }));
		activeChildTurnBudgetAborts.get(flatIndex)?.(message, exceededState);
	};
	const updateStepFromChildEvent = (flatIndex: number, event: ChildEvent): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		const now = Date.now();
		statusPayload.currentStep = flatIndex;
		if (event.type === "tool_execution_start" && event.toolName) {
			const mutates = isMutatingTool(event.toolName, event.args);
			const currentPath = resolveCurrentPath(event.toolName, event.args);
			step.toolCount = (step.toolCount ?? 0) + 1;
			const configuredToolBudget = flatSteps[flatIndex]?.toolBudget;
			if (configuredToolBudget) {
				step.toolBudget = toolBudgetState(configuredToolBudget, step.toolCount);
				statusPayload.toolBudget = step.toolBudget;
			}
			step.currentTool = event.toolName;
			step.currentToolArgs = extractToolArgsPreview(event.args ?? {});
			step.currentToolStartedAt = now;
			step.currentPath = currentPath;
			pendingToolResults[flatIndex] = { tool: event.toolName, path: currentPath, mutates, startedAt: now };
			statusPayload.toolCount = (statusPayload.toolCount ?? 0) + 1;
			syncTopLevelCurrentTool();
		} else if (event.type === "tool_execution_end") {
			if (step.currentTool) {
				step.recentTools ??= [];
				step.recentTools.push({ tool: step.currentTool, args: step.currentToolArgs || "", endMs: now });
			}
			step.currentTool = undefined;
			step.currentToolArgs = undefined;
			step.currentToolStartedAt = undefined;
			step.currentPath = undefined;
			syncTopLevelCurrentTool();
		} else if (event.type === "tool_result_end" && event.message) {
			const toolSnapshot = pendingToolResults[flatIndex];
			pendingToolResults[flatIndex] = undefined;
			const resultText = extractTextFromContent(event.message.content);
			if (toolSnapshot && resultText.includes("Tool budget hard limit reached")) {
				const configuredToolBudget = flatSteps[flatIndex]?.toolBudget;
				if (configuredToolBudget) {
					step.toolBudget = toolBudgetState(configuredToolBudget, step.toolCount ?? 0, toolSnapshot.tool);
					step.toolBudgetBlocked = true;
					statusPayload.toolBudget = step.toolBudget;
					statusPayload.toolBudgetBlocked = true;
				}
			}
			appendRecentStepOutput(step, resultText.split("\n").slice(-10));
			if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
				const state = mutatingFailureStates[flatIndex]!;
				recordMutatingFailure(state, {
					tool: toolSnapshot.tool,
					path: toolSnapshot.path,
					error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
					ts: now,
				}, mutatingFailureWindowMs);
				if (controlConfig.enabled && shouldEscalateMutatingFailures(state, controlConfig.failedToolAttemptsBeforeAttention) && step.activityState !== "needs_attention") {
					const previous = step.activityState;
					step.activityState = "needs_attention";
					statusPayload.activityState = "needs_attention";
					appendControlEvent(buildControlEvent({
						type: "needs_attention",
						from: previous,
						to: "needs_attention",
						runId: id,
						agent: step.agent,
						index: flatIndex,
						ts: now,
						message: `${step.agent} needs attention after repeated mutating tool failures`,
						reason: "tool_failures",
						turns: step.turnCount,
						tokens: step.tokens?.total,
						toolCount: step.toolCount,
						currentTool: toolSnapshot.tool,
						currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
						currentPath: toolSnapshot.path,
						recentFailureSummary: summarizeRecentMutatingFailures(state),
					}));
				}
			} else if (toolSnapshot?.mutates) {
				resetMutatingFailureState(mutatingFailureStates[flatIndex]!);
			}
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			appendRecentStepOutput(step, stripAcceptanceReport(extractTextFromContent(event.message.content)).split("\n").slice(-10));
			step.turnCount = (step.turnCount ?? 0) + 1;
			const usage = event.message.usage;
			if (usage) {
				const input = usage.input ?? usage.inputTokens ?? 0;
				const output = usage.output ?? usage.outputTokens ?? 0;
				const previousInput = step.tokens?.input ?? 0;
				const previousOutput = step.tokens?.output ?? 0;
				step.tokens = { input: previousInput + input, output: previousOutput + output, total: previousInput + previousOutput + input + output };
				const totalInput = statusPayload.totalTokens?.input ?? 0;
				const totalOutput = statusPayload.totalTokens?.output ?? 0;
				statusPayload.totalTokens = { input: totalInput + input, output: totalOutput + output, total: totalInput + totalOutput + input + output };
			}
			statusPayload.turnCount = Math.max(statusPayload.turnCount ?? 0, step.turnCount);
			updateStepTurnBudget(flatIndex, step.turnCount, now, isTerminalAssistantStop(event.message));
		}
		syncTopLevelCurrentTool();
		step.lastActivityAt = now;
		statusPayload.lastActivityAt = now;
		statusPayload.lastUpdate = now;
		maybeEmitActiveLongRunning(flatIndex, now);
		writeStatusPayload();
	};
	const updateRunnerActivityState = (now: number): boolean => {
		if (!controlConfig.enabled) return false;
		let changed = false;
		let runLastActivityAt = statusPayload.lastActivityAt ?? overallStartTime;
		for (let index = 0; index < statusPayload.steps.length; index++) {
			const step = statusPayload.steps[index]!;
			if (step.status !== "running") continue;
			const lastActivityAt = stepOutputActivityAt(index);
			runLastActivityAt = Math.max(runLastActivityAt, lastActivityAt);
			if (step.lastActivityAt !== lastActivityAt) {
				step.lastActivityAt = lastActivityAt;
				changed = true;
			}
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: step.startedAt ?? overallStartTime,
				lastActivityAt,
				now,
			});
			if (idleState === "needs_attention") {
				const previous = step.activityState;
				step.activityState = "needs_attention";
				if (previous !== "needs_attention") {
					appendControlEvent(buildControlEvent({
						from: previous,
						to: "needs_attention",
						runId: id,
						agent: step.agent,
						index,
						ts: now,
						lastActivityAt,
					}));
					changed = true;
				}
			} else if (maybeEmitActiveLongRunning(index, now)) {
				changed = true;
			}
		}
		if (statusPayload.lastActivityAt !== runLastActivityAt) {
			statusPayload.lastActivityAt = runLastActivityAt;
			changed = true;
		}
		const nextRunState = statusPayload.steps.some((step) => step.activityState === "needs_attention")
			? "needs_attention"
			: statusPayload.steps.some((step) => step.activityState === "active_long_running")
				? "active_long_running"
				: undefined;
		if (nextRunState !== currentActivityState) {
			currentActivityState = nextRunState;
			statusPayload.activityState = nextRunState;
			changed = true;
		}
		statusPayload.lastUpdate = now;
		if (changed) writeStatusPayload();
		return changed;
	};
	if (controlConfig.enabled) {
		activityTimer = setInterval(() => {
			if (statusPayload.state !== "running") return;
			const now = Date.now();
			updateRunnerActivityState(now);
		}, 1000);
		activityTimer.unref?.();
	}

	const interruptRunner = () => {
		consumeInterruptRequest(asyncDir);
		if (interrupted || statusPayload.state !== "running") return;
		interrupted = true;
		const now = Date.now();
		statusPayload.state = "paused";
		currentActivityState = undefined;
		statusPayload.activityState = undefined;
		statusPayload.lastUpdate = now;
		for (const step of statusPayload.steps) {
			if (step.status === "running") {
				step.status = "paused";
				step.activityState = undefined;
				step.endedAt = now;
				step.durationMs = step.startedAt ? now - step.startedAt : undefined;
				step.lastActivityAt = now;
			}
		}
		writeStatusPayload();
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.run.paused",
			ts: now,
			runId: id,
		}));
		interruptNestedAsyncDescendants();
		interruptActiveChildren();
	};
	const timeoutRunner = () => {
		if (timedOut || interrupted || statusPayload.state !== "running") return;
		timedOut = true;
		const now = Date.now();
		const message = timeoutMessage ?? "Subagent timed out.";
		statusPayload.state = "failed";
		statusPayload.timedOut = true;
		statusPayload.error = message;
		currentActivityState = undefined;
		statusPayload.activityState = undefined;
		statusPayload.lastUpdate = now;
		for (const step of statusPayload.steps) {
			if (step.status !== "running" && step.status !== "pending") continue;
			step.status = "failed";
			step.error = message;
			step.exitCode = 1;
			step.timedOut = true;
			step.activityState = undefined;
			step.endedAt = now;
			step.durationMs = step.startedAt ? now - step.startedAt : 0;
			step.lastActivityAt = now;
		}
		writeStatusPayload();
		appendJsonl(eventsPath, JSON.stringify({
			type: "subagent.run.timed_out",
			ts: now,
			runId: id,
			timeoutMs: config.timeoutMs,
			deadlineAt: config.deadlineAt,
			message,
		}));
		timeoutAbortController.abort();
		timeoutNestedAsyncDescendants();
		timeoutActiveChildren();
	};
	process.on(ASYNC_INTERRUPT_SIGNAL, interruptRunner);
	// Portable control inbox: the parent drops control request files here when
	// it cannot deliver OS signals (e.g. ENOSYS on Windows) or when steering a
	// live child. Interrupts still route into the same graceful interruptRunner().
	const disposeControlInbox = watchAsyncControlInbox(asyncDir, {
		onInterrupt: interruptRunner,
		onTimeout: timeoutRunner,
		onSteer: (request) => {
			const targetStep = request.targetIndex !== undefined ? statusPayload.steps[request.targetIndex] : undefined;
			if (targetStep?.status === "pending") pendingStepSteers.push(request);
			else if (request.targetIndex !== undefined || statusPayload.steps.some((step) => step.status === "running")) deliverSteerRequest(request);
			else pendingStepSteers.push(request);
		},
	});
	if (config.deadlineAt !== undefined) {
		const remainingMs = Math.max(0, config.deadlineAt - Date.now());
		timeoutTimer = setTimeout(timeoutRunner, remainingMs);
		timeoutTimer.unref?.();
	}
	appendJsonl(
		eventsPath,
		JSON.stringify({
			type: "subagent.run.started",
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			ts: overallStartTime,
			runId: id,
			mode: statusPayload.mode,
			cwd,
			pid: process.pid,
		}),
	);

	let flatIndex = 0;
	let stepCursor = 0;

	while (true) {
		if (interrupted || timedOut || turnBudgetExceeded) break;
		consumePendingAppendRequests();
		if (stepCursor >= steps.length) break;
		const stepIndex = stepCursor++;
		const step = steps[stepIndex]!;

		if (isDynamicRunnerGroup(step)) {
			const groupStartFlatIndex = flatIndex;
			let materialized: ReturnType<typeof materializeDynamicParallelStep>;
			try {
				materialized = materializeDynamicParallelStep(step as Parameters<typeof materializeDynamicParallelStep>[0], outputs, stepIndex, { maxItems: config.dynamicFanoutMaxItems, allowRunnerFields: true });
				if (materialized.collectedOnEmpty) validateDynamicCollection(step.collect.outputSchema, materialized.collectedOnEmpty);
			} catch (error) {
				const now = Date.now();
				const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
				statusPayload.state = "failed";
				statusPayload.error = message;
				statusPayload.currentStep = flatIndex;
				const placeholder = statusPayload.steps[groupStartFlatIndex];
				if (placeholder) {
					placeholder.status = "failed";
					placeholder.error = message;
					placeholder.startedAt = now;
					placeholder.endedAt = now;
					placeholder.durationMs = 0;
					placeholder.exitCode = 1;
				}
				statusPayload.lastUpdate = now;
				markDynamicGraphGroup(stepIndex, "failed", message);
				writeStatusPayload();
				results.push({ agent: step.parallel.agent, output: message, error: message, success: false, exitCode: 1 });
				break;
			}

			if (materialized.parallel.length === 0) {
				const now = Date.now();
				const collection = materialized.collectedOnEmpty ?? [];
				outputs[step.collect.as] = {
					text: JSON.stringify(collection),
					structured: collection,
					agent: step.parallel.agent,
					stepIndex,
				};
				statusPayload.outputs = outputs;
				const placeholder = statusPayload.steps[groupStartFlatIndex];
				if (placeholder) {
					placeholder.status = "complete";
					placeholder.startedAt = now;
					placeholder.endedAt = now;
					placeholder.durationMs = 0;
				}
				previousOutput = "Dynamic fanout produced 0 results.";
				const groupAcceptance = step.effectiveAcceptance?.explicit && !timedOut
					? await evaluateAcceptance({
						acceptance: step.effectiveAcceptance,
						output: "",
						report: aggregateAcceptanceReport({
							results: [],
							notes: "Dynamic fanout produced 0 results.",
						}),
						cwd,
						signal: timeoutAbortController.signal,
						abortMessage: timeoutMessage ?? "Subagent timed out.",
					})
					: undefined;
				const groupTimedOut = timedOut || timeoutAbortController.signal.aborted;
				const effectiveGroupAcceptance = groupTimedOut ? undefined : groupAcceptance;
				if (placeholder && effectiveGroupAcceptance) placeholder.acceptance = effectiveGroupAcceptance;
				const groupAcceptanceFailure = effectiveGroupAcceptance ? acceptanceFailureMessage(effectiveGroupAcceptance) : undefined;
				if (groupTimedOut || groupAcceptanceFailure) {
					const errorMessage = groupTimedOut ? timeoutMessage ?? "Subagent timed out." : groupAcceptanceFailure!;
					statusPayload.state = "failed";
					statusPayload.error = errorMessage;
					if (placeholder) {
						placeholder.status = "failed";
						placeholder.error = errorMessage;
						placeholder.exitCode = 1;
						placeholder.timedOut = groupTimedOut ? true : undefined;
					}
					markDynamicGraphGroup(stepIndex, "failed", errorMessage, effectiveGroupAcceptance);
					statusPayload.lastUpdate = Date.now();
					writeStatusPayload();
					results.push({ agent: step.parallel.agent, output: errorMessage, error: errorMessage, success: false, exitCode: 1, timedOut: groupTimedOut ? true : undefined, acceptance: effectiveGroupAcceptance });
					break;
				}
				flatIndex++;
				statusPayload.lastUpdate = now;
				markDynamicGraphGroup(stepIndex, "completed", undefined, effectiveGroupAcceptance);
				writeStatusPayload();
				continue;
			}

			const dynamicSteps = materialized.parallel.map((task, itemIndex) => {
				const thinkingOverride = step.thinkingOverrides?.[itemIndex];
				const model = thinkingOverride ? applyThinkingSuffix(step.parallel.model, thinkingOverride, true) : step.parallel.model;
				const thinking = thinkingOverride ? resolveEffectiveThinking(model, thinkingOverride) : undefined;
				return {
					...step.parallel,
					task: task.task ?? step.parallel.task,
					label: task.label ?? step.parallel.label,
					...(step.sessionFiles?.[itemIndex] ? { sessionFile: step.sessionFiles[itemIndex] } : {}),
					...(thinkingOverride ? {
						...(model ? { model } : {}),
						...(thinking ? { thinking } : {}),
						...(step.parallel.modelCandidates ? { modelCandidates: step.parallel.modelCandidates.map((candidate) => applyThinkingSuffix(candidate, thinkingOverride, true)) } : {}),
					} : {}),
					structuredOutput: undefined,
					structuredOutputSchema: step.parallel.structuredOutputSchema ?? step.parallel.structuredOutput?.schema,
				};
			});
			const dynamicFlatStepCount = Math.max(statusPayload.steps.length - 1 + dynamicSteps.length, 1);
			const dynamicStatusSteps: RunnerStatusStep[] = dynamicSteps.map((task, itemIndex) => {
				const transcriptPath = resolveAsyncStepTranscriptPath({ artifactsDir, artifactConfig, runId: id, agent: task.agent, flatIndex: groupStartFlatIndex + itemIndex, flatStepCount: dynamicFlatStepCount });
				return {
					agent: task.agent,
					phase: task.phase ?? step.phase,
					label: task.label,
					outputName: undefined,
					structured: Boolean(task.structuredOutputSchema),
					status: "pending",
					...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
					...(transcriptPath ? { transcriptPath } : {}),
					skills: task.skills,
					model: task.model,
					thinking: task.thinking,
					attemptedModels: task.modelCandidates && task.modelCandidates.length > 0 ? task.modelCandidates : task.model ? [task.model] : undefined,
					recentTools: [],
					recentOutput: [],
				};
			});
			statusPayload.steps.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps);
			if (config.childIntercomTargets) {
				config.childIntercomTargets = statusPayload.steps.map((statusStep, index) => resolveSubagentIntercomTarget(id, statusStep.agent, index));
			}
			mutatingFailureStates.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => createMutatingFailureState()));
			pendingToolResults.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => undefined));
			const materializedDelta = dynamicStatusSteps.length - 1;
			for (const group of statusPayload.parallelGroups) {
				if (group.stepIndex === stepIndex) {
					group.start = groupStartFlatIndex;
					group.count = dynamicStatusSteps.length;
				} else if (group.start > groupStartFlatIndex) {
					group.start += materializedDelta;
				}
			}
			if (statusPayload.workflowGraph) {
				const shiftFlatIndexes = (nodes: NonNullable<typeof statusPayload.workflowGraph>["nodes"]): void => {
					for (const node of nodes) {
						if (node.stepIndex !== undefined && node.stepIndex > stepIndex && node.flatIndex !== undefined && node.flatIndex >= groupStartFlatIndex) {
							node.flatIndex += dynamicStatusSteps.length;
						}
						if (node.children) shiftFlatIndexes(node.children);
					}
				};
				shiftFlatIndexes(statusPayload.workflowGraph.nodes);
				const groupNode = statusPayload.workflowGraph.nodes.find((node) => node.id === `step-${stepIndex}`);
				if (groupNode) {
					groupNode.children = materialized.items.map((item, itemIndex) => ({
						id: `step-${stepIndex}-item-${item.idKey}`,
						kind: "agent",
						agent: step.parallel.agent,
						phase: dynamicSteps[itemIndex]?.phase ?? step.phase,
						label: dynamicSteps[itemIndex]?.label?.trim() || `${step.parallel.agent} ${item.key}`,
						status: "pending",
						flatIndex: groupStartFlatIndex + itemIndex,
						stepIndex,
						itemKey: item.key,
						structured: Boolean(dynamicSteps[itemIndex]?.structuredOutputSchema),
					}));
				}
			}
			writeStatusPayload();

			const concurrency = step.concurrency ?? MAX_PARALLEL_CONCURRENCY;
			const failFast = step.failFast ?? false;
			let aborted = false;
			const parallelResults = await mapConcurrent(dynamicSteps, concurrency, async (task, taskIdx) => {
				const fi = groupStartFlatIndex + taskIdx;
				if (timedOut) return timedOutStepResult(task.agent);
				if (interrupted) return pausedStepResult(task.agent);
				if (aborted && failFast) {
					const skippedAt = Date.now();
					statusPayload.steps[fi].status = "failed";
					statusPayload.steps[fi].error = "Skipped due to fail-fast";
					statusPayload.steps[fi].startedAt = skippedAt;
					statusPayload.steps[fi].endedAt = skippedAt;
					statusPayload.steps[fi].durationMs = 0;
					statusPayload.steps[fi].exitCode = -1;
					statusPayload.lastUpdate = skippedAt;
					writeStatusPayload();
					return { agent: task.agent, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true };
				}
				const taskStartTime = Date.now();
				statusPayload.currentStep = fi;
				statusPayload.steps[fi].status = "running";
				statusPayload.steps[fi].error = undefined;
				statusPayload.steps[fi].activityState = undefined;
				resetStepLiveDetail(statusPayload.steps[fi]);
				statusPayload.steps[fi].startedAt = taskStartTime;
				statusPayload.steps[fi].lastActivityAt = taskStartTime;
				statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
				statusPayload.lastActivityAt = taskStartTime;
				statusPayload.lastUpdate = taskStartTime;
				writeStatusPayload();
				appendJsonl(eventsPath, JSON.stringify({ type: "subagent.step.started", ts: taskStartTime, runId: id, stepIndex: fi, agent: task.agent }));
				flushPendingStepSteers(fi);
				const singleResult = await runSingleStep(task, {
					previousOutput, placeholder, cwd, sessionEnabled,
					outputs,
					sessionDir: config.sessionDir ? path.join(config.sessionDir, `dynamic-${stepIndex}-${taskIdx}`) : undefined,
					artifactsDir, artifactConfig, id,
					flatIndex: fi, flatStepCount: Math.max(statusPayload.steps.length, 1),
					outputFile: path.join(asyncDir, `output-${fi}.log`),
					steerInboxDir: stepSteerInboxDir(asyncDir, fi),
					piPackageRoot: config.piPackageRoot,
					piArgv1: config.piArgv1,
					childIntercomTarget: config.childIntercomTargets?.[fi],
					orchestratorIntercomTarget: config.controlIntercomTarget,
					nestedRoute: config.nestedRoute,
					registerInterrupt: (interrupt) => registerStepInterrupt(fi, interrupt),
					registerTimeout: (interrupt) => registerStepTimeout(fi, interrupt),
					registerTurnBudgetAbort: (abort) => registerStepTurnBudgetAbort(fi, abort),
					timeoutSignal: timeoutAbortController.signal,
					timeoutMessage,
					turnBudget: config.turnBudget,
					onAttemptStart: (attempt) => updateStepModel(fi, attempt.model, attempt.thinking),
					onChildEvent: (event) => updateStepFromChildEvent(fi, event),
					skipAcceptance: () => timedOut,
				});
				const taskEndTime = Date.now();
				const childInterrupted = singleResult.interrupted === true;
				statusPayload.steps[fi].status = timedOut ? "failed" : childInterrupted ? "paused" : singleResult.exitCode === 0 ? "complete" : "failed";
				statusPayload.steps[fi].endedAt = taskEndTime;
				statusPayload.steps[fi].durationMs = taskEndTime - taskStartTime;
				statusPayload.steps[fi].exitCode = timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode;
				statusPayload.steps[fi].timedOut = timedOut || singleResult.timedOut ? true : undefined;
				statusPayload.steps[fi].turnBudget = singleResult.turnBudget;
				statusPayload.steps[fi].turnBudgetExceeded = singleResult.turnBudgetExceeded;
				statusPayload.steps[fi].wrapUpRequested = singleResult.wrapUpRequested;
				statusPayload.steps[fi].toolBudget = singleResult.toolBudget;
				statusPayload.steps[fi].toolBudgetBlocked = singleResult.toolBudgetBlocked;
				if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
				if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
				if (singleResult.turnBudget) statusPayload.turnBudget = singleResult.turnBudget;
				if (singleResult.turnBudgetExceeded) statusPayload.turnBudgetExceeded = true;
				if (singleResult.wrapUpRequested) statusPayload.wrapUpRequested = true;
				statusPayload.steps[fi].model = singleResult.model;
				statusPayload.steps[fi].thinking = resolveEffectiveThinking(singleResult.model, statusPayload.steps[fi].thinking);
				statusPayload.steps[fi].attemptedModels = singleResult.attemptedModels;
				statusPayload.steps[fi].modelAttempts = singleResult.modelAttempts;
				statusPayload.steps[fi].totalCost = singleResult.totalCost;
				statusPayload.steps[fi].error = timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.error;
				statusPayload.steps[fi].transcriptPath = singleResult.transcriptPath ?? statusPayload.steps[fi].transcriptPath;
				statusPayload.steps[fi].transcriptError = singleResult.transcriptError;
				statusPayload.steps[fi].structuredOutput = singleResult.structuredOutput;
				statusPayload.steps[fi].structuredOutputPath = singleResult.structuredOutputPath;
				statusPayload.steps[fi].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
				statusPayload.steps[fi].acceptance = singleResult.acceptance;
				statusPayload.lastUpdate = taskEndTime;
				writeStatusPayload();
				appendJsonl(eventsPath, JSON.stringify({
					type: timedOut ? "subagent.step.failed" : childInterrupted ? "subagent.step.paused" : singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
					ts: taskEndTime, runId: id, stepIndex: fi, agent: task.agent,
					exitCode: timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode, durationMs: taskEndTime - taskStartTime,
				}));
				if (singleResult.exitCode !== 0 && failFast) aborted = true;
				return timedOut ? { ...singleResult, output: timeoutMessage ?? "Subagent timed out.", error: timeoutMessage ?? "Subagent timed out.", exitCode: 1, interrupted: false, timedOut: true, skipped: false } : { ...singleResult, skipped: false };
			}, globalSemaphore);

			flatIndex += dynamicSteps.length;
			for (const pr of parallelResults) {
				results.push({
					agent: pr.agent,
					output: pr.output,
					error: pr.error,
					success: pr.interrupted !== true && pr.exitCode === 0,
					exitCode: pr.interrupted === true ? 0 : pr.exitCode,
					skipped: pr.skipped,
					interrupted: pr.interrupted,
					timedOut: pr.timedOut,
					turnBudget: pr.turnBudget,
					turnBudgetExceeded: pr.turnBudgetExceeded,
					wrapUpRequested: pr.wrapUpRequested,
					toolBudget: pr.toolBudget,
					toolBudgetBlocked: pr.toolBudgetBlocked,
					sessionFile: pr.sessionFile,
					intercomTarget: pr.intercomTarget,
					model: pr.model,
					attemptedModels: pr.attemptedModels,
					modelAttempts: pr.modelAttempts,
					totalCost: pr.totalCost,
					artifactPaths: pr.artifactPaths,
					transcriptPath: pr.transcriptPath,
					transcriptError: pr.transcriptError,
					structuredOutput: pr.structuredOutput,
					structuredOutputPath: pr.structuredOutputPath,
					structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
					acceptance: pr.acceptance,
				});
			}
			const collection = collectDynamicResults(step as Parameters<typeof collectDynamicResults>[0], materialized.items, parallelResults);
			const failures = parallelResults.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
			if (failures.length === 0) {
				try {
					validateDynamicCollection(step.collect.outputSchema, collection);
					outputs[step.collect.as] = {
						text: JSON.stringify(collection),
						structured: collection,
						agent: step.parallel.agent,
						stepIndex,
					};
					statusPayload.outputs = outputs;
					const groupAcceptance = step.effectiveAcceptance && !timedOut
						? await evaluateAcceptance({
							acceptance: step.effectiveAcceptance,
							output: "",
							report: aggregateAcceptanceReport({
								results: parallelResults,
								notes: `Dynamic fanout collected ${collection.length} result(s) into ${step.collect.as}.`,
							}),
							cwd,
							signal: timeoutAbortController.signal,
							abortMessage: timeoutMessage ?? "Subagent timed out.",
						})
						: undefined;
					const groupTimedOut = timedOut || timeoutAbortController.signal.aborted;
					const effectiveGroupAcceptance = groupTimedOut ? undefined : groupAcceptance;
					const groupAcceptanceFailure = effectiveGroupAcceptance ? acceptanceFailureMessage(effectiveGroupAcceptance) : undefined;
					const groupError = groupTimedOut ? timeoutMessage ?? "Subagent timed out." : groupAcceptanceFailure;
					markDynamicGraphGroup(stepIndex, groupError ? "failed" : "completed", groupError, effectiveGroupAcceptance);
					if (groupError) {
						results.push({
							agent: step.parallel.agent,
							output: groupError,
							error: groupError,
							success: false,
							exitCode: 1,
							timedOut: groupTimedOut ? true : undefined,
							structuredOutput: collection,
							acceptance: effectiveGroupAcceptance,
						});
						statusPayload.error = groupError;
					}
				} catch (error) {
					const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
					results.push({ agent: step.parallel.agent, output: message, error: message, success: false, exitCode: 1, structuredOutput: collection });
					statusPayload.error = message;
					markDynamicGraphGroup(stepIndex, "failed", message);
				}
			}
			previousOutput = aggregateParallelOutputs(
				parallelResults.map((r, i) => ({
					agent: r.agent,
					taskIndex: i,
					output: r.output,
					exitCode: r.exitCode,
					error: r.error,
				})),
				(i, agent) => `=== Dynamic Item ${i + 1} (${agent}, key ${materialized.items[i]?.key ?? i}) ===`,
			);
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.dynamic.completed",
				ts: Date.now(),
				runId: id,
				stepIndex,
				success: failures.length === 0,
			}));
			if (failures.length > 0) markDynamicGraphGroup(stepIndex, "failed", failures[0]?.error ?? "Dynamic fanout child failed.");
			statusPayload.lastUpdate = Date.now();
			writeStatusPayload();
			if (failures.length > 0 || statusPayload.error) break;
			continue;
		}

		if (isParallelGroup(step)) {
			const group = step;
			const concurrency = group.concurrency ?? MAX_PARALLEL_CONCURRENCY;
			const failFast = group.failFast ?? false;
			const groupStartFlatIndex = flatIndex;
			let aborted = false;
			let worktreeSetup: WorktreeSetup | undefined;
			if (group.worktree) {
				const worktreeTaskCwdConflict = findWorktreeTaskCwdConflict(group.parallel, cwd);
				if (worktreeTaskCwdConflict) {
					const failedAt = Date.now();
					markParallelGroupSetupFailure({
						statusPayload,
						results,
						group,
						groupStartFlatIndex,
						setupError: formatWorktreeTaskCwdConflict(worktreeTaskCwdConflict, cwd),
						failedAt,
						statusPath,
						eventsPath,
						asyncDir,
						runId: id,
						stepIndex,
					});
					flatIndex += group.parallel.length;
					break;
				}
				try {
					worktreeSetup = createWorktrees(cwd, `${id}-s${stepIndex}`, group.parallel.length, {
						agents: group.parallel.map((task) => task.agent),
						setupHook: config.worktreeSetupHook
							? { hookPath: config.worktreeSetupHook, timeoutMs: config.worktreeSetupHookTimeoutMs }
							: undefined,
						baseDir: config.worktreeBaseDir,
					});
				} catch (error) {
					const setupError = error instanceof Error ? error.message : String(error);
					const failedAt = Date.now();
					markParallelGroupSetupFailure({
						statusPayload,
						results,
						group,
						groupStartFlatIndex,
						setupError,
						failedAt,
						statusPath,
						eventsPath,
						asyncDir,
						runId: id,
						stepIndex,
					});
					flatIndex += group.parallel.length;
					break;
				}
			}

			try {
				if (group.worktree) ensureParallelProgressFile(cwd, group);
				const groupStartTime = Date.now();
				markParallelGroupRunning({
					statusPayload,
					group,
					groupStartFlatIndex,
					groupStartTime,
					statusPath,
					eventsPath,
					asyncDir,
					runId: id,
					stepIndex,
				});
				const parallelResults = await mapConcurrent(
					group.parallel,
					concurrency,
					async (task, taskIdx) => {
						const fi = groupStartFlatIndex + taskIdx;
						if (timedOut) return timedOutStepResult(task.agent);
						if (interrupted) return pausedStepResult(task.agent);
						if (aborted && failFast) {
							const skippedAt = Date.now();
							statusPayload.steps[fi].status = "failed";
							statusPayload.steps[fi].error = "Skipped due to fail-fast";
							statusPayload.steps[fi].startedAt = skippedAt;
							statusPayload.steps[fi].endedAt = skippedAt;
							statusPayload.steps[fi].durationMs = 0;
							statusPayload.steps[fi].exitCode = -1;
							statusPayload.steps[fi].activityState = undefined;
							statusPayload.lastUpdate = skippedAt;
							writeStatusPayload();
							appendJsonl(eventsPath, JSON.stringify({
								type: "subagent.step.failed", ts: skippedAt, runId: id, stepIndex: fi, agent: task.agent, exitCode: -1, durationMs: 0,
							}));
							return { agent: task.agent, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true };
						}

						const taskStartTime = Date.now();
						statusPayload.currentStep = fi;
						statusPayload.steps[fi].status = "running";
						statusPayload.steps[fi].error = undefined;
						statusPayload.steps[fi].activityState = undefined;
						resetStepLiveDetail(statusPayload.steps[fi]);
						statusPayload.steps[fi].startedAt = taskStartTime;
						statusPayload.steps[fi].endedAt = undefined;
						statusPayload.steps[fi].durationMs = undefined;
						statusPayload.steps[fi].lastActivityAt = taskStartTime;
						statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
						statusPayload.lastActivityAt = taskStartTime;
						statusPayload.lastUpdate = taskStartTime;
						writeStatusPayload();

						appendJsonl(eventsPath, JSON.stringify({
							type: "subagent.step.started", ts: taskStartTime, runId: id, stepIndex: fi, agent: task.agent,
						}));

						const taskSessionDir = config.sessionDir
							? path.join(config.sessionDir, `parallel-${taskIdx}`)
							: undefined;
						const { taskForRun, taskCwd } = prepareParallelTaskRun(task, cwd, worktreeSetup, taskIdx);
						flushPendingStepSteers(fi);

						const singleResult = await runSingleStep(taskForRun, {
							previousOutput, placeholder, cwd: taskCwd, sessionEnabled,
							outputs,
							sessionDir: taskSessionDir,
							artifactsDir, artifactConfig, id,
							flatIndex: fi, flatStepCount: Math.max(statusPayload.steps.length, 1),
							outputFile: path.join(asyncDir, `output-${fi}.log`),
							steerInboxDir: stepSteerInboxDir(asyncDir, fi),
							piPackageRoot: config.piPackageRoot,
							piArgv1: config.piArgv1,
							childIntercomTarget: config.childIntercomTargets?.[fi],
							orchestratorIntercomTarget: config.controlIntercomTarget,
							nestedRoute: config.nestedRoute,
							registerInterrupt: (interrupt) => registerStepInterrupt(fi, interrupt),
							registerTimeout: (interrupt) => registerStepTimeout(fi, interrupt),
							registerTurnBudgetAbort: (abort) => registerStepTurnBudgetAbort(fi, abort),
							timeoutSignal: timeoutAbortController.signal,
							timeoutMessage,
							turnBudget: config.turnBudget,
							onAttemptStart: (attempt) => updateStepModel(fi, attempt.model, attempt.thinking),
							onChildEvent: (event) => updateStepFromChildEvent(fi, event),
							skipAcceptance: () => timedOut,
						});
						if (task.sessionFile) {
							latestSessionFile = task.sessionFile;
						}

						const taskEndTime = Date.now();
						const taskDuration = taskEndTime - taskStartTime;
						const childInterrupted = singleResult.interrupted === true;

						statusPayload.steps[fi].status = timedOut ? "failed" : childInterrupted ? "paused" : singleResult.exitCode === 0 ? "complete" : "failed";
						statusPayload.steps[fi].endedAt = taskEndTime;
						statusPayload.steps[fi].durationMs = taskDuration;
						statusPayload.steps[fi].exitCode = timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode;
						statusPayload.steps[fi].timedOut = timedOut || singleResult.timedOut ? true : undefined;
						statusPayload.steps[fi].turnBudget = singleResult.turnBudget;
						statusPayload.steps[fi].turnBudgetExceeded = singleResult.turnBudgetExceeded;
						statusPayload.steps[fi].wrapUpRequested = singleResult.wrapUpRequested;
						statusPayload.steps[fi].toolBudget = singleResult.toolBudget;
						statusPayload.steps[fi].toolBudgetBlocked = singleResult.toolBudgetBlocked;
						if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
						if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
						if (singleResult.turnBudget) statusPayload.turnBudget = singleResult.turnBudget;
						if (singleResult.turnBudgetExceeded) statusPayload.turnBudgetExceeded = true;
						if (singleResult.wrapUpRequested) statusPayload.wrapUpRequested = true;
						statusPayload.steps[fi].model = singleResult.model;
						statusPayload.steps[fi].thinking = resolveEffectiveThinking(singleResult.model, statusPayload.steps[fi].thinking);
						statusPayload.steps[fi].attemptedModels = singleResult.attemptedModels;
						statusPayload.steps[fi].modelAttempts = singleResult.modelAttempts;
						statusPayload.steps[fi].totalCost = singleResult.totalCost;
						statusPayload.steps[fi].error = timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.error;
						statusPayload.steps[fi].transcriptPath = singleResult.transcriptPath ?? statusPayload.steps[fi].transcriptPath;
						statusPayload.steps[fi].transcriptError = singleResult.transcriptError;
						statusPayload.steps[fi].structuredOutput = singleResult.structuredOutput;
						statusPayload.steps[fi].structuredOutputPath = singleResult.structuredOutputPath;
						statusPayload.steps[fi].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
						statusPayload.steps[fi].acceptance = singleResult.acceptance;
						statusPayload.lastUpdate = taskEndTime;
						writeStatusPayload();

						appendJsonl(eventsPath, JSON.stringify({
							type: timedOut ? "subagent.step.failed" : childInterrupted ? "subagent.step.paused" : singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
							ts: taskEndTime, runId: id, stepIndex: fi, agent: task.agent,
							exitCode: timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode, durationMs: taskDuration,
						}));
						if (singleResult.completionGuardTriggered) {
							const event = buildControlEvent({
								from: statusPayload.steps[fi].activityState,
								to: "needs_attention",
								runId: id,
								agent: task.agent,
								index: fi,
								ts: taskEndTime,
								message: `${task.agent} completed without making edits for an implementation task`,
								reason: "completion_guard",
							});
							appendControlEvent(event);
						}

						if (singleResult.exitCode !== 0 && failFast) aborted = true;
						return timedOut ? { ...singleResult, output: timeoutMessage ?? "Subagent timed out.", error: timeoutMessage ?? "Subagent timed out.", exitCode: 1, interrupted: false, timedOut: true, skipped: false } : { ...singleResult, skipped: false };
					},
					globalSemaphore,
				);

				flatIndex += group.parallel.length;

				for (let t = 0; t < group.parallel.length; t++) {
					const fi = groupStartFlatIndex + t;
					const sessionTokens = config.sessionDir
						? parseSessionTokens(path.join(config.sessionDir, `parallel-${t}`))
						: null;
					const taskTokens = sessionTokens ?? tokenUsageFromAttempts(parallelResults[t]?.modelAttempts);
					if (!taskTokens) continue;
					statusPayload.steps[fi].tokens = taskTokens;
					previousCumulativeTokens = {
						input: previousCumulativeTokens.input + taskTokens.input,
						output: previousCumulativeTokens.output + taskTokens.output,
						total: previousCumulativeTokens.total + taskTokens.total,
					};
				}
				statusPayload.totalTokens = { ...previousCumulativeTokens };
				statusPayload.lastUpdate = Date.now();
				writeStatusPayload();

				for (const pr of parallelResults) {
					results.push({
						agent: pr.agent,
						output: pr.output,
						error: pr.error,
						success: pr.interrupted !== true && pr.exitCode === 0,
						exitCode: pr.interrupted === true ? 0 : pr.exitCode,
						skipped: pr.skipped,
						interrupted: pr.interrupted,
						timedOut: pr.timedOut,
						turnBudget: pr.turnBudget,
						turnBudgetExceeded: pr.turnBudgetExceeded,
						wrapUpRequested: pr.wrapUpRequested,
						toolBudget: pr.toolBudget,
						toolBudgetBlocked: pr.toolBudgetBlocked,
						sessionFile: pr.sessionFile,
						intercomTarget: pr.intercomTarget,
						model: pr.model,
						attemptedModels: pr.attemptedModels,
						modelAttempts: pr.modelAttempts,
						totalCost: pr.totalCost,
						artifactPaths: pr.artifactPaths,
						transcriptPath: pr.transcriptPath,
						transcriptError: pr.transcriptError,
							structuredOutput: pr.structuredOutput,
							structuredOutputPath: pr.structuredOutputPath,
							structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
							acceptance: pr.acceptance,
						});
					}
				for (let t = 0; t < group.parallel.length; t++) {
					const outputName = group.parallel[t]?.outputName;
					if (outputName) outputs[outputName] = outputEntryFromAsyncResult({
						agent: parallelResults[t]!.agent,
						output: parallelResults[t]!.output,
						structuredOutput: parallelResults[t]!.structuredOutput,
					}, stepIndex);
				}
				statusPayload.outputs = outputs;

				previousOutput = aggregateParallelOutputs(
					parallelResults.map((r) => ({
					agent: r.agent,
					output: r.output,
					exitCode: r.exitCode,
					error: r.error,
					model: r.model,
					attemptedModels: r.attemptedModels,
				})),
				);
				previousOutput = appendParallelWorktreeSummary(previousOutput, worktreeSetup, asyncDir, stepIndex, group);

				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.parallel.completed",
					ts: Date.now(),
					runId: id,
					stepIndex,
					success: parallelResults.every((r) => r.exitCode === 0 || r.exitCode === -1),
				}));

				if (parallelResults.some((r) => r.exitCode !== 0 && r.exitCode !== -1)) {
					break;
				}
			} finally {
				if (worktreeSetup) cleanupWorktrees(worktreeSetup);
			}
		} else {
			const seqStep = step as SubagentStep;
			const stepStartTime = Date.now();
			statusPayload.currentStep = flatIndex;
			statusPayload.steps[flatIndex].status = "running";
			statusPayload.steps[flatIndex].activityState = undefined;
			statusPayload.activityState = undefined;
			resetStepLiveDetail(statusPayload.steps[flatIndex]);
			statusPayload.steps[flatIndex].skills = seqStep.skills;
			statusPayload.steps[flatIndex].startedAt = stepStartTime;
			statusPayload.steps[flatIndex].lastActivityAt = stepStartTime;
			statusPayload.lastActivityAt = stepStartTime;
			statusPayload.lastUpdate = stepStartTime;
			statusPayload.outputFile = path.join(asyncDir, `output-${flatIndex}.log`);
			writeStatusPayload();

			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.step.started",
				ts: stepStartTime,
				runId: id,
				stepIndex: flatIndex,
				agent: seqStep.agent,
			}));

			flushPendingStepSteers(flatIndex);
			const singleResult = await runSingleStep(seqStep, {
				previousOutput, placeholder, cwd, sessionEnabled,
				outputs,
				sessionDir: config.sessionDir,
				artifactsDir, artifactConfig, id,
				flatIndex, flatStepCount: Math.max(statusPayload.steps.length, 1),
				outputFile: path.join(asyncDir, `output-${flatIndex}.log`),
				steerInboxDir: stepSteerInboxDir(asyncDir, flatIndex),
				piPackageRoot: config.piPackageRoot,
				piArgv1: config.piArgv1,
				childIntercomTarget: config.childIntercomTargets?.[flatIndex],
				orchestratorIntercomTarget: config.controlIntercomTarget,
				nestedRoute: config.nestedRoute,
				registerInterrupt: (interrupt) => registerStepInterrupt(flatIndex, interrupt),
				registerTimeout: (interrupt) => registerStepTimeout(flatIndex, interrupt),
				registerTurnBudgetAbort: (abort) => registerStepTurnBudgetAbort(flatIndex, abort),
				timeoutSignal: timeoutAbortController.signal,
				timeoutMessage,
				turnBudget: config.turnBudget,
				onAttemptStart: (attempt) => updateStepModel(flatIndex, attempt.model, attempt.thinking),
				onChildEvent: (event) => updateStepFromChildEvent(flatIndex, event),
				skipAcceptance: () => timedOut,
			});
			if (seqStep.sessionFile) {
				latestSessionFile = seqStep.sessionFile;
			}

			previousOutput = singleResult.output;
			results.push({
				agent: singleResult.agent,
				output: timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.output,
				error: timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.error,
				success: !timedOut && singleResult.interrupted !== true && singleResult.exitCode === 0,
				exitCode: timedOut ? 1 : singleResult.interrupted === true ? 0 : singleResult.exitCode,
				sessionFile: singleResult.sessionFile,
				intercomTarget: singleResult.intercomTarget,
				model: singleResult.model,
				attemptedModels: singleResult.attemptedModels,
				modelAttempts: singleResult.modelAttempts,
				totalCost: singleResult.totalCost,
				artifactPaths: singleResult.artifactPaths,
				transcriptPath: singleResult.transcriptPath,
				transcriptError: singleResult.transcriptError,
				structuredOutput: singleResult.structuredOutput,
				structuredOutputPath: singleResult.structuredOutputPath,
				structuredOutputSchemaPath: singleResult.structuredOutputSchemaPath,
				acceptance: singleResult.acceptance,
				interrupted: singleResult.interrupted,
				timedOut: timedOut || singleResult.timedOut ? true : undefined,
				turnBudget: singleResult.turnBudget,
				turnBudgetExceeded: singleResult.turnBudgetExceeded,
				wrapUpRequested: singleResult.wrapUpRequested,
				toolBudget: singleResult.toolBudget,
				toolBudgetBlocked: singleResult.toolBudgetBlocked,
			});
			if (seqStep.outputName) {
				outputs[seqStep.outputName] = outputEntryFromAsyncResult({
					agent: singleResult.agent,
					output: singleResult.output,
					structuredOutput: singleResult.structuredOutput,
				}, stepIndex);
			}
			statusPayload.outputs = outputs;

			const cumulativeTokens = config.sessionDir ? parseSessionTokens(config.sessionDir) : null;
			let stepTokens: TokenUsage | null = cumulativeTokens
				? {
						input: cumulativeTokens.input - previousCumulativeTokens.input,
						output: cumulativeTokens.output - previousCumulativeTokens.output,
						total: cumulativeTokens.total - previousCumulativeTokens.total,
					}
				: null;
			if (cumulativeTokens) {
				previousCumulativeTokens = cumulativeTokens;
			} else {
				stepTokens = tokenUsageFromAttempts(singleResult.modelAttempts);
				if (stepTokens) {
					previousCumulativeTokens = {
						input: previousCumulativeTokens.input + stepTokens.input,
						output: previousCumulativeTokens.output + stepTokens.output,
						total: previousCumulativeTokens.total + stepTokens.total,
					};
				}
			}

			const stepEndTime = Date.now();
			const childInterrupted = singleResult.interrupted === true;
			statusPayload.steps[flatIndex].status = timedOut ? "failed" : childInterrupted ? "paused" : singleResult.exitCode === 0 ? "complete" : "failed";
			statusPayload.steps[flatIndex].endedAt = stepEndTime;
			statusPayload.steps[flatIndex].durationMs = stepEndTime - stepStartTime;
			statusPayload.steps[flatIndex].exitCode = timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode;
			statusPayload.steps[flatIndex].timedOut = timedOut || singleResult.timedOut ? true : undefined;
			statusPayload.steps[flatIndex].turnBudget = singleResult.turnBudget;
			statusPayload.steps[flatIndex].turnBudgetExceeded = singleResult.turnBudgetExceeded;
			statusPayload.steps[flatIndex].wrapUpRequested = singleResult.wrapUpRequested;
			statusPayload.steps[flatIndex].toolBudget = singleResult.toolBudget;
			statusPayload.steps[flatIndex].toolBudgetBlocked = singleResult.toolBudgetBlocked;
			if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
			if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
			if (singleResult.turnBudget) statusPayload.turnBudget = singleResult.turnBudget;
			if (singleResult.turnBudgetExceeded) statusPayload.turnBudgetExceeded = true;
			if (singleResult.wrapUpRequested) statusPayload.wrapUpRequested = true;
			statusPayload.steps[flatIndex].model = singleResult.model;
			statusPayload.steps[flatIndex].thinking = resolveEffectiveThinking(singleResult.model, statusPayload.steps[flatIndex].thinking);
			statusPayload.steps[flatIndex].attemptedModels = singleResult.attemptedModels;
			statusPayload.steps[flatIndex].modelAttempts = singleResult.modelAttempts;
			statusPayload.steps[flatIndex].totalCost = singleResult.totalCost;
			statusPayload.steps[flatIndex].error = timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.error;
			statusPayload.steps[flatIndex].transcriptPath = singleResult.transcriptPath ?? statusPayload.steps[flatIndex].transcriptPath;
			statusPayload.steps[flatIndex].transcriptError = singleResult.transcriptError;
			statusPayload.steps[flatIndex].structuredOutput = singleResult.structuredOutput;
			statusPayload.steps[flatIndex].structuredOutputPath = singleResult.structuredOutputPath;
			statusPayload.steps[flatIndex].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
			statusPayload.steps[flatIndex].acceptance = singleResult.acceptance;
			if (stepTokens) {
				statusPayload.steps[flatIndex].tokens = stepTokens;
				statusPayload.totalTokens = { ...previousCumulativeTokens };
			}
			statusPayload.lastUpdate = stepEndTime;
			writeStatusPayload();

			appendJsonl(eventsPath, JSON.stringify({
				type: timedOut ? "subagent.step.failed" : childInterrupted ? "subagent.step.paused" : singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
				ts: stepEndTime,
				runId: id,
				stepIndex: flatIndex,
				agent: seqStep.agent,
				exitCode: timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode,
				durationMs: stepEndTime - stepStartTime,
				tokens: stepTokens,
			}));
			if (singleResult.completionGuardTriggered) {
				const event = buildControlEvent({
					from: statusPayload.steps[flatIndex].activityState,
					to: "needs_attention",
					runId: id,
					agent: seqStep.agent,
					index: flatIndex,
					ts: stepEndTime,
					message: `${seqStep.agent} completed without making edits for an implementation task`,
					reason: "completion_guard",
				});
				appendControlEvent(event);
			}

			flatIndex++;
			if (singleResult.exitCode !== 0) {
				break;
			}
		}
	}

	let summary = results.map((r) => `${r.agent}:\n${r.output}`).join("\n\n");
	let truncated = false;

	if (maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
		const lastArtifactPath = results[results.length - 1]?.artifactPaths?.outputPath;
		const truncResult = truncateOutput(summary, config, lastArtifactPath);
		if (truncResult.truncated) {
			summary = truncResult.text;
			truncated = true;
		}
	}

	const resultMode = config.resultMode ?? statusPayload.mode;
	const totalCost = results.reduce<CostSummary>((sum, result) => ({
		inputTokens: sum.inputTokens + (result.totalCost?.inputTokens ?? 0),
		outputTokens: sum.outputTokens + (result.totalCost?.outputTokens ?? 0),
		costUsd: sum.costUsd + (result.totalCost?.costUsd ?? 0),
	}), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
	const finalTotalCost = totalCost.inputTokens > 0 || totalCost.outputTokens > 0 || totalCost.costUsd > 0 ? totalCost : undefined;
	const finalFlatAgents = statusPayload.steps.map((step) => step.agent);
	const agentName = finalFlatAgents.length === 1
		? finalFlatAgents[0]!
		: resultMode === "parallel"
			? `parallel:${finalFlatAgents.join("+")}`
			: `chain:${finalFlatAgents.join("->")}`;
	let sessionFile: string | undefined;
	let shareUrl: string | undefined;
	let gistUrl: string | undefined;
	let shareError: string | undefined;

	if (shareEnabled) {
		sessionFile = config.sessionDir
			? (findLatestSessionFile(config.sessionDir) ?? undefined)
			: undefined;
		if (!sessionFile && latestSessionFile) {
			sessionFile = latestSessionFile;
		}
		if (sessionFile) {
			try {
				const exportDir = config.sessionDir ?? path.dirname(sessionFile);
				const htmlPath = await exportSessionHtml(sessionFile, exportDir, config.piPackageRoot);
				const share = createShareLink(htmlPath);
				if ("error" in share) shareError = share.error;
				else {
					shareUrl = share.shareUrl;
					gistUrl = share.gistUrl;
				}
			} catch (err) {
				shareError = String(err);
			}
		} else {
			shareError = "Session file not found.";
		}
	}

	if (activityTimer) {
		clearInterval(activityTimer);
		activityTimer = undefined;
	}
	if (timeoutTimer) {
		clearTimeout(timeoutTimer);
		timeoutTimer = undefined;
	}
	disposeControlInbox();
	const effectiveSessionFile = sessionFile ?? latestSessionFile;
	const runEndedAt = Date.now();
	statusPayload.state = timedOut || turnBudgetExceeded ? "failed" : interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed";
	statusPayload.activityState = undefined;
	if (timedOut) {
		statusPayload.timedOut = true;
		statusPayload.error = timeoutMessage ?? "Subagent timed out.";
	}
	if (turnBudgetExceeded && !statusPayload.error) {
		const budget = statusPayload.turnBudget;
		statusPayload.error = budget ? turnBudgetExceededMessage(budget, budget.turnCount) : "Subagent exceeded turn budget.";
	}
	statusPayload.endedAt = runEndedAt;
	statusPayload.lastUpdate = runEndedAt;
	statusPayload.sessionFile = effectiveSessionFile;
	statusPayload.totalCost = finalTotalCost;
	statusPayload.shareUrl = shareUrl;
	statusPayload.gistUrl = gistUrl;
	statusPayload.shareError = shareError;
	if (statusPayload.state === "failed" && !statusPayload.error) {
		const failedStep = statusPayload.steps.find((s) => s.status === "failed");
		if (failedStep?.agent) {
			statusPayload.error = `Step failed: ${failedStep.agent}`;
		}
	}
	writeStatusPayload();
	appendJsonl(
		eventsPath,
		JSON.stringify({
			type: "subagent.run.completed",
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			ts: runEndedAt,
			runId: id,
			status: statusPayload.state,
			durationMs: runEndedAt - overallStartTime,
			totalTokens: statusPayload.totalTokens,
			totalCost: finalTotalCost,
		}),
	);
	writeRunLog(logPath, {
		id,
		mode: statusPayload.mode,
		cwd,
		startedAt: overallStartTime,
		endedAt: runEndedAt,
		steps: statusPayload.steps.map((step) => ({
			agent: step.agent,
			status: step.status,
			durationMs: step.durationMs,
		})),
		summary,
		truncated,
		artifactsDir,
		sessionFile: effectiveSessionFile,
		shareUrl,
		shareError,
	});

	try {
		writeAtomicJson(resultPath, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			agent: agentName,
			mode: resultMode,
			success: !timedOut && !turnBudgetExceeded && !interrupted && results.every((r) => r.success),
			state: timedOut || turnBudgetExceeded ? "failed" : interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed",
			summary: timedOut ? (timeoutMessage ?? "Subagent timed out.") : turnBudgetExceeded ? (statusPayload.error ?? "Subagent exceeded turn budget.") : interrupted ? "Paused after interrupt. Waiting for explicit next action." : summary,
			...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
			...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
			...(statusPayload.turnBudget ? { turnBudget: statusPayload.turnBudget } : {}),
			...(statusPayload.turnBudgetExceeded ? { turnBudgetExceeded: true } : {}),
			...(statusPayload.wrapUpRequested ? { wrapUpRequested: true } : {}),
			...(statusPayload.toolBudget ? { toolBudget: statusPayload.toolBudget } : {}),
			...(statusPayload.toolBudgetBlocked ? { toolBudgetBlocked: true } : {}),
			...(timedOut ? { timedOut: true, error: timeoutMessage ?? "Subagent timed out." } : turnBudgetExceeded ? { error: statusPayload.error ?? "Subagent exceeded turn budget." } : {}),
			results: results.map((r) => ({
				agent: r.agent,
				output: r.output,
				error: r.error,
				success: r.success,
				skipped: r.skipped || undefined,
				interrupted: r.interrupted || undefined,
				timedOut: r.timedOut || undefined,
				turnBudget: r.turnBudget,
				turnBudgetExceeded: r.turnBudgetExceeded || undefined,
				wrapUpRequested: r.wrapUpRequested || undefined,
				toolBudget: r.toolBudget,
				toolBudgetBlocked: r.toolBudgetBlocked || undefined,
				sessionFile: r.sessionFile,
				intercomTarget: r.intercomTarget,
				model: r.model,
				attemptedModels: r.attemptedModels,
				modelAttempts: r.modelAttempts,
				totalCost: r.totalCost,
				artifactPaths: r.artifactPaths,
				truncated: r.truncated,
				transcriptPath: r.transcriptPath,
				transcriptError: r.transcriptError,
				structuredOutput: r.structuredOutput,
				structuredOutputPath: r.structuredOutputPath,
				structuredOutputSchemaPath: r.structuredOutputSchemaPath,
				acceptance: r.acceptance,
			})),
			outputs,
			workflowGraph: statusPayload.workflowGraph,
			exitCode: timedOut || turnBudgetExceeded ? 1 : interrupted || results.every((r) => r.success) ? 0 : 1,
			timestamp: runEndedAt,
			durationMs: runEndedAt - overallStartTime,
			totalTokens: statusPayload.totalTokens,
			totalCost: finalTotalCost,
			truncated,
			artifactsDir,
			cwd,
			asyncDir,
			sessionId: config.sessionId,
			sessionFile: effectiveSessionFile,
			intercomTarget: config.controlIntercomTarget,
			shareUrl,
			gistUrl,
			shareError,
			...(taskIndex !== undefined && { taskIndex }),
			...(totalTasks !== undefined && { totalTasks }),
		});
	} catch (err) {
		console.error(`Failed to write result file ${resultPath}:`, err);
	}
}

