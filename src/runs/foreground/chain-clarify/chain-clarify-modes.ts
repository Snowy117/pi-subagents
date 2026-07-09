import { truncateToWidth } from "@earendil-works/pi-tui";
import { computeEffectiveBehavior, computeEffectiveModel } from "./chain-clarify-behavior.ts";
import { makeRow, renderFooterLine, renderHeaderLine } from "./chain-clarify-format.ts";
import type { ChainClarifyView } from "./chain-clarify-view.ts";

export function getFooterTextView(view: ChainClarifyView): string {
	const bgLabel = view.runInBackground ? '[b]g:ON' : '[b]g';
	switch (view.mode) {
		case 'single':
			return ` [Enter] Run • [Esc] Cancel • e m t w s ${bgLabel} `;
		case 'parallel':
			return ` [Enter] Run • [Esc] Cancel • e m t s ${bgLabel} • ↑↓ Nav `;
		case 'chain':
			return ` [Enter] Run • [Esc] Cancel • e m t w r p s ${bgLabel} • ↑↓ Nav `;
	}
}

export function appendNoticeView(view: ChainClarifyView, lines: string[]): void {
	if (!view.noticeMessage) return;
	const color = view.noticeMessage.type === "error" ? "error" : "success";
	lines.push(makeRow(view.width, view.theme, ` ${view.theme.fg(color, view.noticeMessage.text)}`));
}

export function renderSingleModeView(view: ChainClarifyView): string[] {
	const innerW = view.width - 2;
	const th = view.theme;
	const lines: string[] = [];

	const agentName = view.agentConfigs[0]?.name ?? "unknown";
	const maxHeaderLen = innerW - 4;
	const headerText = ` Agent: ${truncateToWidth(agentName, maxHeaderLen - 9)} `;
	lines.push(renderHeaderLine(view.width, th, headerText));
	lines.push(makeRow(view.width, th, ""));

	const config = view.agentConfigs[0]!;
	const behavior = computeEffectiveBehavior(view.resolvedBehaviors, view.behaviorOverrides, 0);

	const stepLabel = config.name;
	lines.push(makeRow(view.width, th, ` ${th.fg("accent", "▶ " + stepLabel)}`));

	const template = (view.templates[0] ?? "").split("\n")[0] ?? "";
	const taskLabel = th.fg("dim", "task: ");
	lines.push(makeRow(view.width, th, `     ${taskLabel}${truncateToWidth(template, innerW - 12)}`));

	const effectiveModel = computeEffectiveModel(view.resolvedBehaviors, view.behaviorOverrides, view.availableModels, view.preferredProvider, 0);
	const override = view.behaviorOverrides.get(0);
	const isOverridden = override?.model !== undefined;
	const modelValue = isOverridden
		? th.fg("warning", effectiveModel) + th.fg("dim", " ✎")
		: effectiveModel;
	const modelLabel = th.fg("dim", "model: ");
	lines.push(makeRow(view.width, th, `     ${modelLabel}${truncateToWidth(modelValue, innerW - 13)}`));

	const writesValue = behavior.output === false
		? th.fg("dim", "(disabled)")
		: (behavior.output || th.fg("dim", "(none)"));
	const writesLabel = th.fg("dim", "writes: ");
	lines.push(makeRow(view.width, th, `     ${writesLabel}${truncateToWidth(writesValue, innerW - 14)}`));

	const skillsValue = behavior.skills === false
		? th.fg("dim", "(disabled)")
		: (behavior.skills?.length ? behavior.skills.join(", ") : th.fg("dim", "(none)"));
	const skillsLabel = th.fg("dim", "skills: ");
	lines.push(makeRow(view.width, th, `     ${skillsLabel}${truncateToWidth(skillsValue, innerW - 14)}`));

	lines.push(makeRow(view.width, th, ""));

	appendNoticeView(view, lines);
	lines.push(renderFooterLine(view.width, th, getFooterTextView(view)));

	return lines;
}

