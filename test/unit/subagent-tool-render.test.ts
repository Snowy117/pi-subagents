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
	it("renders the async badge for an explicit detached call", () => {
		assert.match(renderCall({}, { tasks: [{ agent: "delegate" }], async: true }), /\[async\]/);
	});

	it("uses asyncByDefault only when the caller does not explicitly choose a policy", () => {
		assert.match(renderCall({ asyncByDefault: true }, { tasks: [{ agent: "delegate" }] }), /\[async\]/);
		assert.doesNotMatch(renderCall({ asyncByDefault: true }, { tasks: [{ agent: "delegate" }], async: false }), /\[async\]/);
	});

	it("renders the async badge when top-level detachment is forced", () => {
		assert.match(renderCall({ forceTopLevelAsync: true }, { tasks: [{ agent: "delegate" }], async: false }), /\[async\]/);
	});
});
