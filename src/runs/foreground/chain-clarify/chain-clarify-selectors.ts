import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "../../../shared/model-info.ts";
import { splitThinkingSuffix } from "../../shared/model-fallback.ts";
import { computeAvailableThinkingLevels, computeEffectiveModel } from "./chain-clarify-behavior.ts";
import { makeRow, renderFooterLine, renderHeaderLine } from "./chain-clarify-format.ts";
import type { ChainClarifyView } from "./chain-clarify-view.ts";
import { ensureCursorVisible, getCursorDisplayPos, renderEditor, wrapText, type TextEditorState } from "./text-editor.ts";

const MODEL_SELECTOR_HEIGHT = 10;

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	"off": "No extended thinking",
	"minimal": "Brief reasoning",
	"low": "Light reasoning",
	"medium": "Moderate reasoning",
	"high": "Deep reasoning",
	"xhigh": "Maximum reasoning (ultrathink)",
};

function stepLabelFor(view: ChainClarifyView): string {
	const agentName = view.agentConfigs[view.editingStep!]?.name ?? "unknown";
	return view.mode === 'single'
		? agentName
		: view.mode === 'parallel'
			? `Task ${view.editingStep! + 1}: ${agentName}`
			: `Step ${view.editingStep! + 1}: ${agentName}`;
}

export function renderModelSelectorView(view: ChainClarifyView): string[] {
	const th = view.theme;
	const lines: string[] = [];

	const headerText = ` Select Model (${stepLabelFor(view)}) `;
	lines.push(renderHeaderLine(view.width, th, headerText));
	lines.push(makeRow(view.width, th, ""));

	const searchPrefix = th.fg("dim", "Search: ");
	const cursor = "\x1b[7m \x1b[27m"; // Reverse video space for cursor
	const searchDisplay = view.modelSearchQuery + cursor;
	lines.push(makeRow(view.width, th, ` ${searchPrefix}${searchDisplay}`));
	lines.push(makeRow(view.width, th, ""));

	const currentModel = computeEffectiveModel(view.resolvedBehaviors, view.behaviorOverrides, view.availableModels, view.preferredProvider, view.editingStep!);
	const currentModelBase = splitThinkingSuffix(currentModel).baseModel;
	const currentLabel = th.fg("dim", "Current: ");
	lines.push(makeRow(view.width, th, ` ${currentLabel}${th.fg("warning", currentModel)}`));
	lines.push(makeRow(view.width, th, ""));

	if (view.filteredModels.length === 0) {
		lines.push(makeRow(view.width, th, ` ${th.fg("dim", "No matching models")}`));
	} else {
		const maxVisible = MODEL_SELECTOR_HEIGHT;
		let startIdx = 0;

		if (view.filteredModels.length > maxVisible) {
			startIdx = Math.max(0, view.modelSelectedIndex - Math.floor(maxVisible / 2));
			startIdx = Math.min(startIdx, view.filteredModels.length - maxVisible);
		}

		const endIdx = Math.min(startIdx + maxVisible, view.filteredModels.length);

		if (startIdx > 0) {
			lines.push(makeRow(view.width, th, ` ${th.fg("dim", `  ↑ ${startIdx} more`)}`));
		}

		for (let i = startIdx; i < endIdx; i++) {
			const model = view.filteredModels[i]!;
			const isSelected = i === view.modelSelectedIndex;
			const isCurrent = model.fullId === currentModelBase || model.id === currentModelBase;
			const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
			const modelText = isSelected ? th.fg("accent", model.id) : model.id;
			const providerBadge = th.fg("dim", ` [${model.provider}]`);
			const currentBadge = isCurrent ? th.fg("success", " current") : "";

			lines.push(makeRow(view.width, th, ` ${prefix}${modelText}${providerBadge}${currentBadge}`));
		}

		const remaining = view.filteredModels.length - endIdx;
		if (remaining > 0) {
			lines.push(makeRow(view.width, th, ` ${th.fg("dim", `  ↓ ${remaining} more`)}`));
		}
	}

	const contentLines = lines.length;
	const targetHeight = 18;
	for (let i = contentLines; i < targetHeight; i++) {
		lines.push(makeRow(view.width, th, ""));
	}

	const footerText = " [Enter] Select • [Esc] Cancel • Type to search ";
	lines.push(renderFooterLine(view.width, th, footerText));

	return lines;
}

