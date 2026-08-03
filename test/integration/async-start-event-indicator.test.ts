import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createCompletionBroker } from "../../src/runs/background/completion-broker.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker/tracker.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import {
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_STARTED_EVENT,
	TEMP_ROOT_DIR,
	WIDGET_KEY,
	type SubagentState,
} from "../../src/shared/types.ts";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";
import {
	available,
	executeAsyncChain,
	executeAsyncSingle,
	isAsyncAvailable,
	waitForAsyncResultFile,
} from "../support/async-execution-harness.ts";

const artifactConfig = {
	enabled: false,
	includeInput: false,
	includeOutput: false,
	includeJsonl: false,
	includeMetadata: false,
	cleanupDays: 7,
};

function createState(): SubagentState {
	return {
		asyncJobs: new Map(),
		completionBroker: createCompletionBroker(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear() {} },
	};
}

describe("async start event indicator", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;
	const runIds = new Set<string>();

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir("pi-async-start-event-");
		mockPi.reset();
	});

	afterEach(() => {
		for (const id of runIds) {
			fs.rmSync(path.join(ASYNC_DIR, id), { recursive: true, force: true });
			fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
			fs.rmSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true, force: true });
		}
		runIds.clear();
		removeTempDir(tempDir);
	});

	it("emits one canonical chain start event after a successful spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const id = `chain-start-${Date.now().toString(36)}`;
		runIds.add(id);
		const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];

		const result = executeAsyncChain(id, {
			chain: [{ parallel: [
				{ agent: "worker", task: "First task" },
				{ agent: "reviewer", task: "Second task" },
			] }],
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			ctx: {
				pi: { events: { emit(channel: string, payload: Record<string, unknown>) { events.push({ channel, payload }); } } },
				cwd: tempDir,
				currentSessionId: "session-start-event",
			},
			artifactConfig,
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			resultMode: "parallel",
		});

		assert.equal(result.isError, undefined);
		const started = events.filter((event) => event.channel === SUBAGENT_ASYNC_STARTED_EVENT);
		assert.equal(started.length, 1);
		assert.equal(started[0]?.payload.id, id);
		assert.equal(started[0]?.payload.sessionId, "session-start-event");
		assert.equal(started[0]?.payload.mode, "parallel");
		assert.deepEqual(started[0]?.payload.agents, ["worker", "reviewer"]);
		assert.deepEqual(started[0]?.payload.chain, ["[worker+reviewer]"]);
		assert.deepEqual(started[0]?.payload.parallelGroups, [{ start: 0, count: 2, stepIndex: 0 }]);
		assert.ok(started[0]?.payload.workflowGraph);
		assert.equal(started[0]?.payload.asyncDir, path.join(ASYNC_DIR, id));

		await waitForAsyncResultFile(id, 10_000);
	});

	it("retains the single launcher's one-event lifecycle contract", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const id = `single-start-${Date.now().toString(36)}`;
		runIds.add(id);
		const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];

		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Single task",
			agentConfig: makeAgent("worker"),
			ctx: {
				pi: { events: { emit(channel: string, payload: Record<string, unknown>) { events.push({ channel, payload }); } } },
				cwd: tempDir,
				currentSessionId: "session-single-start",
			},
			artifactConfig,
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, undefined);
		const started = events.filter((event) => event.channel === SUBAGENT_ASYNC_STARTED_EVENT);
		assert.equal(started.length, 1);
		assert.equal(started[0]?.payload.id, id);
		assert.equal(started[0]?.payload.sessionId, "session-single-start");
		assert.equal(started[0]?.payload.mode, "single");
		assert.equal(started[0]?.payload.agent, "worker");
		assert.equal(started[0]?.payload.asyncDir, path.join(ASYNC_DIR, id));

		await waitForAsyncResultFile(id, 10_000);
	});

	it("emits no start event when the chain runner cannot spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `chain-start-fail-${Date.now().toString(36)}`;
		runIds.add(id);
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });
		const events: Array<{ channel: string; payload: unknown }> = [];

		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: {
				pi: { events: { emit(channel: string, payload: unknown) { events.push({ channel, payload }); } } },
				cwd: tempDir,
				currentSessionId: "session-start-failure",
			},
			artifactConfig,
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.equal(events.filter((event) => event.channel === SUBAGENT_ASYNC_STARTED_EVENT).length, 0);
	});

	it("mounts the editor-top widget from a public dispatch before any result event", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const state = createState();
		const eventBus = createEventBus();
		const mounted: Array<{ key: string; widget: unknown }> = [];
		const ctx = makeMinimalCtx(tempDir) as ReturnType<typeof makeMinimalCtx> & {
			hasUI: true;
			ui: {
				setWidget: (key: string, widget: unknown) => void;
				requestRender: () => void;
			};
		};
		ctx.hasUI = true;
		ctx.ui = {
			setWidget(key, widget) { mounted.push({ key, widget }); },
			requestRender() {},
		};
		state.lastUiContext = ctx as never;
		const tracker = createAsyncJobTracker({ events: eventBus } as never, state, ASYNC_DIR, { pollIntervalMs: 60_000 });
		const unsubscribe = eventBus.on(SUBAGENT_ASYNC_STARTED_EVENT, tracker.handleStarted);
		const executor = createSubagentExecutor({
			pi: { events: eventBus, getSessionName: () => "parent" } as never,
			state,
			config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} },
			asyncByDefault: false,
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [makeAgent("worker"), makeAgent("reviewer")] as never }),
			waitLifecycleRoots: { asyncDirRoot: ASYNC_DIR, resultsDir: RESULTS_DIR },
		});

		try {
			const result = await executor.execute(
				"public-dispatch",
				{
					tasks: [
						{ agent: "worker", task: "First task" },
						{ agent: "reviewer", task: "Second task" },
					],
					async: true,
					artifacts: false,
				},
				new AbortController().signal,
				undefined,
				ctx as never,
			);
			const runId = result.details?.runId;
			assert.equal(typeof runId, "string");
			runIds.add(runId!);
			assert.equal(result.isError, undefined);
			assert.ok(state.asyncJobs.has(runId!), "start event should populate tracker state");
			assert.ok(
				mounted.some((entry) => entry.key === WIDGET_KEY && entry.widget !== undefined),
				"start event should mount the editor-top widget before tool_result or completion",
			);

			await waitForAsyncResultFile(runId!, 10_000);
		} finally {
			unsubscribe();
			tracker.resetJobs(ctx as never);
			if (state.poller) {
				clearInterval(state.poller);
				state.poller = null;
			}
			state.completionBroker.dispose();
		}
	});
});
