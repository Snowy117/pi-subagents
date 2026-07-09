/** single-path-helpers (extracted from single-path.ts; internal-only). */

import { type AgentConfig } from "../../../agents/agents.ts";
import { INTERCOM_BRIDGE_MARKER } from "../../../intercom/intercom-bridge.ts";
import { type ModelInfo } from "../../../shared/model-info.ts";
import { type AgentProgress, type ControlEvent, type Details, type ResolvedToolBudget, type SubagentState } from "../../../shared/types.ts";
import { type RunSyncOptions } from "../../../shared/types/options-types.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { notifyForegroundDetachedCompletion } from "./foreground-notify.ts";
import { type ExecutionContextData, type ExecutorDeps } from "./types.ts";
import { updateRememberedForegroundChild } from "./foreground-state.ts";


type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;


export function createSingleUpdateForwarder(
	foregroundControl: ForegroundControl | undefined,
	agentName: string,
	onUpdate: (update: AgentToolResult<Details>) => void,
): (update: AgentToolResult<Details>) => void {
	return (update: AgentToolResult<Details>) => {
		if (foregroundControl) {
			const firstProgress = update.details?.progress?.[0];
			foregroundControl.currentAgent = agentName;
			foregroundControl.currentIndex = firstProgress?.index ?? 0;
			foregroundControl.currentActivityState = firstProgress?.activityState;
			foregroundControl.lastActivityAt = firstProgress?.lastActivityAt;
			foregroundControl.currentTool = firstProgress?.currentTool;
			foregroundControl.currentToolStartedAt = firstProgress?.currentToolStartedAt;
			foregroundControl.currentPath = firstProgress?.currentPath;
			foregroundControl.turnCount = firstProgress?.turnCount;
			foregroundControl.tokens = firstProgress?.tokens;
			foregroundControl.toolCount = firstProgress?.toolCount;
			foregroundControl.updatedAt = Date.now();
		}
		onUpdate(update);
	};
}


export function syncSingleForegroundControlAfterRun(
	control: ForegroundControl,
	progress: AgentProgress | undefined,
): void {
	control.interrupt = undefined;
	control.currentActivityState = progress?.activityState;
	control.lastActivityAt = progress?.lastActivityAt;
	control.currentTool = progress?.currentTool;
	control.currentToolStartedAt = progress?.currentToolStartedAt;
	control.currentPath = progress?.currentPath;
	control.turnCount = progress?.turnCount;
	control.tokens = progress?.tokens;
	control.toolCount = progress?.toolCount;
	control.updatedAt = Date.now();
}


export interface SingleRunSyncOptionsLocals {
	interruptController: AbortController;
	agentConfig: AgentConfig;
	outputPath: string | undefined;
	effectiveOutputMode: "inline" | "file-only";
	maxSubagentDepth: number;
	forwardSingleUpdate: ((update: AgentToolResult<Details>) => void) | undefined;
	onControlEvent: (event: ControlEvent) => void;
	childIntercomTarget: string | undefined;
	foregroundControl: ForegroundControl | undefined;
	modelOverride: string | undefined;
	availableModels: ModelInfo[];
	currentProvider: string | undefined;
	effectiveSkills: string[] | undefined;
	deadlineAt: number | undefined;
	effectiveToolBudget: { toolBudget?: ResolvedToolBudget; error?: string };
}


export function buildSingleRunSyncOptions(
	data: ExecutionContextData,
	deps: ExecutorDeps,
	locals: SingleRunSyncOptionsLocals,
): RunSyncOptions {
	const { params, ctx, signal, runId, effectiveCwd, sessionDirForIndex, sessionFileForTask, shareEnabled, artifactConfig, artifactsDir, controlConfig } = data;
	const {
		interruptController,
		agentConfig,
		outputPath,
		effectiveOutputMode,
		maxSubagentDepth,
		forwardSingleUpdate,
		onControlEvent,
		childIntercomTarget,
		foregroundControl,
		modelOverride,
		availableModels,
		currentProvider,
		effectiveSkills,
		deadlineAt,
		effectiveToolBudget,
	} = locals;
	const orchestratorIntercomTarget = data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined;
	const onDetachedExit = (result: import("../../../shared/types/result-types.ts").SingleResult): void => {
		updateRememberedForegroundChild(deps.state, { runId, mode: "single", cwd: effectiveCwd, index: 0, result });
		notifyForegroundDetachedCompletion({ events: deps.pi.events, state: deps.state, runId, mode: "single", index: 0, result, orchestratorIntercomTarget });
	};
	return {
		parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
		cwd: effectiveCwd,
		signal,
		interruptSignal: interruptController.signal,
		allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
		intercomEvents: deps.pi.events,
		runId,
		sessionDir: sessionDirForIndex(0),
		sessionFile: sessionFileForTask(params.agent!, 0),
		share: shareEnabled,
		artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
		artifactConfig,
		maxOutput: params.maxOutput,
		outputPath,
		outputMode: effectiveOutputMode,
		maxSubagentDepth,
		onUpdate: forwardSingleUpdate,
		controlConfig,
		onControlEvent,
		intercomSessionName: childIntercomTarget,
		orchestratorIntercomTarget,
		nestedRoute: foregroundControl?.nestedRoute,
		index: 0,
		modelOverride,
		thinkingOverride: data.thinkingOverrideForTask(params.agent!, 0),
		availableModels,
		preferredModelProvider: currentProvider,
		modelScope: data.modelScope,
		skills: effectiveSkills,
		acceptance: params.acceptance,
		acceptanceContext: { mode: "single" },
		onDetachedExit,
		timeoutMs: data.timeoutMs,
		deadlineAt,
		turnBudget: data.turnBudget,
		toolBudget: effectiveToolBudget.toolBudget,
	};
}
