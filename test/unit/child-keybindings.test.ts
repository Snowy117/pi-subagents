import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getKeybindings, setKeybindings, type KeybindingsManager } from "@earendil-works/pi-tui";
import { createChildKeybindings, CHILD_APP_DEFAULT_KEYS } from "../../src/tui/child-conversation/child-keybindings.ts";
import { makeChildKeybindingsManager } from "../support/child-keybindings.ts";

const ESC = "\u001b";
const CTRL_P = "\u0010";
const CTRL_N = "\u000e";
const CTRL_M = "\u000d";
const CTRL_L = "\u000c";
const CTRL_O = "\u000f";
const CTRL_T = "\u0014";
const CTRL_G = "\u0007";
const SHIFT_TAB = `${ESC}[Z`;

const AGENT_DIR = "/fake/agent";
const CONFIG = `${AGENT_DIR}/keybindings.json`;

/** Read a fake keybindings.json the way pi's loadRawConfig does: missing or
 *  malformed content yields no user bindings (defaults stay). */
function readConfig(files: Record<string, string>): Record<string, unknown> {
	const content = files[CONFIG];
	if (content === undefined) return {};
	try {
		const parsed = JSON.parse(content) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// Malformed file → defaults stay.
	}
	return {};
}

function makeBindings(files: Record<string, string> = {}) {
	return createChildKeybindings({ manager: makeChildKeybindingsManager(readConfig(files)) });
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
		assert.equal(keybindings.actionForKey(CTRL_G), "interrupt", "ctrl+g resolves");
		assert.equal(keybindings.actionForKey(ESC), "interrupt", "escape still resolves");
	});

	it("reflects manager changes live (clearCache is a no-op)", () => {
		const manager = makeChildKeybindingsManager({ "app.model.select": "ctrl+n" });
		const keybindings = createChildKeybindings({ manager });
		assert.equal(keybindings.actionForKey(CTRL_N), "model.select");
		// The manager is authoritative and live: pi's reload path updates the
		// user bindings and resolution changes immediately.
		manager.setUserBindings({});
		assert.equal(keybindings.actionForKey(CTRL_N), undefined, "manager change is visible immediately");
		keybindings.clearCache();
		assert.equal(keybindings.actionForKey(CTRL_P), "model.cycleForward", "defaults still resolve after clearCache");
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

	it("does not resolve leader-bound actions from a bare key (leader-key parity)", () => {
		const manager = makeChildKeybindingsManager({ "app.model.select": "leader+m" });
		// Simulate the leader-key extension's prototype patch: `leader+<key>`
		// bindings resolve only while the leader is pending; bare keys never do.
		const originalMatches = manager.matches.bind(manager);
		let pending = false;
		manager.matches = (data: string, keybinding) => {
			if (keybinding === "app.model.select") return pending && originalMatches(data, keybinding);
			return originalMatches(data, keybinding);
		};
		const keybindings = createChildKeybindings({ manager });
		assert.equal(keybindings.actionForKey("m"), undefined, "bare m does not open the model picker");
		pending = true;
		assert.equal(keybindings.actionForKey("m"), "model.select", "leader+m opens the model picker");
	});

	it("reads the global keybindings instance when no manager is injected", () => {
		const original = getKeybindings();
		try {
			setKeybindings(makeChildKeybindingsManager({ "app.model.select": "ctrl+n" }));
			const keybindings = createChildKeybindings();
			assert.equal(keybindings.actionForKey(CTRL_N), "model.select", "actionForKey reads the global singleton");
			assert.equal(keybindings.actionForKey(CTRL_P), "model.cycleForward");
		} finally {
			setKeybindings(original);
		}
	});

	it("falls back to the default table when the manager lacks matches", () => {
		const unusable = { matches: undefined, getKeys: undefined } as unknown as KeybindingsManager;
		const keybindings = createChildKeybindings({ manager: unusable });
		assert.equal(keybindings.actionForKey(CTRL_P), "model.cycleForward");
		assert.equal(keybindings.actionForKey(CTRL_L), "model.select");
		assert.deepEqual(keybindings.keysFor("interrupt"), ["escape"]);
	});
});
