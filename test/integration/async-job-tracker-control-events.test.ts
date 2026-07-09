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

describe("async job tracker control event scanning and bridging", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("scans async control events in bounded chunks", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		const originalAlloc = Buffer.alloc;
		const allocationSizes: number[] = [];
		try {
			const runDir = path.join(asyncRoot, "run-chunked-control");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-chunked-control",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const largeDiagnostic = JSON.stringify({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(200_000) }] },
			});
			const controlEvent = JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-chunked-control",
					agent: "worker",
					message: "worker needs attention",
				},
			});
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${largeDiagnostic}\n${controlEvent}\n`, "utf-8");

			Buffer.alloc = ((size: number, fill?: string | Buffer | number, encoding?: BufferEncoding) => {
				allocationSizes.push(size);
				return originalAlloc(size, fill as never, encoding);
			}) as typeof Buffer.alloc;

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-chunked-control", asyncDir: runDir, agent: "worker" });

			await waitForCondition(
				() => recorder.events.some((event) => event.channel === "subagent:control-event"),
				"chunked control event",
			);
			assert.ok(allocationSizes.length > 0, "expected the tracker to allocate read buffers");
			assert.equal(Math.max(...allocationSizes) <= 64 * 1024, true);
		} finally {
			Buffer.alloc = originalAlloc;
			removeTempDir(asyncRoot);
		}
	});

	it("does not tail-skip control events for newly tracked large logs", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-new-large-control");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-new-large-control",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const controlEvent = JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-new-large-control",
					agent: "worker",
					message: "worker needs attention",
				},
			});
			const diagnosticLine = JSON.stringify({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] },
			}) + "\n";
			const eventsPath = path.join(runDir, "events.jsonl");
			fs.writeFileSync(eventsPath, controlEvent + "\n" + diagnosticLine.repeat(900), "utf-8");
			assert.ok(fs.statSync(eventsPath).size > 2 * 1024 * 1024, "test fixture should exceed the legacy scan window");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-new-large-control", asyncDir: runDir, agent: "worker" });

			await waitForCondition(
				() => recorder.events.some((event) => event.channel === "subagent:control-event"),
				"new large log control event",
			);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("starts large legacy control-event scans from a bounded tail window", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		const originalAlloc = Buffer.alloc;
		const originalError = console.error;
		const allocationSizes: number[] = [];
		console.error = () => {};
		try {
			const runDir = path.join(asyncRoot, "run-large-legacy-control");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-large-legacy-control",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const diagnosticLine = JSON.stringify({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] },
			}) + "\n";
			const controlEvent = JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-large-legacy-control",
					agent: "worker",
					message: "worker needs attention",
				},
			});
			const eventsPath = path.join(runDir, "events.jsonl");
			fs.writeFileSync(eventsPath, diagnosticLine.repeat(900) + controlEvent + "\n", "utf-8");
			const eventLogBytes = fs.statSync(eventsPath).size;
			assert.ok(eventLogBytes > 2 * 1024 * 1024, "test fixture should exceed the scan window");

			Buffer.alloc = ((size: number, fill?: string | Buffer | number, encoding?: BufferEncoding) => {
				allocationSizes.push(size);
				return originalAlloc(size, fill as never, encoding);
			}) as typeof Buffer.alloc;

			const state = createState();
			state.asyncJobs.set("run-large-legacy-control", {
				asyncId: "run-large-legacy-control",
				asyncDir: runDir,
				status: "running",
				agents: ["worker"],
				startedAt: Date.now() - 1000,
				updatedAt: Date.now(),
			});
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.ensurePoller();

			await waitForCondition(
				() => recorder.events.some((event) => event.channel === "subagent:control-event"),
				"tail-window control event",
			);
			assert.ok(allocationSizes.length > 0, "expected the tracker to allocate read buffers");
			assert.equal(Math.max(...allocationSizes) <= 64 * 1024, true);
			const totalAllocated = allocationSizes.reduce((sum, size) => sum + size, 0);
			assert.ok(totalAllocated < eventLogBytes, "scan should not read the full legacy event log");
			assert.ok(totalAllocated <= 2 * 1024 * 1024 + 64 * 1024, "scan should stay within the bounded tail window");
		} finally {
			Buffer.alloc = originalAlloc;
			console.error = originalError;
			removeTempDir(asyncRoot);
		}
	});

	it("clears transient current tool fields when status clears them", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-clear-tool");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-clear-tool",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				currentTool: "edit",
				currentToolStartedAt: Date.now() - 100,
				currentPath: "src/runs/background/subagent-runner.ts",
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-clear-tool", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			let job = state.asyncJobs.get("run-clear-tool");
			assert.equal(job?.currentTool, "edit");
			assert.equal(job?.currentPath, "src/runs/background/subagent-runner.ts");

			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-clear-tool",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			await new Promise((resolve) => setTimeout(resolve, 30));
			job = state.asyncJobs.get("run-clear-tool");
			assert.equal(job?.currentTool, undefined);
			assert.equal(job?.currentToolStartedAt, undefined);
			assert.equal(job?.currentPath, undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("honors async control notification channels", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-channels");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-channels",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["intercom"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-channels",
					agent: "worker",
					message: "worker needs attention",
				},
				intercom: { to: "main", message: "SUBAGENT NEEDS ATTENTION: worker in run run-channels." },
			})}\n`, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-channels", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), false);
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-intercom"), true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("does not bridge active-long-running records to intercom", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-active-intercom");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-active-intercom",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event", "intercom"],
				event: {
					type: "active_long_running",
					to: "active_long_running",
					ts: 123,
					runId: "run-active-intercom",
					agent: "worker",
					message: "worker is still active but long-running",
				},
				intercom: { to: "main", message: "stale active notice" },
			})}\n`, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-active-intercom", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), true);
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-intercom"), false);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("bridges async control events from events.jsonl to the parent event bus", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-3");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-3",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event", "intercom"],
				childIntercomTarget: "subagent-worker-run-3-1",
				noticeText: "Subagent needs attention: worker\nNudge: intercom({ action: \"send\", to: \"subagent-worker-run-3-1\", message: \"<message>\" })",
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-3",
					agent: "worker",
					message: "worker needs attention",
				},
				intercom: { to: "main", message: "SUBAGENT NEEDS ATTENTION: worker in run run-3." },
			})}\n`, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-3", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 40));

			const controlEvent = recorder.events.find((event) => event.channel === "subagent:control-event");
			assert.ok(controlEvent);
			assert.match((controlEvent.data as { noticeText?: string }).noticeText ?? "", /subagent-worker-run-3-1/);
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-intercom"), true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});
});
