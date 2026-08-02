import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveTuiConfig, saveConfig } from "../../src/extension/config.ts";

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
