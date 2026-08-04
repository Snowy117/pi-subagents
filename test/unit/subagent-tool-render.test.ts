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
});
