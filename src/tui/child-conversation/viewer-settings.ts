/**
 * Viewer settings snapshot for the child-conversation native assembler.
 *
 * Pi's main interactive view reads settings through a private SettingsManager;
 * extensions have no settings accessor, so this reader mirrors the effective
 * settings from the exact files pi merges (same approach tool-display /
 * zentui take for their own configs):
 *
 *   global  <agentDir>/settings.json
 *   project <cwd>/<configDir>/settings.json   (project wins, deeply merged)
 *
 * plus the public `ctx.ui.getToolsExpanded()` for tool expansion state (the
 * caller injects it; see render.ts). Values are re-read on a short TTL so
 * `/settings` toggles apply on the next render pass without a viewer restart.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getConfigDirName } from "../../shared/utils.ts";

export const VIEWER_SETTINGS_TTL_MS = 500;

export interface ViewerSettings {
	hideThinkingBlock: boolean;
	/** 0 keeps zero padding, every other effective value renders as 1 (pi parity). */
	outputPad: number;
	showImages: boolean;
	/** Collapsed image width in terminal cells; always >= 1. */
	imageWidthCells: number;
	codeBlockIndent: string;
	hiddenThinkingLabel: string;
}

export const VIEWER_SETTINGS_DEFAULTS: ViewerSettings = {
	hideThinkingBlock: false,
	outputPad: 1,
	showImages: true,
	imageWidthCells: 60,
	codeBlockIndent: "  ",
	hiddenThinkingLabel: "Thinking...",
};

type ViewerSettingsFs = Pick<typeof fs, "existsSync" | "readFileSync">;

export interface ViewerSettingsReaderOptions {
	/** Global agent dir holding settings.json (default: shared getAgentDir()). */
	agentDir?: string;
	/** Project working directory for project-scoped settings (optional). */
	cwd?: string;
	fs?: ViewerSettingsFs;
	now?: () => number;
	ttlMs?: number;
}

export interface ViewerSettingsReader {
	read(): ViewerSettings;
	/** Drop the TTL cache so the next read re-loads from disk. */
	clearCache(): void;
}

interface RawSettingsInput {
	hideThinkingBlock?: unknown;
	outputPad?: unknown;
	terminal?: { showImages?: unknown; imageWidthCells?: unknown } | null;
	markdown?: { codeBlockIndent?: unknown } | null;
}

/** Mirror of pi's deepMergeSettings (dist/core/settings-manager.js): nested
 *  plain objects merge one level deep, primitives/arrays are overridden. */
export function deepMergeViewerSettings(
	base: Record<string, unknown>,
	overrides: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...base };
	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) continue;
		const baseValue = base[key];
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			result[key] = { ...baseValue, ...overrideValue };
		} else {
			result[key] = overrideValue;
		}
	}
	return result;
}

export function normalizeViewerSettings(raw: RawSettingsInput): ViewerSettings {
	const outputPad = raw.outputPad === 0 ? 0 : 1;
	const showImages = typeof raw.terminal?.showImages === "boolean" ? raw.terminal.showImages : VIEWER_SETTINGS_DEFAULTS.showImages;
	const width = raw.terminal?.imageWidthCells;
	const imageWidthCells = typeof width === "number" && Number.isFinite(width)
		? Math.max(1, Math.floor(width))
		: VIEWER_SETTINGS_DEFAULTS.imageWidthCells;
	const codeBlockIndent = typeof raw.markdown?.codeBlockIndent === "string"
		? raw.markdown.codeBlockIndent
		: VIEWER_SETTINGS_DEFAULTS.codeBlockIndent;
	return {
		hideThinkingBlock: raw.hideThinkingBlock === true,
		outputPad,
		showImages,
		imageWidthCells,
		codeBlockIndent,
		// No public getter for the effective thinking label; use the default the
		// main view starts with (README documents this as best-effort).
		hiddenThinkingLabel: VIEWER_SETTINGS_DEFAULTS.hiddenThinkingLabel,
	};
}

function readSettingsObject(filePath: string, fsImpl: ViewerSettingsFs): Record<string, unknown> {
	try {
		if (!fsImpl.existsSync(filePath)) return {};
		const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		// A malformed settings file should not break the viewer; treat it as
		// absent so the other scope (or the defaults) still applies.
		return {};
	}
}

export function createViewerSettingsReader(options: ViewerSettingsReaderOptions = {}): ViewerSettingsReader {
	const fsImpl = options.fs ?? fs;
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? VIEWER_SETTINGS_TTL_MS;
	const agentDir = options.agentDir ?? getAgentDir();
	const projectConfigDir = getConfigDirName();
	let cached: { at: number; value: ViewerSettings } | undefined;

	const load = (): ViewerSettings => {
		const globalRaw = readSettingsObject(path.join(agentDir, "settings.json"), fsImpl);
		const projectRaw = options.cwd
			? readSettingsObject(path.join(options.cwd, projectConfigDir, "settings.json"), fsImpl)
			: {};
		const merged = deepMergeViewerSettings(globalRaw, projectRaw);
		return normalizeViewerSettings(merged);
	};

	return {
		read(): ViewerSettings {
			if (cached && now() - cached.at < ttlMs) return cached.value;
			cached = { at: now(), value: load() };
			return cached.value;
		},
		clearCache(): void {
			cached = undefined;
		},
	};
}

/** Markdown theme equivalent of the main view's getMarkdownThemeWithSettings(). */
export function viewerMarkdownTheme(settings: Pick<ViewerSettings, "codeBlockIndent">): MarkdownTheme {
	return {
		...getMarkdownTheme(),
		codeBlockIndent: settings.codeBlockIndent,
	};
}

export function setViewerMarkdownCodeBlockIndent(theme: MarkdownTheme, codeBlockIndent: string): void {
	theme.codeBlockIndent = codeBlockIndent;
}
