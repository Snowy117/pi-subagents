import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerSubagentTools } from "../../src/extension/registration/tools.ts";

const theme = {
	fg(_name: string, text: string) { return text; },
	bold(text: string) { return text; },
};

function renderCall(config: { asyncByDefault?: boolean; forceTopLevelAsync?: boolean }, args: { tasks: Array<{ agent: string; count?: number }>; async?: boolean }): string {
	let tool: { renderCall: (input: typeof args, inputTheme: typeof theme) => { text: string } } | undefined;
	registerSubagentTools({
		registerTool(value: unknown) { tool = value as typeof tool; },
	} as never, {
		config,
		execute: async () => ({ content: [{ type: "text", text: "unused" }], details: { mode: "single", results: [] } }),
	});
	assert.ok(tool);
	return tool.renderCall(args, theme).text;
}

describe("subagent tool call rendering", () => {
	it("does not render an async badge for detached calls", () => {
		assert.equal(renderCall({}, { tasks: [{ agent: "delegate" }], async: true }), "subagent delegate");
	});

	it("keeps call rendering independent of configured detach policy", () => {
		assert.equal(renderCall({ asyncByDefault: true }, { tasks: [{ agent: "delegate" }] }), "subagent delegate");
		assert.equal(renderCall({ asyncByDefault: true }, { tasks: [{ agent: "delegate" }], async: false }), "subagent delegate");
	});

	it("keeps forced top-level detachment out of the call label", () => {
		assert.equal(renderCall({ forceTopLevelAsync: true }, { tasks: [{ agent: "delegate" }], async: false }), "subagent delegate");
	});

	it("keeps the parallel cardinality label without an async badge", () => {
		assert.equal(renderCall({}, { tasks: [{ agent: "worker" }, { agent: "reviewer", count: 2 }], async: true }), "subagent parallel (3)");
	});

	it("does not install a periodic invalidation loop for a quiet running result", () => {
		let tool: { renderResult: (result: unknown, options: unknown, inputTheme: typeof theme, context: unknown) => unknown } | undefined;
		registerSubagentTools({
			registerTool(value: unknown) { tool = value as typeof tool; },
		} as never, {
			config: {},
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: { mode: "single", results: [] } }),
		});
		assert.ok(tool);
		let invalidations = 0;
		const staleTimer = setInterval(() => { invalidations++; }, 60_000);
		const context = { state: { subagentResultAnimationTimer: staleTimer }, invalidate() { invalidations++; } };
		try {
			tool.renderResult({
				content: [{ type: "text", text: "(running...)" }],
				details: {
					mode: "single",
					results: [],
					progress: [{ status: "running", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 }],
				},
			}, {}, theme, context);
			assert.equal((context.state as { subagentResultAnimationTimer?: unknown }).subagentResultAnimationTimer, undefined);
			assert.equal(invalidations, 0);
		} finally {
			clearInterval(staleTimer);
			tool.renderResult({ content: [], details: { mode: "single", results: [], progress: [] } }, {}, theme, context);
		}
	});
});
