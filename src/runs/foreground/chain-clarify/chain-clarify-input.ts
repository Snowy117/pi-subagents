/**
 * Behavior helpers + edit-mode input handlers extracted from
 * `ChainClarifyComponent`.
 *
 * These functions take the component as their first parameter and read/mutate
 * its public fields (`component.X` stands in for the original `this.X`).
 * `private` on the component was relaxed to `public` to enable this extraction;
 * TypeScript `private` is compile-time-only and erased at runtime, so the
 * emitted JavaScript is byte-identical and behavior is unchanged (R2).
 *
 * Selector-specific handlers (model/thinking/skill navigation) live in the
 * sibling `chain-clarify-selector-input.ts`.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "../../../shared/model-info.ts";
import { splitThinkingSuffix } from "../../shared/model-fallback.ts";
import { computeAvailableThinkingLevels, computeEffectiveBehavior, computeEffectiveModel } from "./chain-clarify-behavior.ts";
import type { ChainClarifyComponent } from "./chain-clarify-component.ts";
import type { BehaviorOverride, EditMode } from "./types.ts";
import { createEditorState } from "./text-editor.ts";
import { getCursorDisplayPos, handleEditorInput, wrapText } from "./text-editor.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Behavior helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getEffectiveBehavior(component: ChainClarifyComponent, stepIndex: number) {
	return computeEffectiveBehavior(component.resolvedBehaviors, component.behaviorOverrides, stepIndex);
}

export function getEffectiveModel(component: ChainClarifyComponent, stepIndex: number): string {
	return computeEffectiveModel(component.resolvedBehaviors, component.behaviorOverrides, component.availableModels, component.preferredProvider, stepIndex);
}

export function getAvailableThinkingLevels(component: ChainClarifyComponent, stepIndex: number): ThinkingLevel[] {
	return computeAvailableThinkingLevels(component.resolvedBehaviors, component.behaviorOverrides, component.availableModels, component.preferredProvider, stepIndex);
}

export function updateBehavior(component: ChainClarifyComponent, stepIndex: number, field: keyof BehaviorOverride, value: string | boolean | string[] | false): void {
	const existing = component.behaviorOverrides.get(stepIndex) ?? {};
	component.behaviorOverrides.set(stepIndex, { ...existing, [field]: value });
}

export function showNotice(component: ChainClarifyComponent, text: string, type: "info" | "error"): void {
	component.noticeMessage = { text, type };
	if (component.noticeMessageTimer) clearTimeout(component.noticeMessageTimer);
	component.noticeMessageTimer = setTimeout(() => {
		component.noticeMessage = null;
		component.noticeMessageTimer = null;
		component.tui.requestRender();
	}, 2000);
	component.tui.requestRender();
}

/** Exit edit mode and reset state */
export function exitEditMode(component: ChainClarifyComponent): void {
	component.editingStep = null;
	component.editState = createEditorState();
	component.tui.requestRender();
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit entry + apply thinking
// ─────────────────────────────────────────────────────────────────────────────

export function enterEditMode(component: ChainClarifyComponent, mode: EditMode): void {
	component.editingStep = component.selectedStep;
	component.editMode = mode;
	let buffer = "";

	if (mode === "template") {
		const template = component.templates[component.selectedStep] ?? "";
		buffer = template.split("\n")[0] ?? "";
	} else if (mode === "output") {
		const behavior = getEffectiveBehavior(component, component.selectedStep);
		buffer = behavior.output === false ? "" : (behavior.output || "");
	} else if (mode === "reads") {
		const behavior = getEffectiveBehavior(component, component.selectedStep);
		buffer = behavior.reads === false ? "" : (behavior.reads?.join(", ") || "");
	}

	component.editState = createEditorState(buffer);
	component.tui.requestRender();
}

export function applyThinkingLevel(component: ChainClarifyComponent, level: ThinkingLevel): void {
	const stepIndex = component.editingStep!;
	const currentModel = getEffectiveBehavior(component, stepIndex).model;
	if (!currentModel) return;

	const { baseModel } = splitThinkingSuffix(currentModel);
	const newModel = level === "off" ? baseModel : `${baseModel}:${level}`;
	updateBehavior(component, stepIndex, "model", newModel);
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit input + save
// ─────────────────────────────────────────────────────────────────────────────

export function handleEditInput(component: ChainClarifyComponent, data: string): void {
	const textWidth = component.width - 4; // Must match render: innerW - 2 = (width - 2) - 2
	if (matchesKey(data, "shift+up") || matchesKey(data, "pageup")) {
		const { lines: wrapped, starts } = wrapText(component.editState.buffer, textWidth);
		const cursorPos = getCursorDisplayPos(component.editState.cursor, starts);
		const targetLine = Math.max(0, cursorPos.line - component.EDIT_VIEWPORT_HEIGHT);
		const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0);
		component.editState = { ...component.editState, cursor: starts[targetLine] + targetCol };
		component.tui.requestRender();
		return;
	}

	if (matchesKey(data, "shift+down") || matchesKey(data, "pagedown")) {
		const { lines: wrapped, starts } = wrapText(component.editState.buffer, textWidth);
		const cursorPos = getCursorDisplayPos(component.editState.cursor, starts);
		const targetLine = Math.min(wrapped.length - 1, cursorPos.line + component.EDIT_VIEWPORT_HEIGHT);
		const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0);
		component.editState = { ...component.editState, cursor: starts[targetLine] + targetCol };
		component.tui.requestRender();
		return;
	}

	if (matchesKey(data, "tab")) return;

	const nextState = handleEditorInput(component.editState, data, textWidth);
	if (nextState) {
		component.editState = nextState;
		component.tui.requestRender();
		return;
	}

	if (matchesKey(data, "escape")) {
		saveEdit(component);
		exitEditMode(component);
		return;
	}

	if (matchesKey(data, "ctrl+c")) {
		exitEditMode(component);
		return;
	}
}

