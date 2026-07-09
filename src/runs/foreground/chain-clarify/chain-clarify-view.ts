import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../../agents/agents.ts";
import type { ModelInfo } from "../../../shared/model-info.ts";
import type { ResolvedStepBehavior } from "../../../shared/settings.ts";
import type { BehaviorOverride, ClarifyMode, EditMode } from "./types.ts";

export interface ChainClarifyView {
	readonly width: number;
	readonly theme: Theme;
	readonly mode: ClarifyMode;
	readonly agentConfigs: AgentConfig[];
	readonly templates: string[];
	readonly originalTask: string;
	readonly chainDir: string | undefined;
	readonly resolvedBehaviors: ResolvedStepBehavior[];
	readonly availableModels: ModelInfo[];
	readonly preferredProvider: string | undefined;
	readonly behaviorOverrides: Map<number, BehaviorOverride>;
	readonly selectedStep: number;
	readonly editingStep: number | null;
	readonly editMode: EditMode;
	readonly runInBackground: boolean;
	readonly noticeMessage: { text: string; type: "info" | "error" } | null;
	readonly modelSearchQuery: string;
	readonly modelSelectedIndex: number;
	readonly filteredModels: ModelInfo[];
	readonly thinkingSelectedIndex: number;
	readonly skillSearchQuery: string;
	readonly skillSelectedNames: Set<string>;
	readonly skillCursorIndex: number;
	readonly filteredSkills: Array<{ name: string; source: string; description?: string }>;
	readonly editViewportHeight: number;
}
