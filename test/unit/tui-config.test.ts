import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolvePersistentChildConfig, resolveTuiConfig, saveConfig } from "../../src/extension/config.ts";

describe("TUI config", () => {
	it("enables Down by default", () => assert.equal(resolveTuiConfig({}).openSubagentsOnDown, true));
	it("honors an explicit override", () => assert.equal(resolveTuiConfig({ tui: { openSubagentsOnDown: false } }).openSubagentsOnDown, false));
	it("normalizes invalid runtime values", () => assert.equal(resolveTuiConfig({ tui: { openSubagentsOnDown: "no" as unknown as boolean } }).openSubagentsOnDown, true));
	it("persists the typed override through the existing config writer", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tui-config-"));
		const configPath = path.join(root, "config.json");
		try {
			saveConfig({ tui: { openSubagentsOnDown: false } }, configPath);
			const stored = JSON.parse(fs.readFileSync(configPath, "utf-8"));
			assert.deepEqual(stored.tui, { openSubagentsOnDown: false });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("persistent child config", () => {
	it("enables persistent children by default with 15min idle and cap 4", () => {
		const resolved = resolvePersistentChildConfig({});
		assert.equal(resolved.enabled, true);
		assert.equal(resolved.idleEvictionMs, 15 * 60 * 1000);
		assert.equal(resolved.maxResidentChildren, 4);
	});

	it("honors boolean shorthand", () => {
		assert.equal(resolvePersistentChildConfig({ persistentChildren: false }).enabled, false);
		assert.equal(resolvePersistentChildConfig({ persistentChildren: true }).enabled, true);
	});

	it("honors object form with eviction overrides", () => {
		const resolved = resolvePersistentChildConfig({
			persistentChildren: {
				enabled: false,
				eviction: { idleMs: 60_000, maxResidentChildren: 8 },
			},
		});
		assert.equal(resolved.enabled, false);
		assert.equal(resolved.idleEvictionMs, 60_000);
		assert.equal(resolved.maxResidentChildren, 8);
	});

	it("normalizes invalid eviction values back to defaults", () => {
		const resolved = resolvePersistentChildConfig({
			persistentChildren: {
				eviction: { idleMs: -5, maxResidentChildren: 0 },
			},
		});
		assert.equal(resolved.idleEvictionMs, 15 * 60 * 1000);
		assert.equal(resolved.maxResidentChildren, 4);
	});
});
