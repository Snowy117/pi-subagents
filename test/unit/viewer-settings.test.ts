import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createViewerSettingsReader,
	deepMergeViewerSettings,
	normalizeViewerSettings,
	VIEWER_SETTINGS_DEFAULTS,
	viewerMarkdownTheme,
} from "../../src/tui/child-conversation/viewer-settings.ts";

const tempRoots: string[] = [];
afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeDirs(): { agentDir: string; projectDir: string } {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-settings-agent-"));
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-settings-project-"));
	tempRoots.push(agentDir, projectDir);
	return { agentDir, projectDir };
}

describe("viewer settings", () => {
	it("uses defaults when no settings files exist", () => {
		const { agentDir, projectDir } = makeDirs();
		const reader = createViewerSettingsReader({ agentDir, cwd: projectDir });
		assert.deepEqual(reader.read(), VIEWER_SETTINGS_DEFAULTS);
	});

	it("reads global settings and maps keys with pi normalization", () => {
		const { agentDir, projectDir } = makeDirs();
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
			hideThinkingBlock: true,
			outputPad: 0,
			terminal: { showImages: false, imageWidthCells: 120 },
			markdown: { codeBlockIndent: "    " },
		}));
		const reader = createViewerSettingsReader({ agentDir, cwd: projectDir });
		const settings = reader.read();
		assert.equal(settings.hideThinkingBlock, true);
		assert.equal(settings.outputPad, 0, "outputPad 0 stays 0");
		assert.equal(settings.showImages, false);
		assert.equal(settings.imageWidthCells, 120);
		assert.equal(settings.codeBlockIndent, "    ");
		assert.equal(settings.hiddenThinkingLabel, "Thinking...");
	});

	it("deep-merges project over global with project winning", () => {
		const { agentDir, projectDir } = makeDirs();
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
			hideThinkingBlock: false,
			terminal: { showImages: false, imageWidthCells: 40 },
		}));
		fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".pi", "settings.json"), JSON.stringify({
			terminal: { showImages: true },
		}));
		const reader = createViewerSettingsReader({ agentDir, cwd: projectDir });
		const settings = reader.read();
		assert.equal(settings.showImages, true, "project terminal.showImages wins");
		assert.equal(settings.imageWidthCells, 40, "global terminal.imageWidthCells preserved under one-level merge");
		assert.equal(settings.hideThinkingBlock, false);
	});

	it("deepMergeViewerSettings mirrors pi semantics (arrays/primitives override, nested objects merge once)", () => {
		const merged = deepMergeViewerSettings(
			{ a: 1, nested: { x: 1, y: 2 }, list: [1], keep: "base" },
			{ a: 2, nested: { y: 3 }, list: [2], skip: undefined, extra: "new" },
		);
		assert.deepEqual(merged, { a: 2, nested: { x: 1, y: 3 }, list: [2], keep: "base", extra: "new" });
	});

	it("normalizes outputPad to 0 only for literal 0", () => {
		assert.equal(normalizeViewerSettings({ outputPad: 0 }).outputPad, 0);
		assert.equal(normalizeViewerSettings({ outputPad: 1 }).outputPad, 1);
		assert.equal(normalizeViewerSettings({ outputPad: 7 }).outputPad, 1);
		assert.equal(normalizeViewerSettings({ outputPad: "0" }).outputPad, 1);
		assert.equal(normalizeViewerSettings({}).outputPad, VIEWER_SETTINGS_DEFAULTS.outputPad);
	});

	it("normalizes imageWidthCells to a finite positive integer", () => {
		assert.equal(normalizeViewerSettings({ terminal: { imageWidthCells: 0 } }).imageWidthCells, 1);
		assert.equal(normalizeViewerSettings({ terminal: { imageWidthCells: -5 } }).imageWidthCells, 1);
		assert.equal(normalizeViewerSettings({ terminal: { imageWidthCells: 3.9 } }).imageWidthCells, 3);
		assert.equal(normalizeViewerSettings({ terminal: { imageWidthCells: Number.NaN } }).imageWidthCells, 60);
		assert.equal(normalizeViewerSettings({ terminal: { imageWidthCells: "80" } }).imageWidthCells, 60);
	});

	it("treats hideThinkingBlock as strict boolean true", () => {
		assert.equal(normalizeViewerSettings({ hideThinkingBlock: true }).hideThinkingBlock, true);
		assert.equal(normalizeViewerSettings({ hideThinkingBlock: "yes" }).hideThinkingBlock, false);
		assert.equal(normalizeViewerSettings({}).hideThinkingBlock, false);
	});

	it("caches per TTL and re-reads after expiry or clearCache", () => {
		const { agentDir, projectDir } = makeDirs();
		const settingsPath = path.join(agentDir, "settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ hideThinkingBlock: false }));
		let now = 0;
		const reader = createViewerSettingsReader({ agentDir, cwd: projectDir, now: () => now, ttlMs: 500 });
		assert.equal(reader.read().hideThinkingBlock, false);
		// Within TTL the cached value wins even after the file changes.
		fs.writeFileSync(settingsPath, JSON.stringify({ hideThinkingBlock: true }));
		now += 100;
		assert.equal(reader.read().hideThinkingBlock, false, "cached within TTL");
		// After TTL expiry the next read reloads.
		now += 500;
		assert.equal(reader.read().hideThinkingBlock, true, "re-read after TTL expiry");
		// clearCache forces a reload immediately.
		fs.writeFileSync(settingsPath, JSON.stringify({ hideThinkingBlock: false }));
		reader.clearCache();
		assert.equal(reader.read().hideThinkingBlock, false, "clearCache forces reload");
	});

	it("treats malformed JSON as absent", () => {
		const { agentDir, projectDir } = makeDirs();
		fs.writeFileSync(path.join(agentDir, "settings.json"), "{ not json");
		const reader = createViewerSettingsReader({ agentDir, cwd: projectDir });
		assert.deepEqual(reader.read(), VIEWER_SETTINGS_DEFAULTS);
	});

	it("builds the markdown theme with codeBlockIndent from settings", () => {
		const theme = viewerMarkdownTheme({ codeBlockIndent: "    " });
		assert.equal(theme.codeBlockIndent, "    ");
	});
});