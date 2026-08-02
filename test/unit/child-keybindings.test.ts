import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { createChildKeybindings, CHILD_APP_DEFAULT_KEYS } from "../../src/tui/child-conversation/child-keybindings.ts";

const ESC = "\u001b";
const CTRL_P = "\u0010";
const CTRL_N = "\u000e";
const CTRL_M = "\u000d";
const CTRL_L = "\u000c";
const CTRL_O = "\u000f";
const CTRL_T = "\u0014";
const SHIFT_TAB = `${ESC}[Z`;

type KeybindingsFs = Pick<typeof fs, "existsSync" | "readFileSync">;

function fakeFs(files: Record<string, string>): KeybindingsFs {
	return {
		existsSync(filePath: string) {
			return files[filePath] !== undefined;
		},
		readFileSync(filePath: string) {
			const content = files[filePath];
			if (content === undefined) throw new Error(`ENOENT: ${filePath}`);
			return content;
		},
	};
}

const AGENT_DIR = "/fake/agent";
const CONFIG = `${AGENT_DIR}/keybindings.json`;

function makeBindings(files: Record<string, string> = {}) {
	return createChildKeybindings({ agentDir: AGENT_DIR, fs: fakeFs(files) });
}

describe("child keybindings", () => {
	it("uses the documented defaults when no keybindings.json exists", () => {
		const keybindings = makeBindings();
		assert.deepEqual(keybindings.keysFor("interrupt"), ["escape"]);
		assert.deepEqual(keybindings.keysFor("thinking.cycle"), ["shift+tab"]);
		assert.deepEqual(keybindings.keysFor("model.cycleForward"), ["ctrl+p"]);
		assert.deepEqual(keybindings.keysFor("model.cycleBackward"), ["shift+ctrl+p"]);
		assert.deepEqual(keybindings.keysFor("model.select"), ["ctrl+l"]);
		assert.deepEqual(keybindings.keysFor("tools.expand"), ["ctrl+o"]);
		assert.deepEqual(keybindings.keysFor("thinking.toggle"), ["ctrl+t"]);
	});

	it("resolves the default keys from raw terminal input", () => {
		const keybindings = makeBindings();
		assert.equal(keybindings.actionForKey(ESC), "interrupt");
		assert.equal(keybindings.actionForKey(SHIFT_TAB), "thinking.cycle");
		assert.equal(keybindings.actionForKey(CTRL_P), "model.cycleForward");
		assert.equal(keybindings.actionForKey(CTRL_L), "model.select");
		assert.equal(keybindings.actionForKey(CTRL_O), "tools.expand");
		assert.equal(keybindings.actionForKey(CTRL_T), "thinking.toggle");
		assert.equal(keybindings.actionForKey("q"), undefined, "unbound keys resolve to nothing");
	});

	it("respects user remaps over the defaults", () => {
		const keybindings = makeBindings({ [CONFIG]: JSON.stringify({ "app.model.cycleForward": "ctrl+n" }) });
		assert.equal(keybindings.actionForKey(CTRL_N), "model.cycleForward");
		assert.equal(keybindings.actionForKey(CTRL_P), undefined, "remapped default no longer resolves");
	});

	it("skips actions the user removed (empty binding array)", () => {
		const keybindings = makeBindings({ [CONFIG]: JSON.stringify({ "app.tools.expand": [] }) });
		assert.equal(keybindings.keysFor("tools.expand").length, 0);
		assert.equal(keybindings.actionForKey(CTRL_O), undefined);
	});

	it("applies the legacy-name migration", () => {
		const keybindings = makeBindings({ [CONFIG]: JSON.stringify({ cycleModelForward: "ctrl+n" }) });
		assert.equal(keybindings.actionForKey(CTRL_N), "model.cycleForward");
	});

	it("prefers the new name over the legacy name when both are present", () => {
		const keybindings = makeBindings({
			[CONFIG]: JSON.stringify({ cycleModelForward: "ctrl+n", "app.model.cycleForward": "ctrl+m" }),
		});
		assert.equal(keybindings.actionForKey(CTRL_N), undefined, "legacy binding is skipped when the new name exists");
		assert.equal(keybindings.actionForKey(CTRL_M), "model.cycleForward");
	});

	it("keeps defaults when a binding value is invalid", () => {
		const keybindings = makeBindings({ [CONFIG]: JSON.stringify({ "app.model.select": 42, "app.tools.expand": { bogus: true } }) });
		assert.equal(keybindings.actionForKey(CTRL_L), "model.select", "invalid value keeps the default");
		assert.equal(keybindings.actionForKey(CTRL_O), "tools.expand");
	});

	it("ignores non-child bindings entirely", () => {
		const keybindings = makeBindings({ [CONFIG]: JSON.stringify({ "app.session.fork": "ctrl+n" }) });
		assert.equal(keybindings.actionForKey(CTRL_N), undefined);
		assert.equal(keybindings.actionForKey(CTRL_P), "model.cycleForward", "defaults unaffected by unrelated bindings");
	});

	it("ignores a malformed keybindings file", () => {
		const keybindings = makeBindings({ [CONFIG]: "not json {{" });
		assert.equal(keybindings.actionForKey(CTRL_P), "model.cycleForward");
	});

	it("reads multiple keys per action", () => {
		const keybindings = makeBindings({ [CONFIG]: JSON.stringify({ "app.interrupt": ["escape", "ctrl+g"] }) });
		assert.equal(keybindings.actionForKey("\u0007"), "interrupt", "ctrl+g resolves");
		assert.equal(keybindings.actionForKey(ESC), "interrupt", "escape still resolves");
	});

	it("caches per TTL and re-reads after clearCache", () => {
		let fileContents = JSON.stringify({ "app.model.select": "ctrl+n" });
		let clock = 0;
		const keybindings = createChildKeybindings({
			agentDir: AGENT_DIR,
			fs: {
				existsSync: () => true,
				readFileSync: () => fileContents,
			},
			now: () => clock,
			ttlMs: 1000,
		});
		assert.equal(keybindings.actionForKey(CTRL_N), "model.select");
		fileContents = JSON.stringify({});
		assert.equal(keybindings.actionForKey(CTRL_N), "model.select", "cache hit within TTL");
		clock = 1001;
		assert.equal(keybindings.actionForKey(CTRL_N), undefined, "TTL expiry re-reads the file");
		clock = 2002;
		fileContents = JSON.stringify({ "app.model.select": "ctrl+n" });
		keybindings.clearCache();
		assert.equal(keybindings.actionForKey(CTRL_N), "model.select", "clearCache forces a fresh read");
	});

	it("defaults are consistent with the published table", () => {
		assert.deepEqual(CHILD_APP_DEFAULT_KEYS.interrupt, ["escape"]);
		assert.deepEqual(CHILD_APP_DEFAULT_KEYS["thinking.cycle"], ["shift+tab"]);
		assert.deepEqual(CHILD_APP_DEFAULT_KEYS["model.cycleForward"], ["ctrl+p"]);
		assert.deepEqual(CHILD_APP_DEFAULT_KEYS["model.cycleBackward"], ["shift+ctrl+p"]);
		assert.deepEqual(CHILD_APP_DEFAULT_KEYS["model.select"], ["ctrl+l"]);
		assert.deepEqual(CHILD_APP_DEFAULT_KEYS["tools.expand"], ["ctrl+o"]);
		assert.deepEqual(CHILD_APP_DEFAULT_KEYS["thinking.toggle"], ["ctrl+t"]);
	});
});