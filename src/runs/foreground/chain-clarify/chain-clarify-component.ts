/**
 * Chain Clarification TUI Component.
 *
 * `ChainClarifyComponent` owns the interactive state (selection, edit buffers,
 * behavior overrides) and the public TUI surface (constructor, handleInput,
 * render, invalidate, dispose). Mutation handlers + behavior helpers live in
 * the sibling submodules of `./chain-clarify/` as free functions that receive
 * this component.
 *
 * NOTE: fields are `public` (not `private`) so the extracted input handlers can
 * read/mutate them. TypeScript `private` is compile-time-only and erased at
 * runtime, so this relaxation produces byte-identical JavaScript and identical
 * behavior (R2). Field names and types are unchanged.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../../../agents/agents.ts";
import type { ResolvedStepBehavior } from "../../../shared/settings.ts";
import type { ModelInfo, ThinkingLevel } from "../../../shared/model-info.ts";
import type { BehaviorOverride, ChainClarifyResult, ClarifyMode, EditMode } from "./types.ts";
import type { ChainClarifyView } from "./chain-clarify-view.ts";
import { renderFullEditModeView, renderModelSelectorView, renderSkillSelectorView, renderThinkingSelectorView } from "./chain-clarify-selectors.ts";
import { renderChainModeView, renderParallelModeView, renderSingleModeView } from "./chain-clarify-modes.ts";
import { createEditorState, type TextEditorState } from "./text-editor.ts";
import {
	enterEditMode,
	getEffectiveBehavior,
	getEffectiveModel,
	handleEditInput,
	updateBehavior,
} from "./chain-clarify-input.ts";
import {
	applyThinkingLevel,
	enterModelSelector,
	enterThinkingSelector,
	handleModelSelectorInput,
	handleSkillSelectorInput,
	handleThinkingSelectorInput,
} from "./chain-clarify-selector-input.ts";

/**
 * TUI component for chain clarification.
 * Factory signature matches ctx.ui.custom: (tui, theme, kb, done) => Component
 */
export class ChainClarifyComponent implements Component {
	readonly width = 84;

	selectedStep = 0;
	editingStep: number | null = null;
	editMode: EditMode = "template";
	editState: TextEditorState = createEditorState();

	readonly EDIT_VIEWPORT_HEIGHT = 12;
	behaviorOverrides: Map<number, BehaviorOverride> = new Map();
	modelSearchQuery = "";
	modelSelectedIndex = 0;
	filteredModels: ModelInfo[] = [];
	thinkingSelectedIndex = 0;
	skillSearchQuery = "";
	skillSelectedNames: Set<string> = new Set();
	skillCursorIndex = 0;
	filteredSkills: Array<{ name: string; source: string; description?: string }> = [];
	noticeMessage: { text: string; type: "info" | "error" } | null = null;
	noticeMessageTimer: ReturnType<typeof setTimeout> | null = null;
	runInBackground = false;
	tui: TUI;
	theme: Theme;
	agentConfigs: AgentConfig[];
	templates: string[];
	originalTask: string;
	chainDir: string | undefined;
	resolvedBehaviors: ResolvedStepBehavior[];
	availableModels: ModelInfo[];
	preferredProvider: string | undefined;
	availableSkills: Array<{ name: string; source: string; description?: string }>;
	done: (result: ChainClarifyResult) => void;
	mode: ClarifyMode;

	constructor(
		tui: TUI,
		theme: Theme,
		agentConfigs: AgentConfig[],
		templates: string[],
		originalTask: string,
		chainDir: string | undefined,
		resolvedBehaviors: ResolvedStepBehavior[],
		availableModels: ModelInfo[],
		preferredProvider: string | undefined,
		availableSkills: Array<{ name: string; source: string; description?: string }>,
		done: (result: ChainClarifyResult) => void,
		mode: ClarifyMode = 'chain',
	) {
		this.tui = tui;
		this.theme = theme;
		this.agentConfigs = agentConfigs;
		this.templates = templates;
		this.originalTask = originalTask;
		this.chainDir = chainDir;
		this.resolvedBehaviors = resolvedBehaviors;
		this.availableModels = availableModels;
		this.preferredProvider = preferredProvider;
		this.availableSkills = availableSkills;
		this.done = done;
		this.mode = mode;
		this.filteredModels = [...availableModels];
		this.filteredSkills = [...availableSkills];
	}

