/**
 * Chain Clarification TUI Component.
 *
 * `ChainClarifyComponent` owns the interactive state (selection, edit buffers,
 * behavior overrides) and the input handlers that mutate it. Pure rendering and
 * behavior-derivation logic live in the sibling submodules of `./chain-clarify/`:
 *
 * - `chain-clarify-format.ts` — border/row/header/footer primitives
 * - `chain-clarify-behavior.ts` — effective behavior/model/thinking readers
 * - `chain-clarify-selectors.ts` — model/thinking/skill/full-edit selector views
 * - `chain-clarify-modes.ts` — single/parallel/chain navigation views
 * - `chain-clarify-view.ts` — the read-only `ChainClarifyView` projection
 *
 * Renderers receive a `ChainClarifyView` (a fresh snapshot of the private state
 * built by `buildView`) so no field visibility needs to change. Mutation stays
 * entirely within this class.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../../../agents/agents.ts";
import type { ResolvedStepBehavior } from "../../../shared/settings.ts";
import { splitThinkingSuffix } from "../../shared/model-fallback.ts";
import { findModelInfo, getSupportedThinkingLevels, type ModelInfo, type ThinkingLevel } from "../../../shared/model-info.ts";
import type { BehaviorOverride, ChainClarifyResult, ClarifyMode, EditMode } from "./types.ts";
import { computeAvailableThinkingLevels, computeEffectiveBehavior, computeEffectiveModel } from "./chain-clarify-behavior.ts";
import type { ChainClarifyView } from "./chain-clarify-view.ts";
import { renderFullEditModeView, renderModelSelectorView, renderSkillSelectorView, renderThinkingSelectorView } from "./chain-clarify-selectors.ts";
import { renderChainModeView, renderParallelModeView, renderSingleModeView } from "./chain-clarify-modes.ts";
import { createEditorState, handleEditorInput, wrapText, getCursorDisplayPos, type TextEditorState } from "./text-editor.ts";

/**
 * TUI component for chain clarification.
 * Factory signature matches ctx.ui.custom: (tui, theme, kb, done) => Component
 */
export class ChainClarifyComponent implements Component {
	readonly width = 84;

	private selectedStep = 0;
	private editingStep: number | null = null;
	private editMode: EditMode = "template";
	private editState: TextEditorState = createEditorState();

