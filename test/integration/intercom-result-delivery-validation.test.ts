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

describe("intercom result delivery validation and mixed outcomes", { skip: !available ? "executor not importable" : undefined }, () => {
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

	it("status recovers a later detached serial chain child under its original index", async () => {
		mockPi.onCall({ output: "first step done" });
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 200, jsonl: [events.assistantMessage("second recovered answer")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b", { systemPrompt: "Intercom orchestration channel:" }), makeAgent("c")] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-later-detached-chain-status-original",
			{ chain: [{ agent: "a", task: "first" }, { agent: "b", task: "ask supervisor" }, { agent: "c", task: "must not run" }] },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "later-chain-detached-status" });
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(detachEmitted, true);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		assert.match(original.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.equal(mockPi.callCount(), 2);

		const deadline = Date.now() + 5000;
		let statusText = "";
		while (Date.now() < deadline) {
			const status = await executor.execute(
				"foreground-later-detached-chain-status",
				{ action: "status", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			statusText = status.content[0]?.text ?? "";
			if (/second recovered answer/.test(statusText)) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		assert.doesNotMatch(statusText, /Async run not found/);
		assert.match(statusText, /State: remembered foreground/);
		assert.match(statusText, /a completed/);
		assert.match(statusText, /b completed/);
		assert.match(statusText, /second recovered answer/);

		const transcript = await executor.execute(
			"foreground-later-detached-chain-transcript",
			{ action: "status", id: runId, index: 1, view: "transcript" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(transcript.content[0]?.text ?? "", /second recovered answer/);
	});

	it("resume action rejects detached foreground children that may still be live", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-detached-original",
			{ agent: "a", task: "ask supervisor" },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "single-detached" });
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(detachEmitted, true);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");

		const fleet = await executor.execute(
			"foreground-detached-fleet",
			{ action: "status", view: "fleet" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const fleetText = fleet.content[0]?.text ?? "";
		assert.match(fleetText, /Detached foreground runs:/);
		assert.ok(fleetText.includes(runId));
		assert.match(fleetText, /recovery: reply to the supervisor request first/);

		const resumed = await executor.execute(
			"foreground-detached-resume",
			{ action: "resume", id: runId, message: "Follow up" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(resumed.isError, true);
		assert.match(resumed.content[0]?.text ?? "", /detached for intercom coordination/);
		assert.match(resumed.content[0]?.text ?? "", /Reply to the supervisor request first/);
		assert.doesNotMatch(resumed.content[0]?.text ?? "", /revive only/);
	});

	it("resume action keeps exact foreground validation errors over async prefix matches", async () => {
		const base = `exact-invalid-${Date.now()}`;
		const asyncSession = path.join(tempDir, "async-exact-prefix.jsonl");
		fs.writeFileSync(asyncSession, "", "utf-8");
		const asyncDir = path.join(ASYNC_DIR, `${base}-async`);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: `${base}-async`,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(base, {
				runId: base,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed" }],
			});

			const result = await executor.execute(
				"resume-exact-invalid-foreground",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Foreground run '.+' child 0 does not have a persisted session file/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action keeps exact async validation errors over foreground prefix matches", async () => {
		const base = `exact-invalid-async-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground-exact-prefix.jsonl");
		fs.writeFileSync(foregroundSession, "", "utf-8");
		const asyncDir = path.join(ASYNC_DIR, base);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: base,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(`${base}-foreground`, {
				runId: `${base}-foreground`,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"resume-exact-invalid-async",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Async run '.+' child 0 does not have a persisted session file/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action reports async ambiguity even when foreground has one prefix match", async () => {
		const base = `namespace-ambiguous-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground-prefix.jsonl");
		const firstAsyncSession = path.join(tempDir, "async-a.jsonl");
		const secondAsyncSession = path.join(tempDir, "async-b.jsonl");
		fs.writeFileSync(foregroundSession, "", "utf-8");
		fs.writeFileSync(firstAsyncSession, "", "utf-8");
		fs.writeFileSync(secondAsyncSession, "", "utf-8");
		const firstAsyncDir = path.join(ASYNC_DIR, `${base}-async-a`);
		const secondAsyncDir = path.join(ASYNC_DIR, `${base}-async-b`);
		try {
			for (const [asyncDir, runId, sessionFile] of [[firstAsyncDir, `${base}-async-a`, firstAsyncSession], [secondAsyncDir, `${base}-async-b`, secondAsyncSession]] as const) {
				fs.mkdirSync(asyncDir, { recursive: true });
				fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
					runId,
					mode: "single",
					state: "complete",
					startedAt: 100,
					lastUpdate: 200,
					cwd: tempDir,
					steps: [{ agent: "a", status: "complete", sessionFile }],
				}, null, 2), "utf-8");
			}
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(`${base}-foreground`, {
				runId: `${base}-foreground`,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"ambiguous-async-prefix-resume",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Ambiguous subagent run id prefix/);
		} finally {
			fs.rmSync(firstAsyncDir, { recursive: true, force: true });
			fs.rmSync(secondAsyncDir, { recursive: true, force: true });
		}
	});

	it("resume action reports ambiguous ids across remembered foreground and async runs", async () => {
		const base = `ambiguous-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground.jsonl");
		const asyncSession = path.join(tempDir, "async.jsonl");
		const asyncId = `${base}-async`;
		const foregroundId = `${base}-foreground`;
		const asyncDir = path.join(ASYNC_DIR, asyncId);
		fs.writeFileSync(foregroundSession, "", "utf-8");
		fs.writeFileSync(asyncSession, "", "utf-8");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: asyncId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(foregroundId, {
				runId: foregroundId,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"ambiguous-resume",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /ambiguous between foreground run/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("mixed foreground outcomes produce failed grouped status and receipt counts", async () => {
		mockPi.onCall({ matchArgIncludes: "task-a", output: "Parallel child success", exitCode: 0 });
		mockPi.onCall({ matchArgIncludes: "task-b", output: "Parallel child failure", stderr: "Parallel child failure", exitCode: 1 });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

		const result = await executor.execute(
			"parallel-mixed-intercom",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const intercomEvents = events.emitted.filter((entry) => entry.channel === "subagent:result-intercom");
		assert.equal(intercomEvents.length, 1);
		const payload = intercomEvents[0]!.payload as { status?: string; summary?: string; message?: string };
		assert.equal(payload.status, "failed");
		assert.match(String(payload.summary ?? ""), /1 completed, 1 failed/);
		assert.match(String(payload.message ?? ""), /Status: failed/);
		assert.match(result.content[0]?.text ?? "", /Children: 1 completed, 1 failed/);
	});
});