	private buildView(): ChainClarifyView {
		return {
			width: this.width, theme: this.theme, mode: this.mode,
			agentConfigs: this.agentConfigs, templates: this.templates,
			originalTask: this.originalTask, chainDir: this.chainDir,
			resolvedBehaviors: this.resolvedBehaviors, availableModels: this.availableModels,
			preferredProvider: this.preferredProvider, behaviorOverrides: this.behaviorOverrides,
			selectedStep: this.selectedStep, editingStep: this.editingStep, editMode: this.editMode,
			runInBackground: this.runInBackground, noticeMessage: this.noticeMessage,
			modelSearchQuery: this.modelSearchQuery, modelSelectedIndex: this.modelSelectedIndex,
			filteredModels: this.filteredModels, thinkingSelectedIndex: this.thinkingSelectedIndex,
			skillSearchQuery: this.skillSearchQuery, skillSelectedNames: this.skillSelectedNames,
			skillCursorIndex: this.skillCursorIndex, filteredSkills: this.filteredSkills,
			editViewportHeight: this.EDIT_VIEWPORT_HEIGHT,
		};
	}

	getEffectiveModel(stepIndex: number): string {
		return getEffectiveModel(this, stepIndex);
	}

	getEffectiveBehavior(stepIndex: number) {
		return getEffectiveBehavior(this, stepIndex);
	}

	handleInput(data: string): void {
		if (this.editingStep !== null) {
			if (this.editMode === "model") handleModelSelectorInput(this, data);
			else if (this.editMode === "thinking") handleThinkingSelectorInput(this, data);
			else if (this.editMode === "skills") handleSkillSelectorInput(this, data);
			else handleEditInput(this, data);
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ confirmed: false, templates: [], behaviorOverrides: [] });
			return;
		}
		if (matchesKey(data, "return")) {
			const overrides: (BehaviorOverride | undefined)[] = [];
			for (let i = 0; i < this.agentConfigs.length; i++) {
				overrides.push(this.behaviorOverrides.get(i));
			}
			this.done({ confirmed: true, templates: this.templates, behaviorOverrides: overrides, runInBackground: this.runInBackground });
			return;
		}
		if (matchesKey(data, "up")) {
			this.selectedStep = Math.max(0, this.selectedStep - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selectedStep = Math.min(Math.max(0, this.agentConfigs.length - 1), this.selectedStep + 1);
			this.tui.requestRender();
			return;
		}
		if (data === "e") { enterEditMode(this, "template"); return; }
		if (data === "m") { enterModelSelector(this); return; }
		if (data === "t") { enterThinkingSelector(this); return; }
		if (data === "s") { this.enterSkillSelector(); return; }
		if (data === "w" && this.mode !== 'parallel') { enterEditMode(this, "output"); return; }
		if (data === "r" && this.mode === 'chain') { enterEditMode(this, "reads"); return; }
		if (data === "p" && this.mode === 'chain') {
			const newState = !this.agentConfigs.some((_, i) => this.getEffectiveBehavior(i).progress);
			for (let i = 0; i < this.agentConfigs.length; i++) updateBehavior(this, i, "progress", newState);
			this.tui.requestRender();
			return;
		}
		if (data === "b") {
			this.runInBackground = !this.runInBackground;
			this.tui.requestRender();
			return;
		}
	}

	private enterSkillSelector(): void {
		this.editingStep = this.selectedStep;
		this.editMode = "skills";
		this.skillSearchQuery = "";
		this.skillCursorIndex = 0;
		this.filteredSkills = [...this.availableSkills];
		const current = this.getEffectiveBehavior(this.selectedStep).skills;
		this.skillSelectedNames.clear();
		if (current !== false && current.length > 0) {
			current.forEach((skillName) => this.skillSelectedNames.add(skillName));
		}
		this.tui.requestRender();
	}

	enterModelSelector(): void { enterModelSelector(this); }
	enterThinkingSelector(): void { enterThinkingSelector(this); }
	applyThinkingLevel(level: ThinkingLevel): void { applyThinkingLevel(this, level); }
	renderThinkingSelector(): string[] { return renderThinkingSelectorView(this.buildView()); }
	handleModelSelectorInput(data: string): void { handleModelSelectorInput(this, data); }

	render(_width: number): string[] {
		if (this.editingStep !== null) {
			if (this.editMode === "model") return renderModelSelectorView(this.buildView());
			if (this.editMode === "thinking") return this.renderThinkingSelector();
			if (this.editMode === "skills") return renderSkillSelectorView(this.buildView());
			const result = renderFullEditModeView(this.buildView(), this.editState);
			this.editState = result.editState;
			return result.lines;
		}
		switch (this.mode) {
			case 'single': return renderSingleModeView(this.buildView());
			case 'parallel': return renderParallelModeView(this.buildView());
			case 'chain': return renderChainModeView(this.buildView());
		}
	}

	invalidate(): void {}
	dispose(): void {
		if (this.noticeMessageTimer) clearTimeout(this.noticeMessageTimer);
		this.noticeMessageTimer = null;
	}
}
