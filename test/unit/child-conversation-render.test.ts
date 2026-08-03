import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createChildConversationAssembler } from "../../src/tui/child-conversation/assembler.ts";
import { createChildConversationWidget, CHILD_CONVERSATION_CHROME } from "../../src/tui/child-conversation/render.ts";
import { VIEWER_SETTINGS_DEFAULTS } from "../../src/tui/child-conversation/viewer-settings.ts";

initTheme();

const fakeUi = { requestRender() {} } as never;

const fakeTheme = {
	fg(_color: string, text: string) { return text; },
	bold(text: string) { return text; },
} as never;

function makeWidget(options: { rows?: number; fallbackRows?: number; chrome?: number; statusLine?: () => string } = {}) {
	const assembler = createChildConversationAssembler({
		ui: fakeUi,
		cwd: "/tmp",
		settings: VIEWER_SETTINGS_DEFAULTS,
		toolOutputExpanded: false,
	});
	const factory = createChildConversationWidget({
		assembler,
		statusLine: options.statusLine ?? (() => "subagent: worker · run-1:0 · completed"),
		fallbackRows: options.fallbackRows ?? 40,
		chrome: options.chrome,
	});
	return { assembler, factory };
}

describe("child conversation widget", () => {
	it("renders exactly W lines where W = max(1, rows - chrome)", () => {
		const { factory } = makeWidget({ fallbackRows: 40, chrome: CHILD_CONVERSATION_CHROME });
		const component = factory({ terminal: { rows: 40 } } as never, fakeTheme);
		const lines = component.render(120);
		assert.equal(lines.length, 40 - CHILD_CONVERSATION_CHROME);
	});

	it("blank-pads shorter content so the parent chat is pushed into scrollback", () => {
		const { factory } = makeWidget({ fallbackRows: 24, chrome: 11 });
		const component = factory(null as never, fakeTheme);
		const lines = component.render(120);
		assert.equal(lines.length, 24 - 11);
		assert.ok(lines.every((line) => line === "" || line.startsWith("subagent:")), "only header + padding when empty");
	});

	it("renders the status/header line first", () => {
		const { factory } = makeWidget({ statusLine: () => "subagent: worker · run-1:0 · running" });
		const component = factory(null as never, fakeTheme);
		const lines = component.render(120);
		assert.ok(lines[0]!.includes("subagent: worker"));
		assert.ok(lines[0]!.includes("run-1:0"));
	});

	it("contributes complete conversation history after viewport overflow", () => {
		const { assembler, factory } = makeWidget({ fallbackRows: 20, chrome: 11 });
		for (let index = 0; index < 12; index++) {
			assembler.submitUserText(`message ${index}`);
		}
		const component = factory(null as never, fakeTheme);
		const lines = component.render(120).join("\n");
		assert.ok(lines.includes("message 0"), "oldest item remains in root output");
		assert.ok(lines.includes("message 11"), "newest item stays visible");
	});

	it("recomputes height per render on terminal resize", () => {
		const { factory } = makeWidget({ fallbackRows: 40, chrome: 11 });
		const tui = { terminal: { rows: 40 } };
		const component = factory(tui as never, fakeTheme);
		assert.equal(component.render(120).length, 29);
		tui.terminal.rows = 25;
		assert.equal(component.render(120).length, 14, "minimum height follows the new terminal rows");
		tui.terminal.rows = 2;
		assert.equal(component.render(120).length, 1, "never renders fewer than one line");
	});

	it("keeps content stable across repeated renders (differential rendering)", () => {
		const { assembler, factory } = makeWidget();
		assembler.submitUserText("hello");
		const component = factory(null as never, fakeTheme);
		const first = component.render(120);
		const second = component.render(120);
		assert.deepEqual(second, first);
	});

	it("invalidates and re-renders the assembler tree", () => {
		const { assembler, factory } = makeWidget();
		assembler.submitUserText("before");
		const component = factory(null as never, fakeTheme);
		component.render(120);
		assembler.submitUserText("after");
		component.invalidate();
		const lines = component.render(120).join("\n");
		assert.ok(lines.includes("before"));
		assert.ok(lines.includes("after"));
	});
});
