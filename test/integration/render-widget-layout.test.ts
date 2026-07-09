import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { buildWidgetLines, clearLegacyResultAnimationTimer, renderWidget } = await import("../../src/tui/render.ts") as {
	buildWidgetLines: (jobs: Array<Record<string, unknown>>, theme: { fg(name: string, text: string): string; bold(text: string): string }, width?: number, expanded?: boolean) => string[];
	clearLegacyResultAnimationTimer: (context: { state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> } }) => void;
	renderWidget: (ctx: Record<string, unknown>, jobs: Array<Record<string, unknown>>) => void;
};

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const runningGlyphPattern = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function outputPathPattern(posixPath: string): RegExp {
	return new RegExp(`output: ${posixPath.split("/").map(escapeRegExp).join("[\\\\/]")}`);
}

function firstGrapheme(text: string): string {
	return Array.from(text.trimStart())[0] ?? "";
}

function firstRunningGlyph(text: string): string {
	return text.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]/)?.[0] ?? "";
}

function createUiContext() {
	const widgets: unknown[] = [];
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setWidget: (_key: string, value: unknown) => {
				widgets.push(value);
			},
			requestRender: () => {
				renderRequests += 1;
			},
		},
	};
	return {
		ctx,
		widgets,
		get renderRequests() {
			return renderRequests;
		},
	};
}

function renderWidgetLines(widget: unknown, width = 180): string[] {
	return (widget as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] })(undefined, theme).render(width);
}

function restoreDescriptor(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	Reflect.deleteProperty(target, key);
}

function withStdoutSize<T>(rows: number, columns: number, fn: () => T): T {
	const stdout = process.stdout as NodeJS.WriteStream & { rows?: number; columns?: number };
	const rowsDescriptor = Object.getOwnPropertyDescriptor(stdout, "rows");
	const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, "columns");
	Object.defineProperty(stdout, "rows", { configurable: true, value: rows });
	Object.defineProperty(stdout, "columns", { configurable: true, value: columns });
	try {
		return fn();
	} finally {
		restoreDescriptor(stdout, "rows", rowsDescriptor);
		restoreDescriptor(stdout, "columns", columnsDescriptor);
	}
}

function resetWidgetLayout(): void {
	renderWidget(createUiContext().ctx as never, []);
}