export function renderThinkingSelectorView(view: ChainClarifyView): string[] {
	const th = view.theme;
	const lines: string[] = [];

	const headerText = ` Thinking Level (${stepLabelFor(view)}) `;
	lines.push(renderHeaderLine(view.width, th, headerText));
	lines.push(makeRow(view.width, th, ""));

	const currentModel = computeEffectiveModel(view.resolvedBehaviors, view.behaviorOverrides, view.availableModels, view.preferredProvider, view.editingStep!);
	const currentLabel = th.fg("dim", "Model: ");
	lines.push(makeRow(view.width, th, ` ${currentLabel}${th.fg("accent", currentModel)}`));
	lines.push(makeRow(view.width, th, ""));

	lines.push(makeRow(view.width, th, ` ${th.fg("dim", "Select thinking level (extended thinking budget):")}`));
	lines.push(makeRow(view.width, th, ""));

	const levels = computeAvailableThinkingLevels(view.resolvedBehaviors, view.behaviorOverrides, view.availableModels, view.preferredProvider, view.editingStep!);
	if (levels.length === 0) {
		lines.push(makeRow(view.width, th, ` ${th.fg("dim", "No supported thinking levels")}`));
	} else {
		for (let i = 0; i < levels.length; i++) {
			const level = levels[i]!;
			const isSelected = i === view.thinkingSelectedIndex;
			const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
			const levelText = isSelected ? th.fg("accent", level) : level;
			const desc = th.fg("dim", ` - ${LEVEL_DESCRIPTIONS[level]}`);
			lines.push(makeRow(view.width, th, ` ${prefix}${levelText}${desc}`));
		}
	}

	const contentLines = lines.length;
	const targetHeight = 16;
	for (let i = contentLines; i < targetHeight; i++) {
		lines.push(makeRow(view.width, th, ""));
	}

	const footerText = levels.length === 0
		? " [Esc] Cancel "
		: " [Enter] Select • [Esc] Cancel • ↑↓ Navigate ";
	lines.push(renderFooterLine(view.width, th, footerText));

	return lines;
}

