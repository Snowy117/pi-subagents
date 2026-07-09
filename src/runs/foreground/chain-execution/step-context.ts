/** Shared context + loop-state types for the extracted executeChain step branches. */

import type { AgentConfig } from "../../../agents/agents.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentProgress, ArtifactPaths, ChainOutputMap, SingleResult } from "../../../shared/types.ts";
import type { IntercomEventBus } from "../../../shared/types.ts";
import type { ModelInfo } from "../../../shared/model-info.ts";
import type { ResolvedTemplates } from "../../../shared/settings.ts";
import type { BehaviorOverride } from "../chain-clarify.ts";
import type { Semaphore } from "../../shared/parallel-utils.ts";
import type { ChainStep } from "../../../shared/settings.ts";
import type { ArtifactConfig } from "../../../shared/types.ts";
import type { ChainExecutionDetailsInput, ChainExecutionParams } from "./types.ts";

export interface ChainStepEnv {
	params: ChainExecutionParams;
	chainSteps: ChainStep[];
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	signal?: AbortSignal;
	runId: string;
	cwd?: string;
	shareEnabled: boolean;
	sessionDirForIndex: ChainExecutionParams["sessionDirForIndex"];
	sessionFileForIndex?: ChainExecutionParams["sessionFileForIndex"];
	sessionFileForTask?: ChainExecutionParams["sessionFileForTask"];
	thinkingOverrideForTask?: ChainExecutionParams["thinkingOverrideForTask"];
	artifactsDir: string;
	artifactConfig: ArtifactConfig;
	includeProgress?: boolean;
	onUpdate?: ChainExecutionParams["onUpdate"];
	onControlEvent?: ChainExecutionParams["onControlEvent"];
	controlConfig: ChainExecutionParams["controlConfig"];
	onDetachedExit?: ChainExecutionParams["onDetachedExit"];
	childIntercomTarget?: ChainExecutionParams["childIntercomTarget"];
	orchestratorIntercomTarget?: ChainExecutionParams["orchestratorIntercomTarget"];
	foregroundControl?: ChainExecutionParams["foregroundControl"];
	modelScope?: ChainExecutionParams["modelScope"];
	chainSkills: string[];
	results: SingleResult[];
	outputs: ChainOutputMap;
	dynamicChildren: ChainExecutionDetailsInput["dynamicChildren"];
	dynamicGroupStatuses: ChainExecutionDetailsInput["dynamicGroupStatuses"];
	allProgress: AgentProgress[];
	allArtifactPaths: ArtifactPaths[];
	chainAgents: string[];
	totalSteps: number;
	makeDetailsInput: (overrides?: Pick<Partial<ChainExecutionDetailsInput>, "currentStepIndex" | "currentFlatIndex">) => ChainExecutionDetailsInput;
	originalTask: string;
	chainDir: string;
	templates: ResolvedTemplates;
	tuiBehaviorOverrides: (BehaviorOverride | undefined)[] | undefined;
	availableModels: ModelInfo[];
	deadlineAt: number | undefined;
	globalSemaphore: Semaphore;
}

export interface ChainLoopState {
	prev: string;
	globalTaskIndex: number;
	progressCreated: boolean;
}
