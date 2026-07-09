/**
 * Selector input handlers for the chain clarification TUI component.
 *
 * Extracted from `ChainClarifyComponent`: the model/thinking/skill selector
 * entry functions, search filters, and key-by-key selector navigation. Each
 * function takes the component as its first parameter and reads/mutates its
 * public fields (`component.X` stands in for the original `this.X`). Behavior
 * is byte-identical to the original class methods (R2).
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { findModelInfo, getSupportedThinkingLevels } from "../../../shared/model-info.ts";
import type { ThinkingLevel } from "../../../shared/model-info.ts";
import { splitThinkingSuffix } from "../../shared/model-fallback.ts";
import type { ChainClarifyComponent } from "./chain-clarify-component.ts";
import {
	applyThinkingLevel as applyThinkingLevelTo,
	exitEditMode,
	getAvailableThinkingLevels,
	getEffectiveBehavior,
	getEffectiveModel,
	showNotice,
	updateBehavior,
} from "./chain-clarify-input.ts";

/** Enter model selector mode */
export function enterModelSelector(component: ChainClarifyComponent): void {
	component.editingStep = component.selectedStep;
	component.editMode = "model";
	component.modelSearchQuery = "";
	component.modelSelectedIndex = 0;
	component.filteredModels = [...component.availableModels];
	const currentModel = splitThinkingSuffix(getEffectiveModel(component, component.selectedStep)).baseModel;
	const currentIndex = component.filteredModels.findIndex((m) => m.fullId === currentModel || m.id === currentModel);
	if (currentIndex >= 0) {
		component.modelSelectedIndex = currentIndex;
	}

	component.tui.requestRender();
}

/** Enter thinking level selector mode */
export function enterThinkingSelector(component: ChainClarifyComponent): void {
	if (!getEffectiveBehavior(component, component.selectedStep).model) {
		showNotice(component, "Select a model first", "error");
		return;
	}
	component.editingStep = component.selectedStep;
	component.editMode = "thinking";

	const levels = getAvailableThinkingLevels(component, component.selectedStep);
	const { thinkingSuffix } = splitThinkingSuffix(getEffectiveModel(component, component.selectedStep));
	const suffix = thinkingSuffix.slice(1);
	const levelIdx = levels.findIndex((level) => level === suffix);
	component.thinkingSelectedIndex = levelIdx >= 0 ? levelIdx : Math.max(0, levels.indexOf("off"));

	component.tui.requestRender();
}

/** Apply thinking level to the current step's model */
export function applyThinkingLevel(component: ChainClarifyComponent, level: ThinkingLevel): void {
	applyThinkingLevelTo(component, level);
}

/** Filter models based on search query */
export function filterModels(component: ChainClarifyComponent): void {
	const query = component.modelSearchQuery.toLowerCase();
	if (!query) {
		component.filteredModels = [...component.availableModels];
	} else {
		component.filteredModels = component.availableModels.filter((m) =>
			m.fullId.toLowerCase().includes(query) ||
			m.id.toLowerCase().includes(query) ||
			m.provider.toLowerCase().includes(query)
		);
	}
	component.modelSelectedIndex = Math.min(component.modelSelectedIndex, Math.max(0, component.filteredModels.length - 1));
}

export function filterSkills(component: ChainClarifyComponent): void {
	const query = component.skillSearchQuery.toLowerCase();
	if (!query) {
		component.filteredSkills = [...component.availableSkills];
	} else {
		component.filteredSkills = component.availableSkills.filter((s) =>
			s.name.toLowerCase().includes(query) ||
			(s.description?.toLowerCase().includes(query) ?? false),
		);
	}
	component.skillCursorIndex = Math.min(component.skillCursorIndex, Math.max(0, component.filteredSkills.length - 1));
}