export function renderSkillSelectorView(view: ChainClarifyView): string[] {
	const innerW = view.width - 2;
	const th = view.theme;
	const lines: string[] = [];

	lines.push(renderHeaderLine(view.width, th, ` Select Skills (${stepLabelFor(view)}) `));
	lines.push(makeRow(view.width, th, ""));

	const cursor = "\x1b[7m \x1b[27m";
	lines.push(makeRow(view.width, th, ` ${th.fg("dim", "Search: ")}${view.skillSearchQuery}${cursor}`));
	lines.push(makeRow(view.width, th, ""));

	const selected = [...view.skillSelectedNames].join(", ") || th.fg("dim", "(none)");
	lines.push(makeRow(view.width, th, ` ${th.fg("dim", "Selected: ")}${truncateToWidth(selected, innerW - 12)}`));
	lines.push(makeRow(view.width, th, ""));

	const selectorHeight = 10;
	if (view.filteredSkills.length === 0) {
		lines.push(makeRow(view.width, th, ` ${th.fg("dim", "No matching skills")}`));
	} else {
		let startIdx = 0;
		if (view.filteredSkills.length > selectorHeight) {
			startIdx = Math.max(0, view.skillCursorIndex - Math.floor(selectorHeight / 2));
			startIdx = Math.min(startIdx, view.filteredSkills.length - selectorHeight);
		}
		const endIdx = Math.min(startIdx + selectorHeight, view.filteredSkills.length);

		if (startIdx > 0) {
			lines.push(makeRow(view.width, th, ` ${th.fg("dim", `  ↑ ${startIdx} more`)}`));
		}

		for (let i = startIdx; i < endIdx; i++) {
			const skill = view.filteredSkills[i]!;
			const isCursor = i === view.skillCursorIndex;
			const isSelected = view.skillSelectedNames.has(skill.name);

			const prefix = isCursor ? th.fg("accent", "→ ") : "  ";
			const checkbox = isSelected ? th.fg("success", "[x]") : "[ ]";
			const nameText = isCursor ? th.fg("accent", skill.name) : skill.name;
			const sourceBadge = th.fg("dim", ` [${skill.source}]`);
			const desc = skill.description
				? th.fg("dim", ` - ${truncateToWidth(skill.description, 25)}`)
				: "";

			lines.push(makeRow(view.width, th, ` ${prefix}${checkbox} ${nameText}${sourceBadge}${desc}`));
		}

		const remaining = view.filteredSkills.length - endIdx;
		if (remaining > 0) {
			lines.push(makeRow(view.width, th, ` ${th.fg("dim", `  ↓ ${remaining} more`)}`));
		}
	}

	const targetHeight = 18;
	for (let i = lines.length; i < targetHeight; i++) {
		lines.push(makeRow(view.width, th, ""));
	}

	lines.push(renderFooterLine(view.width, th, " [Enter] Confirm • [Space] Toggle • [Esc] Cancel "));
	return lines;
}

export function renderFullEditModeView(view: ChainClarifyView, editState: TextEditorState): { lines: string[]; editState: TextEditorState } {
	const innerW = view.width - 2;
	const textWidth = innerW - 2; // 1 char padding on each side
	const lines: string[] = [];

	const { lines: wrapped, starts } = wrapText(editState.buffer, textWidth);
	const cursorPos = getCursorDisplayPos(editState.cursor, starts);
	const nextEditState: TextEditorState = {
		...editState,
		viewportOffset: ensureCursorVisible(
			cursorPos.line,
			view.editViewportHeight,
			editState.viewportOffset,
		),
	};

	// Header truncates the agent name (unlike the selectors) to prevent overflow.
	const fieldName = view.editMode === "template" ? "task" : view.editMode;
	const rawAgentName = view.agentConfigs[view.editingStep!]?.name ?? "unknown";
	const maxAgentLen = innerW - 30;
	const agentName = rawAgentName.length > maxAgentLen
		? rawAgentName.slice(0, maxAgentLen - 1) + "…"
		: rawAgentName;
	const stepLabel = view.mode === 'single'
		? agentName
		: view.mode === 'parallel'
			? `Task ${view.editingStep! + 1}: ${agentName}`
			: `Step ${view.editingStep! + 1}: ${agentName}`;
	const headerText = ` Editing ${fieldName} (${stepLabel}) `;
	lines.push(renderHeaderLine(view.width, view.theme, headerText));
	lines.push(makeRow(view.width, view.theme, ""));

	const editorLines = renderEditor(nextEditState, textWidth, view.editViewportHeight);
	for (const line of editorLines) {
		lines.push(makeRow(view.width, view.theme, ` ${line}`));
	}

	const linesBelow = wrapped.length - nextEditState.viewportOffset - view.editViewportHeight;
	const hasMore = linesBelow > 0;
	const hasLess = nextEditState.viewportOffset > 0;
	let scrollInfo = "";
	if (hasLess) scrollInfo += "↑";
	if (hasMore) scrollInfo += `↓ ${linesBelow}+`;

	lines.push(makeRow(view.width, view.theme, ""));

	const footerText = scrollInfo
		? ` [Esc] Done • [Ctrl+C] Discard • ${scrollInfo} `
		: " [Esc] Done • [Ctrl+C] Discard ";
	lines.push(renderFooterLine(view.width, view.theme, footerText));

	return { lines, editState: nextEditState };
}
