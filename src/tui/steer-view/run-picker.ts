import { DynamicBorder, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth, type Component, type SelectItem } from "@earendil-works/pi-tui";
import type { SteerViewTarget } from "./target-model.ts";

export class RunPickerComponent implements Component {
	private readonly list: SelectList;
	private readonly border: DynamicBorder;

	constructor(targets: SteerViewTarget[], theme: Theme, done: (target: SteerViewTarget | undefined) => void) {
		const byKey = new Map(targets.map((target) => [target.key, target]));
		const items: SelectItem[] = targets.map((target) => ({
			value: target.key,
			label: `${target.agent}  ${target.runId.slice(0, 12)}:${target.index}`,
			description: `${target.status}${target.recentOutput ? ` · ${target.recentOutput.replace(/\s+/g, " ").slice(0, 80)}` : ""}`,
		}));
		this.border = new DynamicBorder((text) => theme.fg("borderAccent", text));
		this.list = new SelectList(items, 10, getSelectListTheme());
		this.list.onSelect = (item) => done(byKey.get(item.value));
		this.list.onCancel = () => done(undefined);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const lines = [
			...this.border.render(width),
			...new Text("Select a subagent child", 1, 0).render(inner),
			...this.list.render(inner).map((line) => ` ${line}`),
			...new Text("↑↓ navigate · enter open · esc close", 1, 0).render(inner),
			...this.border.render(width),
		];
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.border.invalidate();
		this.list.invalidate();
	}
}
