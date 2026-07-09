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

describe("renderSubagentResult multi-result rendering", () => {
	it("keeps paused multi-result runs visible in the compact headline", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "paused" }],
			details: {
				mode: "chain",
				chainAgents: ["worker"],
				results: [{
					agent: "worker",
					task: "pause",
					exitCode: 0,
					interrupted: true,
					messages: [],
					usage: emptyUsage,
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /^■ chain/);
		assert.match(text, /⎿  Paused/);
	});

	it("keeps empty-output warnings visible in compact multi-result rendering", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "chain",
				chainAgents: ["worker"],
				results: [{
					agent: "worker",
					task: "check without output target",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /⎿  Done \(no text output\)/);
		assert.doesNotMatch(text, /0ms/);
	});

	it("keeps pending placeholder steps pending in compact rendering", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "running" }],
			details: {
				mode: "chain",
				chainAgents: ["a", "b"],
				totalSteps: 2,
				currentStepIndex: 0,
				results: [{
					agent: "a",
					task: "first",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 0, agent: "a", status: "running", task: "first", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}, {
					agent: "b",
					task: "second",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 1, agent: "b", status: "pending", task: "second", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}],
			},
		}, { expanded: false }, theme);

		const lines = widget.render(120);
		const pendingIndex = lines.findIndex((line) => /Step 2: b/.test(line));
		assert.notEqual(pendingIndex, -1);
		assert.match(lines[pendingIndex]!, /◦ Step 2: b · pending/);
		assert.doesNotMatch(lines[pendingIndex]!, /0ms/);
		assert.doesNotMatch(lines[pendingIndex + 1] ?? "", /Done \(no text output\)/);
	});

	it("uses running/done wording and agent fractions for live parallel rendering", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "parallel",
				totalSteps: 3,
				results: [{
					agent: "worker",
					task: "third task",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: {
						index: 2,
						agent: "worker",
						status: "running",
						task: "third task",
						recentTools: [],
						recentOutput: [],
						toolCount: 1,
						tokens: 0,
						durationMs: 10,
					},
				}],
				progress: [{
					index: 0,
					agent: "scout",
					status: "running",
					task: "first",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					tokens: 0,
					durationMs: 10,
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /parallel · 2 agents running · 0\/3 done/);
		assert.match(text, /Agent 3\/3: worker/);
		assert.doesNotMatch(text, /Step 3: worker/);
		assert.doesNotMatch(text, /Agent 1: worker/);
	});

	it("shows mixed done/running counters for top-level parallel mode", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "parallel",
				totalSteps: 3,
				results: [{
					agent: "scout",
					task: "first",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 0, agent: "scout", status: "completed", task: "first", recentTools: [], recentOutput: [], toolCount: 1, tokens: 0, durationMs: 10 },
				}, {
					agent: "reviewer",
					task: "second",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 1, agent: "reviewer", status: "running", task: "second", recentTools: [], recentOutput: [], toolCount: 1, tokens: 0, durationMs: 10 },
				}],
				progress: [{ index: 0, agent: "scout", status: "completed", task: "first", recentTools: [], recentOutput: [], toolCount: 1, tokens: 0, durationMs: 10 }, { index: 1, agent: "reviewer", status: "running", task: "second", recentTools: [], recentOutput: [], toolCount: 1, tokens: 0, durationMs: 10 }],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /parallel · 1 agent running · 1\/3 done/);
	});

	it("labels active chain parallel groups with chain step and agent fractions", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "running" }],
			details: {
				mode: "chain",
				totalSteps: 3,
				currentStepIndex: 0,
				chainAgents: ["[scout+reviewer+worker]", "planner", "writer"],
				results: [{
					agent: "scout",
					task: "scan",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 0, agent: "scout", status: "running", task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}, {
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 1, agent: "reviewer", status: "running", task: "review", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}],
				progress: [{ index: 0, agent: "scout", status: "running", task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 }, { index: 1, agent: "reviewer", status: "running", task: "review", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 }],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /chain · step 1\/3 · parallel group: 2 agents running · 0\/3 done/);
		assert.match(text, /Agent 1\/3: scout/);
		assert.match(text, /Agent 2\/3: reviewer/);
		assert.doesNotMatch(text, /Step 1: scout/);
	});

	it("shows only the active parallel group for mixed chains after a serial step", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "running" }],
			details: {
				mode: "chain",
				totalSteps: 3,
				currentStepIndex: 1,
				chainAgents: ["planner", "[scout+reviewer]", "writer"],
				results: [{
					agent: "planner",
					task: "plan",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 0, agent: "planner", status: "completed", task: "plan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}, {
					agent: "scout",
					task: "scan",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 1, agent: "scout", status: "running", task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}, {
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 2, agent: "reviewer", status: "running", task: "review", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}],
				progress: [
					{ index: 0, agent: "planner", status: "completed", task: "plan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
					{ index: 1, agent: "scout", status: "running", task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
					{ index: 2, agent: "reviewer", status: "running", task: "review", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /chain · step 2\/3 · parallel group: 2 agents running · 0\/2 done/);
		assert.match(text, /Agent 1\/2: scout/);
		assert.match(text, /Agent 2\/2: reviewer/);
		assert.doesNotMatch(text, /planner/);
		assert.doesNotMatch(text, /Agent 1\/2: planner/);
	});

	it("uses logical chain progress and agent labels for completed mixed chains", () => {
		const progress = [
			{ index: 0, agent: "planner", status: "completed" as const, task: "plan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 1 },
			{ index: 1, agent: "scout", status: "completed" as const, task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 1 },
			{ index: 2, agent: "reviewer", status: "completed" as const, task: "review", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 1 },
			{ index: 3, agent: "writer", status: "completed" as const, task: "write", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 1 },
		];
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "chain",
				totalSteps: 3,
				chainAgents: ["planner", "[scout+reviewer]", "writer"],
				results: progress.map((entry) => ({
					agent: entry.agent,
					task: entry.task,
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progressSummary: { toolCount: 0, tokens: 0, durationMs: 1 },
				})),
				progress,
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /chain · step 3\/3/);
		assert.match(text, /Step 1: planner/);
		assert.match(text, /Agent 1\/2: scout/);
		assert.match(text, /Agent 2\/2: reviewer/);
		assert.match(text, /Step 3: writer/);
		assert.doesNotMatch(text, /step 4\/4/);
	});

	it("keeps serial chain wording for non-parallel steps", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "running" }],
			details: {
				mode: "chain",
				totalSteps: 3,
				currentStepIndex: 0,
				chainAgents: ["scout", "reviewer", "worker"],
				results: [{
					agent: "scout",
					task: "scan",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 0, agent: "scout", status: "running", task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /chain · step 1\/3/);
		assert.match(text, /Step 1: scout/);
		assert.doesNotMatch(text, /parallel group:/);
	});
});
