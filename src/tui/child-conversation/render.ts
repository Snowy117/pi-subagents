/**
 * Widget factory for the child conversation surface (R2/R3).
 *
 * Implements pi's `ctx.ui.setWidget(key, componentFactory)` contract. The
 * widget renders the assembler's item tree tail into exactly
 * `max(1, terminal.rows - CHROME)` lines; shorter content is blank-padded so
 * the TUI's bottom-anchored viewport pushes the parent chat into scrollback —
 * visually the chat area IS the child conversation. Height is recomputed per
 * render (terminal resizes safe), and the last rendered lines are cached so
 * differential rendering stays stable (invalidate() re-renders from scratch).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ChildConversationAssembler } from "./assembler.ts";

/** Conservative chrome outside the chat area:
 *  header(2) + editor(6) + footer(2) + margin(1). */
export const CHILD_CONVERSATION_CHROME = 11;

export interface ChildConversationRenderOptions {
	assembler: ChildConversationAssembler;
	/** Header/status line provider (e.g. `subagent: <agent> · <runId>:<index>`). */
	statusLine: () => string;
	/** Terminal rows used when the TUI does not expose dimensions (tests). */
	fallbackRows?: number;
	/** Lines reserved for non-chat chrome; default CHILD_CONVERSATION_CHROME. */
	chrome?: number;
}

export function createChildConversationWidget(options: ChildConversationRenderOptions): (tui: TUI, theme: Theme) => Component & { dispose?(): void } {
	const { assembler, statusLine, fallbackRows = 40, chrome = CHILD_CONVERSATION_CHROME } = options;

	return (tui: TUI | null | undefined, theme: Theme) => {
		const widget: Component = {
			render(width: number): string[] {
				const rows = tui?.terminal?.rows ?? fallbackRows;
				const total = Math.max(1, rows - chrome);
				const header = statusLine();
				const headerLines: string[] = [];
				if (header) headerLines.push(theme.fg("accent", theme.bold(header)));
				const content = assembler.container.render(width);
				const tail = content.slice(-Math.max(0, total - headerLines.length));
				const lines = [...headerLines, ...tail];
				while (lines.length < total) lines.push("");
				return lines.slice(0, total);
			},
			invalidate() {
				assembler.container.invalidate();
			},
		};
		return widget;
	};
}