import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../src/shared/types.ts";
import { handleSubagentsDown } from "../../src/tui/steer-view/entry-shortcut.ts";
import type { SteerViewController } from "../../src/tui/steer-view/open-view.ts";

function state(active = true): SubagentState {
	const value = {
		baseCwd: "/tmp", currentSessionId: "s", asyncJobs: new Map(), foregroundRuns: new Map(), foregroundLiveChildren: new Map(),
		foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null,
		completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} satisfies SubagentState;
	if (active) value.asyncJobs.set("run", { asyncId: "run", asyncDir: "/tmp/run", status: "running", agents: ["worker"] });
	return value;
}

function setup(editorText = "") {
	let opens = 0;
	const ctx = { ui: { getEditorText: () => editorText } } as unknown as ExtensionContext;
	const controller = { modalOpen: false, open: async () => { opens++; }, close: () => {}, dispose: () => {} } as SteerViewController;
	return { ctx, controller, opens: () => opens };
}

describe("subagent Down shortcut", () => {
	it("consumes only Down with an empty editor, active target, and no modal", async () => {
		const input = setup();
		assert.deepEqual(handleSubagentsDown("\x1b[B", input.ctx, state(), input.controller, { openSubagentsOnDown: true }, { listRuns: () => [] }), { consume: true });
		await Promise.resolve();
		assert.equal(input.opens(), 1);
	});

	it("passes through non-target input, editor text, disabled config, no targets, and modal state", () => {
		const empty = setup();
		assert.equal(handleSubagentsDown("x", empty.ctx, state(), empty.controller, { openSubagentsOnDown: true }, { listRuns: () => [] }), undefined);
		assert.equal(handleSubagentsDown("\x1b[B", setup("text").ctx, state(), empty.controller, { openSubagentsOnDown: true }, { listRuns: () => [] }), undefined);
		assert.equal(handleSubagentsDown("\x1b[B", empty.ctx, state(), empty.controller, { openSubagentsOnDown: false }, { listRuns: () => [] }), undefined);
		assert.equal(handleSubagentsDown("\x1b[B", empty.ctx, state(false), empty.controller, { openSubagentsOnDown: true }, { listRuns: () => [] }), undefined);
		Object.defineProperty(empty.controller, "modalOpen", { value: true });
		assert.equal(handleSubagentsDown("\x1b[B", empty.ctx, state(), empty.controller, { openSubagentsOnDown: true }, { listRuns: () => [] }), undefined);
	});
});
