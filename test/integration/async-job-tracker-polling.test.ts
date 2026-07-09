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

describe("async job tracker polling repair and cleanup", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("repairs stale running jobs during polling", async () => {
		const asyncRoot = createTempDir("pi-async-job-stale-");
		try {
			const resultsDir = path.join(asyncRoot, "results");
			const runDir = path.join(asyncRoot, "run-stale");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-stale",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now() - 1000,
				steps: [{ agent: "worker", status: "running", startedAt: Date.now() - 1000 }],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
				resultsDir,
				kill: pidGone,
				now: () => Date.now(),
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-stale", asyncDir: runDir, agent: "worker" });

			await waitForCondition(() => state.asyncJobs.size === 0, "stale async job cleanup");

			assert.equal(state.asyncJobs.size, 0);
			assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8")).state, "failed");
			assert.equal(JSON.parse(fs.readFileSync(path.join(resultsDir, "run-stale.json"), "utf-8")).success, false);
			assert.ok(ui.renderRequests > 0, "expected stale repair cleanup to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("repairs started jobs whose runner dies before writing status", async () => {
		const asyncRoot = createTempDir("pi-async-job-no-status-");
		try {
			const resultsDir = path.join(asyncRoot, "results");
			const runDir = path.join(asyncRoot, "run-no-status");
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
				resultsDir,
				kill: pidGone,
				now: () => Date.now() + 2000,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({
				id: "run-no-status",
				asyncDir: runDir,
				pid: 12345,
				sessionId: "session-current",
				mode: "parallel",
				agents: ["scout", "reviewer", "worker"],
				chainStepCount: 1,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			});

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.size, 0);
			const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
			const result = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-no-status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.equal(status.sessionId, "session-current");
			assert.equal(status.mode, "parallel");
			assert.equal(status.currentStep, 0);
			assert.equal(status.chainStepCount, 1);
			assert.deepEqual(status.parallelGroups, [{ start: 0, count: 3, stepIndex: 0 }]);
			assert.deepEqual(status.steps.map((step: { agent: string; status: string }) => [step.agent, step.status]), [
				["scout", "failed"],
				["reviewer", "failed"],
				["worker", "failed"],
			]);
			assert.equal(result.success, false);
			assert.equal(result.sessionId, "session-current");
			assert.ok(ui.renderRequests > 0, "expected startup-crash repair cleanup to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("cleans up jobs when status polling hits a terminal read error", async () => {
		const asyncRoot = createTempDir("pi-async-job-bad-status-");
		try {
			const runDir = path.join(asyncRoot, "run-bad-status");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), "{", "utf-8");
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-bad-status", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected malformed status cleanup to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("does not clean up a status-read failure while nested descendants are live", async () => {
		const asyncRoot = createTempDir("pi-async-job-bad-status-nested-");
		let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
		const originalError = console.error;
		console.error = () => {};
		try {
			const runDir = path.join(asyncRoot, "run-bad-status-nested");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), "{", "utf-8");
			const state = createState();
			const recorder = createEventRecorder();
			tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-bad-status-nested", asyncDir: runDir, agent: "worker" });
			const job = state.asyncJobs.get("run-bad-status-nested");
			assert.ok(job);
			job.nestedChildren = [{
				id: "nested-live",
				parentRunId: "run-bad-status-nested",
				depth: 1,
				path: [{ runId: "run-bad-status-nested" }],
				state: "running",
				agent: "nested-worker",
			}];

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.has("run-bad-status-nested"), true);
			assert.equal(state.asyncJobs.get("run-bad-status-nested")?.status, "failed");
			assert.equal(state.cleanupTimers.has("run-bad-status-nested"), false);
		} finally {
			console.error = originalError;
			tracker?.resetJobs();
			removeTempDir(asyncRoot);
		}
	});

	it("keeps root jobs running when nested refresh fails during polling", async () => {
		const asyncRoot = createTempDir("pi-async-job-nested-refresh-um");
		let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
		const originalError = console.error;
		console.error = () => {};
		try {
			const runDir = path.join(asyncRoot, "run-nested-refresh");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-nested-refresh",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.handleStarted({
				id: "run-nested-refresh",
				asyncDir: runDir,
				agent: "worker",
				nestedRoute: {
					rootRunId: "run-nested-refresh",
					eventSink: path.join(asyncRoot, "not-contained-events"),
					controlInbox: path.join(asyncRoot, "not-contained-controls"),
					capabilityToken: "bad-token",
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.equal(state.asyncJobs.get("run-nested-refresh")?.status, "running");
			assert.equal(state.cleanupTimers.has("run-nested-refresh"), false);
		} finally {
			console.error = originalError;
			tracker?.resetJobs();
			removeTempDir(asyncRoot);
		}
	});

	it("cancels cleanup timers when polling observes a non-terminal status", async () => {
		const asyncRoot = createTempDir("pi-async-job-cleanup-cancel-");
		let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
		try {
			const runDir = path.join(asyncRoot, "run-recovered");
			fs.mkdirSync(runDir, { recursive: true });
			const state = createState();
			const recorder = createEventRecorder();
			tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 1_000,
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-recovered", asyncDir: runDir, agent: "worker" });
			tracker.handleComplete({ id: "run-recovered", success: true });
			assert.equal(state.cleanupTimers.has("run-recovered"), true);

			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-recovered",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const deadline = Date.now() + 200;
			while (Date.now() < deadline && state.cleanupTimers.has("run-recovered")) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			assert.equal(state.cleanupTimers.has("run-recovered"), false);
			assert.equal(state.asyncJobs.get("run-recovered")?.status, "running");
		} finally {
			tracker?.resetJobs();
			removeTempDir(asyncRoot);
		}
	});

	it("keeps incomplete async control event lines for the next poll", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-partial");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-partial",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const eventPath = path.join(runDir, "events.jsonl");
			const partialRecord = JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-partial",
					agent: "worker",
					message: "worker needs attention",
				},
			});
			fs.writeFileSync(eventPath, partialRecord, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-partial", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.length, 0);

			fs.appendFileSync(eventPath, "\n", "utf-8");
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});
});