export function saveEdit(component: ChainClarifyComponent): void {
	const stepIndex = component.editingStep!;

	if (component.editMode === "template") {
		const original = component.templates[stepIndex] ?? "";
		const originalLines = original.split("\n");
		originalLines[0] = component.editState.buffer;
		component.templates[stepIndex] = originalLines.join("\n");
	} else if (component.editMode === "output") {
		const oldBehavior = getEffectiveBehavior(component, stepIndex);
		const oldOutput = typeof oldBehavior.output === "string" ? oldBehavior.output : null;

		const trimmed = component.editState.buffer.trim();
		const newOutput = trimmed === "" ? false : trimmed;
		updateBehavior(component, stepIndex, "output", newOutput);

		if (oldOutput && typeof newOutput === "string" && oldOutput !== newOutput) {
			propagateOutputChange(component, stepIndex, oldOutput, newOutput);
		}
	} else if (component.editMode === "reads") {
		const trimmed = component.editState.buffer.trim();
		if (trimmed === "") {
			updateBehavior(component, stepIndex, "reads", false);
		} else {
			const files = trimmed.split(",").map(f => f.trim()).filter(f => f !== "");
			updateBehavior(component, stepIndex, "reads", files.length > 0 ? files : false);
		}
	}
}

/**
 * When a step's output filename changes, update downstream steps that read from it.
 * This maintains the chain dependency automatically.
 */
export function propagateOutputChange(component: ChainClarifyComponent, changedStepIndex: number, oldOutput: string, newOutput: string): void {
	for (let i = changedStepIndex + 1; i < component.agentConfigs.length; i++) {
		const behavior = getEffectiveBehavior(component, i);

		if (behavior.reads === false || !behavior.reads || behavior.reads.length === 0) {
			continue;
		}

		const readsArray = behavior.reads;
		const oldIndex = readsArray.indexOf(oldOutput);

		if (oldIndex !== -1) {
			const newReads = [...readsArray];
			newReads[oldIndex] = newOutput;
			updateBehavior(component, i, "reads", newReads);
		}
	}
}