export function renderParallelModeView(view: ChainClarifyView): string[] {
	const innerW = view.width - 2;
	const th = view.theme;
	const lines: string[] = [];

	const headerText = ` Parallel Tasks (${view.agentConfigs.length}) `;
	lines.push(renderHeaderLine(view.width, th, headerText));
	lines.push(makeRow(view.width, th, ""));

	for (let i = 0; i < view.agentConfigs.length; i++) {
		const config = view.agentConfigs[i]!;
		const isSelected = i === view.selectedStep;

		const color = isSelected ? "accent" : "dim";
		const prefix = isSelected ? "▶ " : "  ";
		const taskPrefix = `Task ${i + 1}: `;
		const maxNameLen = innerW - 4 - prefix.length - taskPrefix.length;
		const agentName = config.name.length > maxNameLen
			? config.name.slice(0, maxNameLen - 1) + "…"
			: config.name;
		const taskLabel = `${taskPrefix}${agentName}`;
		lines.push(makeRow(view.width, th, ` ${th.fg(color, prefix + taskLabel)}`));

		const template = (view.templates[i] ?? "").split("\n")[0] ?? "";
		const taskTextLabel = th.fg("dim", "task: ");
		lines.push(makeRow(view.width, th, `     ${taskTextLabel}${truncateToWidth(template, innerW - 12)}`));

		const effectiveModel = computeEffectiveModel(view.resolvedBehaviors, view.behaviorOverrides, view.availableModels, view.preferredProvider, i);
		const override = view.behaviorOverrides.get(i);
		const isOverridden = override?.model !== undefined;
		const modelValue = isOverridden
			? th.fg("warning", effectiveModel) + th.fg("dim", " ✎")
			: effectiveModel;
		const modelLabel = th.fg("dim", "model: ");
		lines.push(makeRow(view.width, th, `     ${modelLabel}${truncateToWidth(modelValue, innerW - 13)}`));

		const behavior = computeEffectiveBehavior(view.resolvedBehaviors, view.behaviorOverrides, i);
		const skillsValue = behavior.skills === false
			? th.fg("dim", "(disabled)")
			: (behavior.skills?.length ? behavior.skills.join(", ") : th.fg("dim", "(none)"));
		const skillsLabel = th.fg("dim", "skills: ");
		lines.push(makeRow(view.width, th, `     ${skillsLabel}${truncateToWidth(skillsValue, innerW - 14)}`));

		lines.push(makeRow(view.width, th, ""));
	}

	appendNoticeView(view, lines);
	lines.push(renderFooterLine(view.width, th, getFooterTextView(view)));

	return lines;
}

