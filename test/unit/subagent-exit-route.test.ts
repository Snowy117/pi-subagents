import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeybindingsManager } from "@earendil-works/pi-tui";
import { createSubagentExitRoute } from "../../src/tui/steer-view/exit-route.ts";

const definitions = {
	"app.exit": { defaultKeys: "ctrl+d" },
	"tui.input.submit": { defaultKeys: "enter" },
};

function setup(text = "", userBindings: Record<string, never> = {}, editableHostChild = true) {
	let active = true;
	let closes = 0;
	let editorText = text;
	const manager = new KeybindingsManager(definitions, userBindings);
	const ctx = { ui: { getEditorText: () => editorText, setEditorText: (next: string) => { editorText = next; } } } as never;
	const route = createSubagentExitRoute({ ctx, manager, isActive: () => active, isEditableHostChild: () => editableHostChild, close: () => { closes++; } });
	return { route, closes: () => closes, text: () => editorText, deactivate: () => { active = false; } };
}

describe("subagent exit route", () => {
	it("routes the live app.exit binding only with an empty editor", () => {
		const empty = setup();
		assert.deepEqual(empty.route.handleInput("\x04"), { consume: true });
		assert.equal(empty.closes(), 1);
		assert.equal(setup("text").route.handleInput("\x04"), undefined);
	});
	it("honors remaps, multiple keys, and removal", () => {
		const remapped = setup("", { "app.exit": ["ctrl+x", "ctrl+y"] } as never);
		assert.equal(remapped.route.handleInput("\x04"), undefined);
		assert.deepEqual(remapped.route.handleInput("\x18"), { consume: true });
		assert.deepEqual(remapped.route.handleInput("\x19"), { consume: true });
		assert.equal(setup("", { "app.exit": [] } as never).route.handleInput("\x04"), undefined);
	});
	it("routes /quit and /exit through the configured submit binding", () => {
		for (const command of ["/quit", "/exit"]) {
			const input = setup(command, { "tui.input.submit": "ctrl+x" } as never);
			assert.deepEqual(input.route.handleInput("\x18"), { consume: true });
			assert.equal(input.text(), "");
			assert.equal(input.closes(), 1);
		}
	});
	it("passes raw slash exits through outside editable host-child mode", () => {
		const input = setup("/quit", {}, false);
		assert.equal(input.route.handleInput("\r"), undefined);
		assert.equal(input.text(), "/quit");
		assert.equal(input.closes(), 0);
	});
	it("passes through while inactive", () => {
		const input = setup(); input.deactivate();
		assert.equal(input.route.handleInput("\x04"), undefined);
	});
});
