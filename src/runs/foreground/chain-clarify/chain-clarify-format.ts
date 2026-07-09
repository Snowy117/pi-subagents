/** Pure formatting primitives for the chain-clarify TUI (stateless, no side effects). */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

export function padString(s: string, len: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vis));
}

/** Bordered content row (`│ … │`) of the given component width. */
export function makeRow(width: number, theme: Theme, content: string): string {
	const innerW = width - 2;
	return theme.fg("border", "│") + padString(content, innerW) + theme.fg("border", "│");
}

/** Centered header line with top border caps: `╭── text ──╮`. */
export function renderHeaderLine(width: number, theme: Theme, text: string): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╭" + "─".repeat(padLeft)) +
		theme.fg("accent", text) +
		theme.fg("border", "─".repeat(padRight) + "╮")
	);
}

/** Centered footer line with bottom border caps: `╰── text ──╯`. */
export function renderFooterLine(width: number, theme: Theme, text: string): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╰" + "─".repeat(padLeft)) +
		theme.fg("dim", text) +
		theme.fg("border", "─".repeat(padRight) + "╯")
	);
}
