import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createTempDir, removeTempDir, tryImport } from "../support/helpers.ts";

interface AsyncJobTrackerModule {
	createAsyncJobTracker(
		pi: { events: { emit(channel: string, data: unknown): void } },
		state: Record<string, unknown>,
		asyncDirRoot: string,
		options?: {
			completionRetentionMs?: number;
			pollIntervalMs?: number;
			resultsDir?: string;
			kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
			now?: () => number;
		},
	): {
		ensurePoller(): void;
		resetJobs(ctx?: unknown): void;
		restoreActiveJobs(ctx?: unknown): void;
		handleStarted(data: unknown): void;
		handleComplete(data: unknown): void;
	};
}

const trackerMod = await tryImport<AsyncJobTrackerModule>("./src/runs/background/async-job-tracker.ts");
const available = !!trackerMod;

function createState() {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

function createEventRecorder() {
	const events: Array<{ channel: string; data: unknown }> = [];
	return {
		pi: {
			events: {
				emit: (channel: string, data: unknown) => {
					events.push({ channel, data });
				},
			},
		},
		events,
	};
}

function pidGone(): never {
	const error = new Error("missing") as NodeJS.ErrnoException;
	error.code = "ESRCH";
	throw error;
}

async function waitForCondition(
	condition: () => boolean,
	description: string,
	timeoutMs = 1000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function createUiContext() {
	const widgets: unknown[] = [];
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		ui: {
			theme: {
				fg: (_theme: string, text: string) => text,
			},
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
		get widgets() {
			return widgets;
		},
		get renderRequests() {
			return renderRequests;
		},
	};
}

describe("async job tracker lifecycle and restore", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("removes completed jobs after retention and requests a rerender", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-1", asyncDir: path.join(asyncRoot, "run-1"), agent: "worker" });
			tracker.handleComplete({ id: "run-1", success: true });

			assert.equal(state.asyncJobs.size, 1);
			await new Promise((resolve) => setTimeout(resolve, 40));

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected widget cleanup to request a rerender");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("restores active async runs into the widget after reset", async () => {
		const asyncRoot = createTempDir("pi-async-job-restore-");
		try {
			const runDir = path.join(asyncRoot, "run-restored");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-restored",
				mode: "chain",
				state: "running",
				sessionId: "session-restored",
				startedAt: 1000,
				lastUpdate: 2000,
				currentStep: 1,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				steps: [
					{ agent: "scout", status: "complete" },
					{ agent: "reviewer", status: "running", currentTool: "read" },
					{ agent: "worker", status: "running" },
					{ agent: "writer", status: "pending" },
				],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-restored",
					agent: "reviewer",
					message: "old notice",
				},
			})}\n`, "utf-8");

			const state = createState();
			state.currentSessionId = "session-restored";
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.restoreActiveJobs(ui.ctx as never);

			const job = state.asyncJobs.get("run-restored");
			assert.ok(job);
			assert.equal(job.status, "running");
			assert.equal(job.sessionId, "session-restored");
			assert.deepEqual(job.agents, ["reviewer", "worker"]);
			assert.deepEqual(job.steps?.map((step: { index?: number }) => step.index), [1, 2]);
			assert.equal(job.stepsTotal, 2);
			assert.equal(job.runningSteps, 2);
			assert.equal(job.completedSteps, 0);
			assert.equal(job.activeParallelGroup, true);
			assert.ok(state.poller, "expected restored active jobs to start polling");
			assert.ok(ui.renderRequests >= 2, "expected reset and restore to request widget renders");
			assert.equal(typeof ui.widgets.at(-1), "function", "expected restored jobs to render the widget");

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.length, 0, "historical control events should not be replayed during restore");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("restores only active async runs for the current session", () => {
		const asyncRoot = createTempDir("pi-async-job-restore-scope-");
		try {
			const ownerDir = path.join(asyncRoot, "run-owner");
			const otherDir = path.join(asyncRoot, "run-other");
			fs.mkdirSync(ownerDir, { recursive: true });
			fs.mkdirSync(otherDir, { recursive: true });
			fs.writeFileSync(path.join(ownerDir, "status.json"), JSON.stringify({
				runId: "run-owner",
				mode: "single",
				state: "running",
				sessionId: "session-owner",
				startedAt: 1000,
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(otherDir, "status.json"), JSON.stringify({
				runId: "run-other",
				mode: "single",
				state: "running",
				sessionId: "session-other",
				startedAt: 1000,
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const state = createState();
			state.currentSessionId = "session-owner";
			const tracker = trackerMod!.createAsyncJobTracker(createEventRecorder().pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.restoreActiveJobs();

			assert.deepEqual([...state.asyncJobs.keys()], ["run-owner"]);
			tracker.resetJobs();
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("ignores started and complete events without the current session id", async () => {
		const asyncRoot = createTempDir("pi-async-job-event-scope-");
		try {
			const state = createState();
			state.currentSessionId = "session-owner";
			const tracker = trackerMod!.createAsyncJobTracker(createEventRecorder().pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});

			tracker.handleStarted({ id: "run-sessionless", asyncDir: path.join(asyncRoot, "run-sessionless"), agent: "worker" });
			tracker.handleStarted({ id: "run-other", asyncDir: path.join(asyncRoot, "run-other"), agent: "worker", sessionId: "session-other" });
			tracker.handleStarted({ id: "run-owner", asyncDir: path.join(asyncRoot, "run-owner"), agent: "worker", sessionId: "session-owner" });

			assert.deepEqual([...state.asyncJobs.keys()], ["run-owner"]);

			tracker.handleComplete({ id: "run-owner", success: true });
			tracker.handleComplete({ id: "run-owner", success: true, sessionId: "session-other" });
			assert.equal(state.asyncJobs.get("run-owner")?.status, "queued");

			tracker.handleComplete({ id: "run-owner", success: true, sessionId: "session-owner" });
			await waitForCondition(() => !state.asyncJobs.has("run-owner"), "owned job cleanup after matching completion", 1000);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("does not throw during restore when a persisted async status is malformed", () => {
		const asyncRoot = createTempDir("pi-async-job-restore-bad-status-");
		const originalError = console.error;
		try {
			const runDir = path.join(asyncRoot, "run-bad-status");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), "{bad json", "utf-8");

			const state = createState();
			state.currentSessionId = "session-bad";
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const errors: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				errors.push(args);
			};

			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			assert.doesNotThrow(() => tracker.restoreActiveJobs(ui.ctx as never));
			assert.equal(state.asyncJobs.size, 0);
			assert.equal(state.poller, null);
			assert.match(String(errors[0]?.[0] ?? ""), /Failed to restore active async jobs/);
		} finally {
			console.error = originalError;
			removeTempDir(asyncRoot);
		}
	});

	it("uses flattened async-start agents for initial parallel group widget state", () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot);

			tracker.handleStarted({
				id: "run-parallel-start",
				asyncDir: path.join(asyncRoot, "run-parallel-start"),
				agent: "scout",
				agents: ["scout", "reviewer", "worker", "writer"],
				chain: ["[scout+reviewer+worker]", "writer"],
				chainStepCount: 2,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			});

			const job = state.asyncJobs.get("run-parallel-start");
			assert.deepEqual(job?.agents, ["scout", "reviewer", "worker"]);
			assert.equal(job?.chainStepCount, 2);
			assert.deepEqual(job?.parallelGroups, [{ start: 0, count: 3, stepIndex: 0 }]);
			assert.equal(job?.stepsTotal, 3);
			assert.equal(job?.activeParallelGroup, true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("adds flat step indexes to polled active parallel group steps", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-chain");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-chain",
				mode: "chain",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				currentStep: 1,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				steps: [
					{ agent: "scout", status: "complete" },
					{
						agent: "reviewer",
						status: "running",
						currentTool: "read",
						currentToolArgs: "src/tui/render.ts",
						recentTools: [{ tool: "grep", args: "async widget", endMs: Date.now() - 100 }],
						recentOutput: ["reviewer line"],
					},
					{ agent: "auditor", status: "running" },
					{ agent: "writer", status: "pending" },
				],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-chain", asyncDir: runDir, mode: "chain", agents: ["scout", "reviewer", "auditor", "writer"] });

			await new Promise((resolve) => setTimeout(resolve, 50));

			const job = state.asyncJobs.get("run-chain");
			assert.deepEqual(job?.steps?.map((step: { index?: number }) => step.index), [1, 2]);
			assert.deepEqual(job?.agents, ["reviewer", "auditor"]);
			assert.equal(job?.steps?.[0]?.currentTool, "read");
			assert.equal(job?.steps?.[0]?.currentToolArgs, "src/tui/render.ts");
			assert.deepEqual(job?.steps?.[0]?.recentTools?.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })), [{ tool: "grep", args: "async widget" }]);
			assert.deepEqual(job?.steps?.[0]?.recentOutput, ["reviewer line"]);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("rerenders changed polled status but not unchanged bookkeeping", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-unchanged");
			fs.mkdirSync(runDir, { recursive: true });
			const writeStatus = (lastUpdate: number, toolCount?: number) => fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-unchanged",
				mode: "single",
				state: "running",
				startedAt: 1000,
				lastUpdate,
				...(toolCount !== undefined ? { toolCount } : {}),
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			}), "utf-8");
			writeStatus(2000);

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-unchanged", asyncDir: runDir, agent: "worker" });

			const requestsAfterStart = ui.renderRequests;
			await new Promise((resolve) => setTimeout(resolve, 35));
			assert.ok(ui.renderRequests > requestsAfterStart, "first status load should redraw the widget");

			const requestsAfterStatusLoaded = ui.renderRequests;
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-unchanged",
					agent: "worker",
					message: "worker needs attention",
				},
			})}\n`, "utf-8");
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), true);
			assert.equal(ui.renderRequests, requestsAfterStatusLoaded, "unchanged status and control cursors should not request widget redraws");

			writeStatus(3000, 1);
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.ok(ui.renderRequests > requestsAfterStatusLoaded, "changed non-terminal status should redraw the widget");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("schedules cleanup when polling observes a completed status without a completion event", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-2");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-2",
				mode: "single",
				state: "complete",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "complete" }],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-2", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected polling cleanup to request a rerender");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});
});