	private readonly EDIT_VIEWPORT_HEIGHT = 12;
	private behaviorOverrides: Map<number, BehaviorOverride> = new Map();
	private modelSearchQuery: string = "";
	private modelSelectedIndex: number = 0;
	private filteredModels: ModelInfo[] = [];
	private thinkingSelectedIndex: number = 0;
	private skillSearchQuery: string = "";
	private skillSelectedNames: Set<string> = new Set();
	private skillCursorIndex: number = 0;
	private filteredSkills: Array<{ name: string; source: string; description?: string }> = [];
	private noticeMessage: { text: string; type: "info" | "error" } | null = null;
	private noticeMessageTimer: ReturnType<typeof setTimeout> | null = null;
	/** Run in background (async) mode */
	private runInBackground = false;
	private tui: TUI;
	private theme: Theme;
	private agentConfigs: AgentConfig[];
	private templates: string[];
	private originalTask: string;
	private chainDir: string | undefined;
	private resolvedBehaviors: ResolvedStepBehavior[];
	private availableModels: ModelInfo[];
	private preferredProvider: string | undefined;
	private availableSkills: Array<{ name: string; source: string; description?: string }>;
	private done: (result: ChainClarifyResult) => void;
	private mode: ClarifyMode;

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
			width: this.width,
			theme: this.theme,
			mode: this.mode,
			agentConfigs: this.agentConfigs,
			templates: this.templates,
			originalTask: this.originalTask,
			chainDir: this.chainDir,
			resolvedBehaviors: this.resolvedBehaviors,
			availableModels: this.availableModels,
			preferredProvider: this.preferredProvider,
			behaviorOverrides: this.behaviorOverrides,
			selectedStep: this.selectedStep,
			editingStep: this.editingStep,
			editMode: this.editMode,
			runInBackground: this.runInBackground,
			noticeMessage: this.noticeMessage,
			modelSearchQuery: this.modelSearchQuery,
			modelSelectedIndex: this.modelSelectedIndex,
			filteredModels: this.filteredModels,
			thinkingSelectedIndex: this.thinkingSelectedIndex,
			skillSearchQuery: this.skillSearchQuery,
			skillSelectedNames: this.skillSelectedNames,
			skillCursorIndex: this.skillCursorIndex,
			filteredSkills: this.filteredSkills,
			editViewportHeight: this.EDIT_VIEWPORT_HEIGHT,
		};
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Behavior helpers (delegate to chain-clarify-behavior.ts)
	// ─────────────────────────────────────────────────────────────────────────────

	private getEffectiveBehavior(stepIndex: number): ResolvedStepBehavior {
		return computeEffectiveBehavior(this.resolvedBehaviors, this.behaviorOverrides, stepIndex);
	}

	private getEffectiveModel(stepIndex: number): string {
		return computeEffectiveModel(this.resolvedBehaviors, this.behaviorOverrides, this.availableModels, this.preferredProvider, stepIndex);
	}

	private getAvailableThinkingLevels(stepIndex: number): ThinkingLevel[] {
		return computeAvailableThinkingLevels(this.resolvedBehaviors, this.behaviorOverrides, this.availableModels, this.preferredProvider, stepIndex);
	}

	private updateBehavior(stepIndex: number, field: keyof BehaviorOverride, value: string | boolean | string[] | false): void {
		const existing = this.behaviorOverrides.get(stepIndex) ?? {};
		this.behaviorOverrides.set(stepIndex, { ...existing, [field]: value });
	}

	private showNotice(text: string, type: "info" | "error"): void {
		this.noticeMessage = { text, type };
		if (this.noticeMessageTimer) clearTimeout(this.noticeMessageTimer);
		this.noticeMessageTimer = setTimeout(() => {
			this.noticeMessage = null;
			this.noticeMessageTimer = null;
			this.tui.requestRender();
		}, 2000);
		this.tui.requestRender();
	}

	/** Exit edit mode and reset state */
	private exitEditMode(): void {
		this.editingStep = null;
		this.editState = createEditorState();
		this.tui.requestRender();
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Input handling
	// ─────────────────────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.editingStep !== null) {
			if (this.editMode === "model") {
				this.handleModelSelectorInput(data);
			} else if (this.editMode === "thinking") {
				this.handleThinkingSelectorInput(data);
			} else if (this.editMode === "skills") {
				this.handleSkillSelectorInput(data);
			} else {
				this.handleEditInput(data);
			}
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
			const maxStep = Math.max(0, this.agentConfigs.length - 1);
			this.selectedStep = Math.min(maxStep, this.selectedStep + 1);
			this.tui.requestRender();
			return;
		}

		if (data === "e") {
			this.enterEditMode("template");
			return;
		}

		if (data === "m") {
			this.enterModelSelector();
			return;
		}

		if (data === "t") {
			this.enterThinkingSelector();
			return;
		}

		if (data === "s") {
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
			return;
		}

		if (data === "w" && this.mode !== 'parallel') {
			this.enterEditMode("output");
			return;
		}

		if (data === "r" && this.mode === 'chain') {
			this.enterEditMode("reads");
			return;
		}

		if (data === "p" && this.mode === 'chain') {
			const anyEnabled = this.agentConfigs.some((_, i) => this.getEffectiveBehavior(i).progress);
			const newState = !anyEnabled;
			for (let i = 0; i < this.agentConfigs.length; i++) {
				this.updateBehavior(i, "progress", newState);
			}
			this.tui.requestRender();
			return;
		}

		if (data === "b") {
			this.runInBackground = !this.runInBackground;
			this.tui.requestRender();
			return;
		}

	}

	private enterEditMode(mode: EditMode): void {
		this.editingStep = this.selectedStep;
		this.editMode = mode;
		let buffer = "";

		if (mode === "template") {
			const template = this.templates[this.selectedStep] ?? "";
			buffer = template.split("\n")[0] ?? "";
		} else if (mode === "output") {
			const behavior = this.getEffectiveBehavior(this.selectedStep);
			buffer = behavior.output === false ? "" : (behavior.output || "");
		} else if (mode === "reads") {
			const behavior = this.getEffectiveBehavior(this.selectedStep);
			buffer = behavior.reads === false ? "" : (behavior.reads?.join(", ") || "");
		}

		this.editState = createEditorState(buffer);
		this.tui.requestRender();
	}

	/** Enter model selector mode */
	private enterModelSelector(): void {
		this.editingStep = this.selectedStep;
		this.editMode = "model";
		this.modelSearchQuery = "";
		this.modelSelectedIndex = 0;
		this.filteredModels = [...this.availableModels];
		const currentModel = splitThinkingSuffix(this.getEffectiveModel(this.selectedStep)).baseModel;
		const currentIndex = this.filteredModels.findIndex((m) => m.fullId === currentModel || m.id === currentModel);
		if (currentIndex >= 0) {
			this.modelSelectedIndex = currentIndex;
		}

		this.tui.requestRender();
	}

	/** Filter models based on search query */
	private filterModels(): void {
		const query = this.modelSearchQuery.toLowerCase();
		if (!query) {
			this.filteredModels = [...this.availableModels];
		} else {
			this.filteredModels = this.availableModels.filter((m) =>
				m.fullId.toLowerCase().includes(query) ||
				m.id.toLowerCase().includes(query) ||
				m.provider.toLowerCase().includes(query)
			);
		}
		this.modelSelectedIndex = Math.min(this.modelSelectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private handleModelSelectorInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return;
		}

		if (matchesKey(data, "return")) {
			const selected = this.filteredModels[this.modelSelectedIndex];
			if (selected) {
				const { thinkingSuffix } = splitThinkingSuffix(this.getEffectiveModel(this.editingStep!));
				const requestedLevel = thinkingSuffix.slice(1);
				const selectedModel = findModelInfo(selected.fullId, this.availableModels, this.preferredProvider);
				const suffix = getSupportedThinkingLevels(selectedModel).some((level) => level === requestedLevel) ? thinkingSuffix : "";
				this.updateBehavior(this.editingStep!, "model", `${selected.fullId}${suffix}`);
			}
			this.exitEditMode();
			return;
		}

		if (matchesKey(data, "up")) {
			if (this.filteredModels.length > 0) {
				this.modelSelectedIndex = this.modelSelectedIndex === 0
					? this.filteredModels.length - 1
					: this.modelSelectedIndex - 1;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.filteredModels.length > 0) {
				this.modelSelectedIndex = this.modelSelectedIndex === this.filteredModels.length - 1
					? 0
					: this.modelSelectedIndex + 1;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.modelSearchQuery.length > 0) {
				this.modelSearchQuery = this.modelSearchQuery.slice(0, -1);
				this.filterModels();
			}
			this.tui.requestRender();
			return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.modelSearchQuery += data;
			this.filterModels();
			this.tui.requestRender();
			return;
		}
	}

	/** Enter thinking level selector mode */
	private enterThinkingSelector(): void {
		if (!this.getEffectiveBehavior(this.selectedStep).model) {
			this.showNotice("Select a model first", "error");
			return;
		}
		this.editingStep = this.selectedStep;
		this.editMode = "thinking";

		const levels = this.getAvailableThinkingLevels(this.selectedStep);
		const { thinkingSuffix } = splitThinkingSuffix(this.getEffectiveModel(this.selectedStep));
		const suffix = thinkingSuffix.slice(1);
		const levelIdx = levels.findIndex((level) => level === suffix);
		this.thinkingSelectedIndex = levelIdx >= 0 ? levelIdx : Math.max(0, levels.indexOf("off"));

		this.tui.requestRender();
	}

	private handleThinkingSelectorInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return;
		}

		const levels = this.getAvailableThinkingLevels(this.editingStep!);
		if (levels.length === 0) return;

		if (matchesKey(data, "return")) {
			const selectedLevel = levels[this.thinkingSelectedIndex] ?? "off";
			this.applyThinkingLevel(selectedLevel);
			this.exitEditMode();
			return;
		}

		if (matchesKey(data, "up")) {
			this.thinkingSelectedIndex = this.thinkingSelectedIndex === 0
				? levels.length - 1
				: this.thinkingSelectedIndex - 1;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			this.thinkingSelectedIndex = this.thinkingSelectedIndex === levels.length - 1
				? 0
				: this.thinkingSelectedIndex + 1;
			this.tui.requestRender();
			return;
		}
	}

	/** Apply thinking level to the current step's model */
	private applyThinkingLevel(level: ThinkingLevel): void {
		const stepIndex = this.editingStep!;
		const currentModel = this.getEffectiveBehavior(stepIndex).model;
		if (!currentModel) return;

		const { baseModel } = splitThinkingSuffix(currentModel);
		const newModel = level === "off" ? baseModel : `${baseModel}:${level}`;
		this.updateBehavior(stepIndex, "model", newModel);
	}

	private filterSkills(): void {
		const query = this.skillSearchQuery.toLowerCase();
		if (!query) {
			this.filteredSkills = [...this.availableSkills];
		} else {
			this.filteredSkills = this.availableSkills.filter((s) =>
				s.name.toLowerCase().includes(query) ||
				(s.description?.toLowerCase().includes(query) ?? false),
			);
		}
		this.skillCursorIndex = Math.min(this.skillCursorIndex, Math.max(0, this.filteredSkills.length - 1));
	}

	private handleSkillSelectorInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return;
		}

		if (matchesKey(data, "return")) {
			const selected = [...this.skillSelectedNames];
			this.updateBehavior(this.editingStep!, "skills", selected);
			this.exitEditMode();
			return;
		}

		if (data === " ") {
			if (this.filteredSkills.length > 0) {
				const skill = this.filteredSkills[this.skillCursorIndex];
				if (skill) {
					if (this.skillSelectedNames.has(skill.name)) {
						this.skillSelectedNames.delete(skill.name);
					} else {
						this.skillSelectedNames.add(skill.name);
					}
				}
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "up")) {
			if (this.filteredSkills.length > 0) {
				this.skillCursorIndex = this.skillCursorIndex === 0
					? this.filteredSkills.length - 1
					: this.skillCursorIndex - 1;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.filteredSkills.length > 0) {
				this.skillCursorIndex = this.skillCursorIndex === this.filteredSkills.length - 1
					? 0
					: this.skillCursorIndex + 1;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.skillSearchQuery.length > 0) {
				this.skillSearchQuery = this.skillSearchQuery.slice(0, -1);
				this.filterSkills();
			}
			this.tui.requestRender();
			return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.skillSearchQuery += data;
			this.filterSkills();
			this.tui.requestRender();
			return;
		}
	}

	private handleEditInput(data: string): void {
		const textWidth = this.width - 4; // Must match render: innerW - 2 = (width - 2) - 2
		if (matchesKey(data, "shift+up") || matchesKey(data, "pageup")) {
			const { lines: wrapped, starts } = wrapText(this.editState.buffer, textWidth);
			const cursorPos = getCursorDisplayPos(this.editState.cursor, starts);
			const targetLine = Math.max(0, cursorPos.line - this.EDIT_VIEWPORT_HEIGHT);
			const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0);
			this.editState = { ...this.editState, cursor: starts[targetLine] + targetCol };
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "shift+down") || matchesKey(data, "pagedown")) {
			const { lines: wrapped, starts } = wrapText(this.editState.buffer, textWidth);
			const cursorPos = getCursorDisplayPos(this.editState.cursor, starts);
			const targetLine = Math.min(wrapped.length - 1, cursorPos.line + this.EDIT_VIEWPORT_HEIGHT);
			const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0);
			this.editState = { ...this.editState, cursor: starts[targetLine] + targetCol };
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "tab")) return;

		const nextState = handleEditorInput(this.editState, data, textWidth);
		if (nextState) {
			this.editState = nextState;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "escape")) {
			this.saveEdit();
			this.exitEditMode();
			return;
		}

		if (matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return;
		}
	}

	private saveEdit(): void {
		const stepIndex = this.editingStep!;

		if (this.editMode === "template") {
			// For template, preserve other lines if they existed
			const original = this.templates[stepIndex] ?? "";
			const originalLines = original.split("\n");
			originalLines[0] = this.editState.buffer;
			this.templates[stepIndex] = originalLines.join("\n");
		} else if (this.editMode === "output") {
			// Capture OLD output before updating (for downstream propagation)
			const oldBehavior = this.getEffectiveBehavior(stepIndex);
			const oldOutput = typeof oldBehavior.output === "string" ? oldBehavior.output : null;

			// Empty string or whitespace means disable output
			const trimmed = this.editState.buffer.trim();
			const newOutput = trimmed === "" ? false : trimmed;
			this.updateBehavior(stepIndex, "output", newOutput);

			// Propagate output filename change to downstream steps' reads
			if (oldOutput && typeof newOutput === "string" && oldOutput !== newOutput) {
				this.propagateOutputChange(stepIndex, oldOutput, newOutput);
			}
		} else if (this.editMode === "reads") {
			// Parse comma-separated list, empty means disable reads
			const trimmed = this.editState.buffer.trim();
			if (trimmed === "") {
				this.updateBehavior(stepIndex, "reads", false);
			} else {
				const files = trimmed.split(",").map(f => f.trim()).filter(f => f !== "");
				this.updateBehavior(stepIndex, "reads", files.length > 0 ? files : false);
			}
		}
	}

	/**
	 * When a step's output filename changes, update downstream steps that read from it.
	 * This maintains the chain dependency automatically.
	 */
	private propagateOutputChange(changedStepIndex: number, oldOutput: string, newOutput: string): void {
		// Check all downstream steps (steps that come after the changed step)
		for (let i = changedStepIndex + 1; i < this.agentConfigs.length; i++) {
			const behavior = this.getEffectiveBehavior(i);

			// Skip if reads is disabled or empty
			if (behavior.reads === false || !behavior.reads || behavior.reads.length === 0) {
				continue;
			}

			// Check if this step reads the old output file
			const readsArray = behavior.reads;
			const oldIndex = readsArray.indexOf(oldOutput);

			if (oldIndex !== -1) {
				// Replace old filename with new filename in reads
				const newReads = [...readsArray];
				newReads[oldIndex] = newOutput;
				this.updateBehavior(i, "reads", newReads);
			}
		}
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Rendering (delegates to chain-clarify-selectors.ts / chain-clarify-modes.ts)
	// ─────────────────────────────────────────────────────────────────────────────

	render(_width: number): string[] {
		if (this.editingStep !== null) {
			if (this.editMode === "model") {
				return renderModelSelectorView(this.buildView());
			}
			if (this.editMode === "thinking") {
				return this.renderThinkingSelector();
			}
			if (this.editMode === "skills") {
				return renderSkillSelectorView(this.buildView());
			}
			const result = renderFullEditModeView(this.buildView(), this.editState);
			this.editState = result.editState;
			return result.lines;
		}
		// Mode-based navigation rendering
		switch (this.mode) {
			case 'single': return renderSingleModeView(this.buildView());
			case 'parallel': return renderParallelModeView(this.buildView());
			case 'chain': return renderChainModeView(this.buildView());
		}
	}

	/** Render the thinking level selector view */
	private renderThinkingSelector(): string[] {
		return renderThinkingSelectorView(this.buildView());
	}

	invalidate(): void {}
	dispose(): void {
		if (this.noticeMessageTimer) clearTimeout(this.noticeMessageTimer);
		this.noticeMessageTimer = null;
	}
}