export function renderChainModeView(view: ChainClarifyView): string[] {
	const innerW = view.width - 2;
	const th = view.theme;
	const lines: string[] = [];

	const chainLabel = view.agentConfigs.map((c) => c.name).join(" → ");
	const maxHeaderLen = innerW - 4;
	const headerText = ` Chain: ${truncateToWidth(chainLabel, maxHeaderLen - 9)} `;
	lines.push(renderHeaderLine(view.width, th, headerText));

	lines.push(makeRow(view.width, th, ""));

	const taskPreview = truncateToWidth(view.originalTask, innerW - 16);
	lines.push(makeRow(view.width, th, ` Original Task: ${taskPreview}`));
	const chainDirPreview = truncateToWidth(view.chainDir ?? "", innerW - 12);
	lines.push(makeRow(view.width, th, ` Chain Dir: ${th.fg("dim", chainDirPreview)}`));

	const progressEnabled = view.agentConfigs.some((_, i) => computeEffectiveBehavior(view.resolvedBehaviors, view.behaviorOverrides, i).progress);
	const progressValue = progressEnabled ? th.fg("success", "enabled") : th.fg("dim", "disabled");
	lines.push(makeRow(view.width, th, ` Progress: ${progressValue} ${th.fg("dim", "(press [p] to toggle)")}`));
	lines.push(makeRow(view.width, th, ""));

	for (let i = 0; i < view.agentConfigs.length; i++) {
		const config = view.agentConfigs[i]!;
		const isSelected = i === view.selectedStep;
		const behavior = computeEffectiveBehavior(view.resolvedBehaviors, view.behaviorOverrides, i);

		const color = isSelected ? "accent" : "dim";
		const prefix = isSelected ? "▶ " : "  ";
		const stepPrefix = `Step ${i + 1}: `;
		const maxNameLen = innerW - 4 - prefix.length - stepPrefix.length;
		const agentName = config.name.length > maxNameLen
			? config.name.slice(0, maxNameLen - 1) + "…"
			: config.name;
		const stepLabel = `${stepPrefix}${agentName}`;
		lines.push(
			makeRow(view.width, th, ` ${th.fg(color, prefix + stepLabel)}`),
		);

		const template = (view.templates[i] ?? "").split("\n")[0] ?? "";
		const highlighted = template
			.replace(/\{task\}/g, th.fg("success", "{task}"))
			.replace(/\{previous\}/g, th.fg("warning", "{previous}"))
			.replace(/\{chain_dir\}/g, th.fg("accent", "{chain_dir}"));

		const templateLabel = th.fg("dim", "task: ");
		lines.push(makeRow(view.width, th, `     ${templateLabel}${truncateToWidth(highlighted, innerW - 12)}`));

		const effectiveModel = computeEffectiveModel(view.resolvedBehaviors, view.behaviorOverrides, view.availableModels, view.preferredProvider, i);
		const override = view.behaviorOverrides.get(i);
		const isOverridden = override?.model !== undefined;
		const modelValue = isOverridden
			? th.fg("warning", effectiveModel) + th.fg("dim", " ✎")
			: effectiveModel;
		const modelLabel = th.fg("dim", "model: ");
		lines.push(makeRow(view.width, th, `     ${modelLabel}${truncateToWidth(modelValue, innerW - 13)}`));

		const writesValue = behavior.output === false
			? th.fg("dim", "(disabled)")
			: (behavior.output || th.fg("dim", "(none)"));
		const writesLabel = th.fg("dim", "writes: ");
		lines.push(makeRow(view.width, th, `     ${writesLabel}${truncateToWidth(writesValue, innerW - 14)}`));

		const readsValue = behavior.reads === false
			? th.fg("dim", "(disabled)")
			: (behavior.reads && behavior.reads.length > 0
				? behavior.reads.join(", ")
				: th.fg("dim", "(none)"));
		const readsLabel = th.fg("dim", "reads: ");
		lines.push(makeRow(view.width, th, `     ${readsLabel}${truncateToWidth(readsValue, innerW - 13)}`));

		const skillsValue = behavior.skills === false
			? th.fg("dim", "(disabled)")
			: (behavior.skills?.length ? behavior.skills.join(", ") : th.fg("dim", "(none)"));
		const skillsLabel = th.fg("dim", "skills: ");
		lines.push(makeRow(view.width, th, `     ${skillsLabel}${truncateToWidth(skillsValue, innerW - 14)}`));

		if (progressEnabled) {
			const isFirstStep = i === 0;
			const progressAction = isFirstStep
				? th.fg("success", "writes progress.md")
				: th.fg("accent", "reads progress.md");
			const progressLabel = th.fg("dim", "progress: ");
			lines.push(makeRow(view.width, th, `     ${progressLabel}${progressAction}`));
		}

		if (i < view.agentConfigs.length - 1) {
			const nextStepUsePrevious = (view.templates[i + 1] ?? "").includes("{previous}");
			if (nextStepUsePrevious) {
				const indicator = th.fg("dim", "     ↳ response → ") + th.fg("warning", "{previous}");
				lines.push(makeRow(view.width, th, indicator));
			}
		}

		lines.push(makeRow(view.width, th, ""));
	}

	appendNoticeView(view, lines);
	lines.push(renderFooterLine(view.width, th, getFooterTextView(view)));

	return lines;
}