describe("subagent async widget layout and terminal sizing", () => {
	it("orders running jobs before queued summaries and completions", () => {
		const lines = buildWidgetLines([
			{ asyncId: "done-1", asyncDir: "/tmp/done", status: "complete", agents: ["reviewer"], startedAt: 0, updatedAt: 1000 },
			{ asyncId: "queued-1", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"], startedAt: 0, updatedAt: 1000 },
			{ asyncId: "run-1", asyncDir: "/tmp/run", status: "running", agents: ["scout"], currentStep: 0, stepsTotal: 2, startedAt: Date.now() - 1000, updatedAt: Date.now(), currentTool: "read", currentToolStartedAt: Date.now() - 500 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, new RegExp(`^${runningGlyphPattern} Async agents · background`));
		assert.ok(text.indexOf("scout") < text.indexOf("queued"), "running row should precede queued summary");
		assert.ok(text.indexOf("queued") < text.indexOf("reviewer"), "queued summary should precede completions");
		assert.match(text, /⎿  read/);
	});

	it("uses parallel running/done wording for async jobs with parallel groups", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", mode: "parallel", agents: ["scout", "reviewer", "worker"], hasParallelGroups: true, activeParallelGroup: true, runningSteps: 3, completedSteps: 0, stepsTotal: 3 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, /parallel · 3 agents running · 0\/3 done/);
		assert.match(text, /⎿  thinking…/);
		assert.doesNotMatch(text, /parallel · scout, reviewer, worker/);
		assert.doesNotMatch(text, /step 1\/3/);
	});

	it("collapses repeated async parallel agent names", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", mode: "parallel", agents: ["reviewer", "reviewer", "reviewer"], activeParallelGroup: true, runningSteps: 3, completedSteps: 0, stepsTotal: 3 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, /parallel · 3 agents running/);
		assert.doesNotMatch(text, /parallel · reviewer ×3/);
		assert.doesNotMatch(text, /reviewer → reviewer → reviewer/);
	});

	it("renders a compact component widget for three active parallel agents without core truncation", () => {
		const now = Date.now();
		const ui = createUiContext();
		renderWidget(ui.ctx as never, [{
			asyncId: "run-1",
			asyncDir: "/tmp/1",
			status: "running",
			mode: "parallel",
			agents: ["reviewer", "reviewer", "reviewer"],
			activeParallelGroup: true,
			runningSteps: 3,
			completedSteps: 0,
			stepsTotal: 3,
			updatedAt: now,
			steps: [
				{ index: 0, agent: "reviewer", status: "running", lastActivityAt: now, turnCount: 5, toolCount: 18, tokens: { input: 30_000, output: 10_000, cache: 4_000, total: 44_000 } },
				{ index: 1, agent: "reviewer", status: "running", lastActivityAt: now - 2000, turnCount: 4, toolCount: 13, tokens: { input: 16_000, output: 4_000, cache: 2_000, total: 22_000 } },
				{ index: 2, agent: "reviewer", status: "running", currentTool: "grep", currentToolStartedAt: now - 1000, turnCount: 3, toolCount: 11, tokens: { input: 14_000, output: 3_000, cache: 2_000, total: 19_000 } },
			],
		}]);
		const widget = ui.widgets.at(-1);
		assert.equal(typeof widget, "function", "renderWidget should install a component widget, not a capped string-array widget");
		const lines = (widget as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] })(undefined, theme).render(180).map((line) => line.trimEnd());
		const text = lines.join("\n");
		assert.match(text, /async subagent parallel \(3\) · background/);
		assert.match(text, /Agent 1\/3: reviewer · running · active now · 5 turns · 18 tool uses · 44k token/);
		assert.match(text, /Agent 2\/3: reviewer · running · active 2s ago · 4 turns · 13 tool uses · 22k token/);
		assert.match(text, /Agent 3\/3: reviewer · running · grep \| 1\.0s · 3 turns · 11 tool uses · 19k token/);
		assert.match(text, /Press configured-expand-key for live detail/);
		assert.doesNotMatch(text, /widget truncated/);
		assert.ok(lines.length <= 10, "collapsed component should stay under Pi's string-widget cap even though it bypasses it");
	});

	it("locks crowded collapsed widget height for the current terminal session", () => {
		resetWidgetLayout();
		withStdoutSize(30, 120, () => {
			const now = 20_000;
			const crowdedJobs = Array.from({ length: 3 }, (_, jobIndex) => ({
				asyncId: `run-${jobIndex + 1}`,
				asyncDir: `/tmp/run-${jobIndex + 1}`,
				status: "running",
				mode: "parallel",
				agents: ["scout", "reviewer"],
				activeParallelGroup: true,
				runningSteps: 2,
				completedSteps: 0,
				stepsTotal: 2,
				updatedAt: now + jobIndex,
				steps: [
					{ index: 0, agent: "scout", status: "running", currentTool: "read", currentToolStartedAt: now - 1000 },
					{ index: 1, agent: "reviewer", status: "running", currentTool: "grep", currentToolStartedAt: now - 2000 },
				],
			}));
			const ui = createUiContext();

			renderWidget(ui.ctx as never, crowdedJobs);
			const crowdedLines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(crowdedLines.length, 10, "30 terminal rows should keep the compact widget cap while locking height");
			assert.match(crowdedLines.join("\n"), /Async agents · 3 agents running/);

			renderWidget(ui.ctx as never, [{
				...crowdedJobs[0]!,
				status: "complete",
				runningSteps: 0,
				completedSteps: 2,
				steps: [
					{ index: 0, agent: "scout", status: "complete" },
					{ index: 1, agent: "reviewer", status: "complete" },
				],
			}]);
			const settledLines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(settledLines.length, 10, "collapsed widget keeps its locked row count until cleared or resized");
			assert.match(settledLines.join("\n"), /parallel · done/);

			renderWidget(ui.ctx as never, []);
			renderWidget(ui.ctx as never, [{ asyncId: "small", asyncDir: "/tmp/small", status: "running", agents: ["worker"], currentTool: "read" }]);
			const resetLines = renderWidgetLines(ui.widgets.at(-1));
			assert.ok(resetLines.length < 10, "clearing the widget starts a fresh layout session");
		});
		resetWidgetLayout();
	});

	it("keeps medium terminal progressive fallback within the compact cap", () => {
		resetWidgetLayout();
		withStdoutSize(50, 120, () => {
			const ui = createUiContext();
			const jobs = [{
				asyncId: "run-wide",
				asyncDir: "/tmp/run-wide",
				status: "running",
				mode: "parallel",
				agents: Array.from({ length: 40 }, (_, index) => `agent-${index}`),
				activeParallelGroup: true,
				runningSteps: 40,
				completedSteps: 0,
				stepsTotal: 40,
				steps: Array.from({ length: 40 }, (_, index) => ({ index, agent: `agent-${index}`, status: "running", currentTool: "read" })),
			}];

			renderWidget(ui.ctx as never, jobs);
			const lines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(lines.length, 14);
			assert.match(lines.join("\n"), /parallel · running/);
		});
		resetWidgetLayout();
	});

	it("keeps constrained progressive slots focused on active jobs", () => {
		resetWidgetLayout();
		withStdoutSize(22, 120, () => {
			const ui = createUiContext();
			const jobs = [
				{ asyncId: "run-1", asyncDir: "/tmp/run-1", status: "running", mode: "single", agents: ["first"], currentTool: "read" },
				{ asyncId: "run-2", asyncDir: "/tmp/run-2", status: "running", mode: "single", agents: ["second"], currentTool: "grep" },
				{ asyncId: "run-3", asyncDir: "/tmp/run-3", status: "running", mode: "single", agents: ["third"], currentTool: "edit" },
			];
			renderWidget(ui.ctx as never, jobs);
			const firstText = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(firstText, /first/);
			assert.match(firstText, /\+2 more/);

			renderWidget(ui.ctx as never, [
				{ ...jobs[0]!, status: "complete", currentTool: undefined },
				jobs[1]!,
				jobs[2]!,
			]);
			const updatedText = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(updatedText, /second/);
			assert.doesNotMatch(updatedText, /first · done/);
			assert.match(updatedText, /\+2 more/);
		});
		resetWidgetLayout();
	});

	it("uses a single collapsed widget line when the terminal has almost no spare rows", () => {
		resetWidgetLayout();
		withStdoutSize(20, 120, () => {
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [{
				asyncId: "run-tiny",
				asyncDir: "/tmp/run-tiny",
				status: "running",
				agents: ["worker"],
				currentTool: "read",
			}]);

			const lines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(lines.length, 1);
			assert.match(lines[0] ?? "", /subagents \(1\/1 running\)/);
		});
		resetWidgetLayout();
	});

	it("keeps expanded async widgets on the full-detail path", () => {
		resetWidgetLayout();
		withStdoutSize(20, 120, () => {
			const ui = createUiContext();
			ui.ctx.ui.getToolsExpanded = () => true;
			renderWidget(ui.ctx as never, [{
				asyncId: "run-expanded",
				asyncDir: "/tmp/run-expanded",
				status: "running",
				mode: "parallel",
				agents: ["reviewer"],
				activeParallelGroup: true,
				runningSteps: 1,
				completedSteps: 0,
				stepsTotal: 1,
				steps: [{ index: 0, agent: "reviewer", status: "running", currentTool: "read" }],
			}]);

			const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(text, /async subagent parallel · background/);
			assert.match(text, /Agent 1\/1: reviewer · running/);
			assert.doesNotMatch(text, /subagents \(1\/1 running\)/);
		});
		resetWidgetLayout();
	});
});
