import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { ASYNC_DIR, INTERCOM_DETACH_REQUEST_EVENT, RESULTS_DIR, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/shared/types.ts";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	events,
	makeAgent,
	makeMinimalCtx,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";

interface ExecutorResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details?: {
		mode?: string;
		runId?: string;
		results?: Array<{ agent?: string; finalOutput?: string }>;
		asyncId?: string;
	};
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<ExecutorResult>;
	};
}

const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!executorMod?.createSubagentExecutor;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function createRecordingEventBus(options: { acknowledgeResults?: boolean } = {}) {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const bus = {
		emitted,
		on(channel: string, handler: (payload: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(handler);
			listeners.set(channel, channelListeners);
			return () => {
				channelListeners.delete(handler);
				if (channelListeners.size === 0) listeners.delete(channel);
			};
		},
		emit(channel: string, payload: unknown) {
			emitted.push({ channel, payload });
			for (const handler of listeners.get(channel) ?? []) {
				handler(payload);
			}
			if (options.acknowledgeResults && channel === "subagent:result-intercom") {
				const requestId = payload && typeof payload === "object" ? (payload as { requestId?: unknown }).requestId : undefined;
				if (typeof requestId === "string") {
					setImmediate(() => bus.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
				}
			}
		},
	};
	return bus;
}

describe("intercom result delivery grouped delivery and resume attach", { skip: !available ? "executor not importable" : undefined }, () => {
	let tempDir: string;
	let homeDir: string;
	let mockPi: MockPi;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;

	before(() => {
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		homeDir = createTempDir("pi-subagent-intercom-home-");
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		mockPi = createMockPi();
		mockPi.install();
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "extensions", "pi-intercom"), { recursive: true });
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "intercom"), { recursive: true });
		fs.writeFileSync(path.join(os.homedir(), ".pi", "agent", "intercom", "config.json"), JSON.stringify({ enabled: true }), "utf-8");
	});

	after(() => {
		mockPi.uninstall();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		removeTempDir(homeDir);
	});

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-intercom-result-");
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	async function readMockCallArgs(index: number): Promise<string[]> {
		const deadline = Date.now() + 10_000;
		let callFile: string | undefined;
		while (!callFile) {
			callFile = fs.readdirSync(mockPi.dir)
				.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
				.sort()[index];
			if (callFile || Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(callFile, `expected mock pi call at index ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!fs.existsSync(filePath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for file: ${filePath}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	function makeExecutor(options: { bridgeMode?: "always" | "off"; agents?: ReturnType<typeof makeAgent>[]; acknowledgeResults?: boolean; kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean } = {}) {
		const events = createRecordingEventBus({ acknowledgeResults: options.acknowledgeResults ?? true });
		const state = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
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
		const executor = createSubagentExecutor!({
			pi: {
				events,
				getSessionName: () => "orchestrator",
				setSessionName: () => {},
			},
			state,
			config: {
				intercomBridge: { mode: options.bridgeMode ?? "always" },
			},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: options.agents ?? [makeAgent("worker")] }),
			kill: options.kill,
		});
		return { executor, events, state };
	}

	it("single foreground runs emit one grouped event and return a compact receipt", async () => {
		mockPi.onCall({ output: "Full child output from worker" });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-intercom",
			{ agent: "worker", task: "Implement feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const intercomEvents = events.emitted.filter((entry) => entry.channel === "subagent:result-intercom");
		assert.equal(intercomEvents.length, 1);
		const payload = intercomEvents[0]!.payload as { children?: Array<{ agent?: string; intercomTarget?: string }>; message?: string; mode?: string };
		assert.equal(payload.mode, "single");
		assert.equal(payload.children?.length, 1);
		assert.equal(payload.children?.[0]?.agent, "worker");
		assert.match(payload.children?.[0]?.intercomTarget ?? "", /^subagent-worker-[a-f0-9]+-1$/);
		assert.match(String(payload.message ?? ""), /Intercom targets below identify child sessions used while they were running/);
		assert.match(String(payload.message ?? ""), /Run intercom target: subagent-worker-[a-f0-9]+-1/);
		assert.match(result.content[0]?.text ?? "", /Delivered single subagent result via intercom\./);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Full child output from worker/);
		assert.equal(result.details?.results?.[0]?.finalOutput, undefined);
		assert.match(String(payload.message ?? ""), /Full child output from worker/);
	});

	it("falls back to legacy foreground output when the bridge is inactive", async () => {
		mockPi.onCall({ output: "Legacy foreground output" });
		const { executor, events } = makeExecutor({ bridgeMode: "off" });

		const result = await executor.execute(
			"single-no-intercom",
			{ agent: "worker", task: "Summarize feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Legacy foreground output/);
	});

	it("falls back to legacy foreground output when grouped delivery is not acknowledged", async () => {
		mockPi.onCall({ output: "Unacknowledged foreground output" });
		const { executor, events } = makeExecutor({ acknowledgeResults: false });

		const result = await executor.execute(
			"single-no-ack",
			{ agent: "worker", task: "Summarize feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), true);
		assert.match(result.content[0]?.text ?? "", /Unacknowledged foreground output/);
	});

	it("top-level parallel runs emit one grouped event containing all children", async () => {
		mockPi.onCall({ output: "Parallel child output" });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

		const result = await executor.execute(
			"parallel-intercom",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const intercomEvents = events.emitted.filter((entry) => entry.channel === "subagent:result-intercom");
		assert.equal(intercomEvents.length, 1);
		const payload = intercomEvents[0]!.payload as { children?: Array<{ agent?: string; intercomTarget?: string }>; message?: string; mode?: string };
		assert.equal(payload.mode, "parallel");
		assert.deepEqual((payload.children ?? []).map((child) => child.agent).sort(), ["a", "b"]);
		assert.equal((payload.children ?? []).every((child) => /^subagent-[ab]-[a-f0-9]+-[12]$/.test(child.intercomTarget ?? "")), true);
		assert.match(String(payload.message ?? ""), /Intercom targets below identify child sessions used while they were running/);
		assert.match(String(payload.message ?? ""), /Run intercom target: subagent-a-[a-f0-9]+-1/);
		assert.match(String(payload.message ?? ""), /1\. a — completed/);
		assert.match(String(payload.message ?? ""), /2\. b — completed/);
		assert.match(result.content[0]?.text ?? "", /Delivered parallel subagent results via intercom\./);
		assert.equal(result.details?.results?.every((entry) => entry.finalOutput === undefined), true);
	});

	it("chain runs emit one grouped event containing all executed children", async () => {
		mockPi.onCall({ output: "Chain child output" });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b"), makeAgent("c")] });

		const result = await executor.execute(
			"chain-intercom",
			{
				chain: [
					{ agent: "a", task: "step-a" },
					{ parallel: [{ agent: "b", task: "step-b" }, { agent: "c", task: "step-c" }] },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const intercomEvents = events.emitted.filter((entry) => entry.channel === "subagent:result-intercom");
		assert.equal(intercomEvents.length, 1);
		const payload = intercomEvents[0]!.payload as { children?: Array<{ agent?: string; intercomTarget?: string }>; message?: string; mode?: string };
		assert.equal(payload.mode, "chain");
		assert.deepEqual((payload.children ?? []).map((child) => child.agent).sort(), ["a", "b", "c"]);
		assert.equal((payload.children ?? []).every((child) => /^subagent-[abc]-[a-f0-9]+-[123]$/.test(child.intercomTarget ?? "")), true);
		assert.match(String(payload.message ?? ""), /1\. a — completed/);
		assert.match(String(payload.message ?? ""), /2\. b — completed/);
		assert.match(String(payload.message ?? ""), /3\. c — completed/);
		assert.match(result.content[0]?.text ?? "", /Delivered chain subagent results via intercom\./);
		assert.equal(result.details?.results?.every((entry) => entry.finalOutput === undefined), true);
	});

	it("detached chain runs do not emit grouped completion receipts", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }), makeAgent("b")] });
		let detachEmitted = false;

		const result = await executor.execute(
			"chain-detached-intercom",
			{
				chain: [
					{ agent: "a", task: "ask supervisor" },
					{ agent: "b", task: "must not run" },
				],
			},
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-detached" });
			},
			makeMinimalCtx(tempDir),
		);

		assert.equal(detachEmitted, true);
		assert.match(result.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /resume/);
		assert.equal(bus.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.equal(mockPi.callCount(), 1);
	});

	it("resume action sends a follow-up to a live async child when the target is registered", async () => {
		const runId = `resume-live-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				pid: process.pid,
				startedAt: 100,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}, null, 2), "utf-8");
			const { executor, events } = makeExecutor({
				kill: (pid, signal) => {
					kills.push({ pid, signal });
					return true;
				},
			});

			const result = await executor.execute(
				"resume-live",
				{ action: "resume", id: runId, message: "Can you clarify the last change?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Interrupted live async child, then delivered follow-up/);
			assert.deepEqual(kills, [
				{ pid: process.pid, signal: 0 },
				{ pid: process.pid, signal: process.platform === "win32" ? "SIGBREAK" : "SIGUSR2" },
			]);
			const payload = events.emitted.find((entry) => entry.channel === "subagent:result-intercom")?.payload as { to?: string; message?: string } | undefined;
			assert.equal(payload?.to, `subagent-worker-${runId}-1`);
			assert.match(payload?.message ?? "", /Can you clarify the last change\?/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action can attach a live async child as the first step of a new chain", async () => {
		const sourceRunId = `resume-chain-root-${Date.now()}`;
		const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
		const sourceResultPath = path.join(RESULTS_DIR, `${sourceRunId}.json`);
		const sourceSession = path.join(tempDir, "source-child.jsonl");
		try {
			fs.mkdirSync(sourceAsyncDir, { recursive: true });
			fs.mkdirSync(RESULTS_DIR, { recursive: true });
			fs.writeFileSync(sourceSession, "", "utf-8");
			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify({
				runId: sourceRunId,
				mode: "single",
				state: "running",
				pid: process.pid,
				startedAt: 100,
				lastUpdate: 100,
				cwd: tempDir,
				steps: [{ agent: "worker", status: "running", sessionFile: sourceSession }],
			}, null, 2), "utf-8");
			fs.writeFileSync(sourceResultPath, JSON.stringify({
				id: sourceRunId,
				agent: "worker",
				mode: "single",
				success: true,
				state: "complete",
				summary: "root output",
				results: [{ agent: "worker", output: "root output", success: true, sessionFile: sourceSession }],
			}, null, 2), "utf-8");
			const { executor, events } = makeExecutor({ agents: [makeAgent("worker"), makeAgent("reviewer")] });

			const result = await executor.execute(
				"resume-chain-root",
				{
					action: "resume",
					id: sourceRunId,
					chain: [{ agent: "reviewer", task: "Review this root result: {previous}" }],
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Attached async subagent/);
			const startedEvent = events.emitted.find((entry) => entry.channel === SUBAGENT_ASYNC_STARTED_EVENT)?.payload as { agent?: string; agents?: string[]; chain?: string[]; chainStepCount?: number } | undefined;
			assert.equal(startedEvent?.agent, "worker");
			assert.deepEqual(startedEvent?.agents, ["worker", "reviewer"]);
			assert.deepEqual(startedEvent?.chain, ["worker", "reviewer"]);
			assert.equal(startedEvent?.chainStepCount, 2);
			const attachedId = result.details?.asyncId;
			assert.ok(attachedId, "expected attached chain async id");
			assert.match(result.details?.asyncDir ?? "", new RegExp(`${attachedId}$`));
			const statusPath = path.join(result.details!.asyncDir!, "status.json");
			await waitForFile(statusPath);
			const attachedStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { mode?: string; chainStepCount?: number; steps?: Array<{ agent?: string; label?: string; status?: string }> };
			assert.equal(attachedStatus.mode, "chain");
			assert.equal(attachedStatus.chainStepCount, 2);
			assert.deepEqual(attachedStatus.steps?.map((step) => step.agent), ["worker", "reviewer"]);
			assert.match(attachedStatus.steps?.[0]?.label ?? "", /Attached resume-chain-root-/);
			await waitForFile(path.join(RESULTS_DIR, `${attachedId}.json`));
		} finally {
			fs.rmSync(sourceAsyncDir, { recursive: true, force: true });
			fs.rmSync(sourceResultPath, { force: true });
		}
	});

	it("resume action can attach a completed async result without reviving from a session", async () => {
		const sourceRunId = `resume-chain-complete-root-${Date.now()}`;
		const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
		const sourceResultPath = path.join(RESULTS_DIR, `${sourceRunId}.json`);
		try {
			fs.mkdirSync(sourceAsyncDir, { recursive: true });
			fs.mkdirSync(RESULTS_DIR, { recursive: true });
			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify({
				runId: sourceRunId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "worker", status: "complete" }],
			}, null, 2), "utf-8");
			fs.writeFileSync(sourceResultPath, JSON.stringify({
				id: sourceRunId,
				agent: "worker",
				mode: "single",
				success: true,
				state: "complete",
				summary: "completed root output",
				results: [{ agent: "worker", output: "completed root output", success: true }],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor({ agents: [makeAgent("worker"), makeAgent("reviewer")] });

			const reviveOnly = await executor.execute(
				"resume-chain-complete-root-revive-only",
				{ action: "resume", id: sourceRunId, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(reviveOnly.isError, true);
			assert.match(reviveOnly.content[0]?.text ?? "", /does not have a persisted session file/);

			const attached = await executor.execute(
				"resume-chain-complete-root",
				{
					action: "resume",
					id: sourceRunId,
					chain: [{ agent: "reviewer", task: "Review this completed root result: {previous}" }],
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(attached.isError, undefined);
			assert.match(attached.content[0]?.text ?? "", /Attached async subagent/);
			assert.ok(attached.details?.asyncId, "expected attached chain async id");
			await waitForFile(path.join(RESULTS_DIR, `${attached.details.asyncId}.json`));
		} finally {
			fs.rmSync(sourceAsyncDir, { recursive: true, force: true });
			fs.rmSync(sourceResultPath, { force: true });
		}
	});
});
