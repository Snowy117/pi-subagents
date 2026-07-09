import assert from "node:assert/strict";
import { describe, it } from "node:test";

type RenderSubagentResult = (
	result: {
		content: Array<{ type: "text"; text: string }>;
		details?: {
			mode: "single" | "parallel" | "chain" | "management";
			context?: "fresh" | "fork";
			results: unknown[];
		};
	},
	options: { expanded: boolean },
	theme: {
		fg(name: string, text: string): string;
		bold(text: string): string;
	},
) => { render(width: number): string[] };

let renderSubagentResult: RenderSubagentResult | undefined;
({ renderSubagentResult } = await import("../../src/tui/render.ts") as {
	renderSubagentResult?: RenderSubagentResult;
});

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function firstGrapheme(text: string): string {
	return Array.from(text.trimStart())[0] ?? "";
}

function withTerminalWidth<T>(columns: number, fn: () => T): T {
	const original = process.stdout.columns;
	Object.defineProperty(process.stdout, "columns", {
		value: columns,
		configurable: true,
	});
	try {
		return fn();
	} finally {
		Object.defineProperty(process.stdout, "columns", {
			value: original,
			configurable: true,
		});
	}
}

describe("renderSubagentResult single-result rendering", () => {
	it("shows [fork] when details are empty but context is fork", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "Async: reviewer [abc123]" }],
			details: { mode: "single", context: "fork", results: [] },
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /\[fork\]/);
	});

	it("shows [fork] on single-result header", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				context: "fork",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /\[fork\]/);
	});

	it("uses compacted tool-call summaries when messages were stripped", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: undefined,
					toolCalls: [{
						text: "$ npm test -- --watch...",
						expandedText: "$ npm test -- --watch --runInBand --reporter=dot",
					}],
					usage: emptyUsage,
				}],
			},
		}, { expanded: true }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /npm test -- --watch --runInBand --reporter=dot/);
	});

	it("shows the full task in expanded mode", () => {
		const longTask = "Review the auth flow, trace the race condition, and document the precise failing tool sequence at the end.";
		const collapsed = withTerminalWidth(40, () => renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: longTask,
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
				}],
			},
		}, { expanded: false }, theme).render(40).join("\n"));

		const expanded = withTerminalWidth(40, () => renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: longTask,
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
				}],
			},
		}, { expanded: true }, theme).render(40).join("\n"));

		const unwrap = (text: string) => text.replace(/\s+/g, "");
		assert.doesNotMatch(unwrap(collapsed), /precisefailingtoolsequenceattheend\./);
		assert.match(unwrap(expanded), /precisefailingtoolsequenceattheend\./);
	});

	it("uses glyph-first compact rendering for completed subagents", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: { ...emptyUsage, turns: 2 },
					progressSummary: { toolCount: 3, tokens: 1200, durationMs: 1500 },
					sessionFile: "/tmp/session.jsonl",
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /^✓ reviewer/);
		assert.match(text, /⟳ 2/);
		assert.match(text, /3 tool uses/);
		assert.match(text, /1\.2k token/);
		assert.match(text, /⎿  Done/);
		assert.match(text, /session: \/tmp\/session\.jsonl/);
	});

	it("keeps failure reasons visible in compact rendering", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "failed" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 1,
					error: "boom",
					messages: [],
					usage: emptyUsage,
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /^✗ reviewer/);
		assert.match(text, /⎿  Error: boom/);
	});

	it("shows live detail hints for running subagents", () => {
		const now = Date.now();
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					artifactPaths: {
						outputPath: "/tmp/reviewer_output.md",
					},
					usage: emptyUsage,
					progress: {
						index: 0,
						agent: "reviewer",
						status: "running",
						task: "review",
						lastActivityAt: now - 2_000,
						currentTool: "read",
						currentToolArgs: "package.json",
						currentToolStartedAt: now - 3_000,
						recentTools: [],
						recentOutput: [],
						toolCount: 1,
						tokens: 42,
						durationMs: 3_000,
					},
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /Press configured-expand-key for live detail/);
		assert.match(text, /active 2s ago/);
		assert.match(text, /⎿  read: package\.json \| 3\.0s/);
		assert.match(text, /output: \/tmp\/reviewer_output\.md/);
	});

	it("keeps running compact result output stable when progress is unchanged", async () => {
		const result = {
			content: [{ type: "text" as const, text: "(running...)" }],
			details: {
				mode: "single" as const,
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: {
						index: 0,
						agent: "reviewer",
						status: "running" as const,
						task: "review",
						lastActivityAt: 2_000,
						currentTool: "read",
						currentToolArgs: "package.json",
						currentToolStartedAt: 1_000,
						recentTools: [],
						recentOutput: [],
						toolCount: 1,
						tokens: 42,
						durationMs: 3_000,
					},
				}],
			},
		};
		const first = renderSubagentResult!(result, { expanded: false }, theme).render(120);
		await new Promise((resolve) => setTimeout(resolve, 120));
		const second = renderSubagentResult!(result, { expanded: false }, theme).render(120);

		assert.deepEqual(second, first);
	});

	it("advances running compact result glyphs when progress changes", () => {
		const renderGlyph = (toolCount: number) => firstGrapheme(renderSubagentResult!({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: {
						index: 0,
						agent: "reviewer",
						status: "running",
						task: "review",
						recentTools: [],
						recentOutput: [],
						toolCount,
						tokens: 0,
						durationMs: 0,
					},
				}],
			},
		}, { expanded: false }, theme).render(120)[0] ?? "");

		assert.notEqual(renderGlyph(1), renderGlyph(2));
	});
});
