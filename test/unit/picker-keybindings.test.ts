import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPickerKeybindingReader, readPickerKeys } from "../../src/tui/steer-view/picker-keybindings.ts";

function fakeFs(value?: unknown, malformed = false) {
	return {
		existsSync: () => value !== undefined || malformed,
		readFileSync: () => malformed ? "{" : JSON.stringify({ "subagents.openPicker": value }),
	};
}

describe("subagents.openPicker keybindings", () => {
	it("has no default binding", () => assert.deepEqual(readPickerKeys({ agentDir: "/a", fs: fakeFs(undefined) as never }), []));
	it("accepts a string, arrays, empty arrays, and deduplicates", () => {
		assert.deepEqual(readPickerKeys({ agentDir: "/a", fs: fakeFs("ctrl+down") as never }), ["ctrl+down"]);
		assert.deepEqual(readPickerKeys({ agentDir: "/a", fs: fakeFs(["down", "ctrl+down", "down"]) as never }), ["down", "ctrl+down"]);
		assert.deepEqual(readPickerKeys({ agentDir: "/a", fs: fakeFs("ctrl+shift+alt+super+x") as never }), ["ctrl+shift+alt+super+x"]);
		assert.deepEqual(readPickerKeys({ agentDir: "/a", fs: fakeFs([]) as never }), []);
	});
	it("rejects the complete binding when any entry is invalid and reports malformed files", () => {
		let errors = 0;
		assert.deepEqual(readPickerKeys({ agentDir: "/a", fs: fakeFs(["down", 42]) as never }), []);
		assert.deepEqual(readPickerKeys({ agentDir: "/a", fs: fakeFs(["leader+x", 42, "ctrl+ctrl+x"]) as never }), []);
		assert.deepEqual(readPickerKeys({ agentDir: "/a", fs: fakeFs(undefined, true) as never, onError: () => errors++ }), []);
		assert.equal(errors, 1);
	});
	it("matches raw terminal input", () => {
		const reader = createPickerKeybindingReader({ agentDir: "/a", fs: fakeFs("down") as never });
		assert.equal(reader.matches("\x1b[B"), true);
		assert.equal(reader.matches("x"), false);
	});
});