export function handleModelSelectorInput(component: ChainClarifyComponent, data: string): void {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
		exitEditMode(component);
		return;
	}

	if (matchesKey(data, "return")) {
		const selected = component.filteredModels[component.modelSelectedIndex];
		if (selected) {
			const { thinkingSuffix } = splitThinkingSuffix(getEffectiveModel(component, component.editingStep!));
			const requestedLevel = thinkingSuffix.slice(1);
			const selectedModel = findModelInfo(selected.fullId, component.availableModels, component.preferredProvider);
			const suffix = getSupportedThinkingLevels(selectedModel).some((level) => level === requestedLevel) ? thinkingSuffix : "";
			updateBehavior(component, component.editingStep!, "model", `${selected.fullId}${suffix}`);
		}
		exitEditMode(component);
		return;
	}

	if (matchesKey(data, "up")) {
		if (component.filteredModels.length > 0) {
			component.modelSelectedIndex = component.modelSelectedIndex === 0
				? component.filteredModels.length - 1
				: component.modelSelectedIndex - 1;
		}
		component.tui.requestRender();
		return;
	}

	if (matchesKey(data, "down")) {
		if (component.filteredModels.length > 0) {
			component.modelSelectedIndex = component.modelSelectedIndex === component.filteredModels.length - 1
				? 0
				: component.modelSelectedIndex + 1;
		}
		component.tui.requestRender();
		return;
	}

	if (matchesKey(data, "backspace")) {
		if (component.modelSearchQuery.length > 0) {
			component.modelSearchQuery = component.modelSearchQuery.slice(0, -1);
			filterModels(component);
		}
		component.tui.requestRender();
		return;
	}

	if (data.length === 1 && data.charCodeAt(0) >= 32) {
		component.modelSearchQuery += data;
		filterModels(component);
		component.tui.requestRender();
		return;
	}
}

export function handleThinkingSelectorInput(component: ChainClarifyComponent, data: string): void {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
		exitEditMode(component);
		return;
	}

	const levels = getAvailableThinkingLevels(component, component.editingStep!);
	if (levels.length === 0) return;

	if (matchesKey(data, "return")) {
		const selectedLevel = levels[component.thinkingSelectedIndex] ?? "off";
		applyThinkingLevelTo(component, selectedLevel);
		exitEditMode(component);
		return;
	}

	if (matchesKey(data, "up")) {
		component.thinkingSelectedIndex = component.thinkingSelectedIndex === 0
			? levels.length - 1
			: component.thinkingSelectedIndex - 1;
		component.tui.requestRender();
		return;
	}

	if (matchesKey(data, "down")) {
		component.thinkingSelectedIndex = component.thinkingSelectedIndex === levels.length - 1
			? 0
			: component.thinkingSelectedIndex + 1;
		component.tui.requestRender();
		return;
	}
}

export function handleSkillSelectorInput(component: ChainClarifyComponent, data: string): void {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
		exitEditMode(component);
		return;
	}

	if (matchesKey(data, "return")) {
		const selected = [...component.skillSelectedNames];
		updateBehavior(component, component.editingStep!, "skills", selected);
		exitEditMode(component);
		return;
	}

	if (data === " ") {
		if (component.filteredSkills.length > 0) {
			const skill = component.filteredSkills[component.skillCursorIndex];
			if (skill) {
				if (component.skillSelectedNames.has(skill.name)) {
					component.skillSelectedNames.delete(skill.name);
				} else {
					component.skillSelectedNames.add(skill.name);
				}
			}
		}
		component.tui.requestRender();
		return;
	}

	if (matchesKey(data, "up")) {
		if (component.filteredSkills.length > 0) {
			component.skillCursorIndex = component.skillCursorIndex === 0
				? component.filteredSkills.length - 1
				: component.skillCursorIndex - 1;
		}
		component.tui.requestRender();
		return;
	}

	if (matchesKey(data, "down")) {
		if (component.filteredSkills.length > 0) {
			component.skillCursorIndex = component.skillCursorIndex === component.filteredSkills.length - 1
				? 0
				: component.skillCursorIndex + 1;
		}
		component.tui.requestRender();
		return;
	}

	if (matchesKey(data, "backspace")) {
		if (component.skillSearchQuery.length > 0) {
			component.skillSearchQuery = component.skillSearchQuery.slice(0, -1);
			filterSkills(component);
		}
		component.tui.requestRender();
		return;
	}

	if (data.length === 1 && data.charCodeAt(0) >= 32) {
		component.skillSearchQuery += data;
		filterSkills(component);
		component.tui.requestRender();
		return;
	}
}
