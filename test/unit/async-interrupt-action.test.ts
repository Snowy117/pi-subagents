import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { consumeSteerRequests } from "../../src/runs/background/control-channel.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { steerForegroundRun } from "../../src/runs/foreground/executor/interrupt-steer.ts";
import { ASYNC_DIR, RESULTS_DIR, type SubagentState } from "../../src/shared/types.ts";

function createState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundLiveChildren: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function writeJson(filePath: string, value: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function createRunningAsync(state: SubagentState, runId: string, options: { track?: boolean } = {}): string {
	const asyncDir = path.join(ASYNC_DIR, runId);
	writeJson(path.join(asyncDir, "status.json"), {
		runId,
		mode: "single",
		state: "running",
		pid: 12345,
		cwd: os.tmpdir(),
		startedAt: 100,
		lastUpdate: Date.now(),
		steps: [{ agent: "worker", status: "running", startedAt: 100 }],
	});
	if (options.track !== false) {
		state.asyncJobs.set(runId, {
			asyncId: runId,
			asyncDir,
			status: "running",
			pid: 12345,
			agents: ["worker"],
			updatedAt: 100,
		});
	}
	return asyncDir;
}

function cleanup(runId: string, asyncDir: string): void {
	fs.rmSync(asyncDir, { recursive: true, force: true });
	fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
}

function executorWithKill(state: SubagentState, kill: (pid: number, signal?: NodeJS.Signals | 0) => boolean) {
	return createSubagentExecutor({
		pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as any,
		state,
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
		asyncByDefault: false,
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: (parentSessionFile) => parentSessionFile ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl")) : os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [] }),
		kill,
	});
}

function ctx() {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return null; } },
		modelRegistry: { getAvailable() { return []; } },
	} as any;
}

function text(result: Awaited<ReturnType<ReturnType<typeof executorWithKill>["execute"]>>): string {
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

describe("async interrupt action", () => {
	it("reports no live foreground child when a legacy state has no live registry", () => {
		const state = createState() as SubagentState & { foregroundLiveChildren?: SubagentState["foregroundLiveChildren"] };
		delete state.foregroundLiveChildren;
		state.foregroundControls.set("legacy-run", { runId: "legacy-run", mode: "single", startedAt: 1, updatedAt: 1 });
		const result = steerForegroundRun({ state, runId: "legacy-run", message: "continue" });
		assert.equal(result.isError, true);
		assert.match(text(result), /no live child/i);
	});

	it("writes steering directly to the selected live foreground child", async () => {
		const state = createState();
		const runId = `foreground-steer-${Date.now().toString(36)}`;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "foreground-steer-"));
		const controlRoot = path.join(root, "control");
		const inbox = path.join(controlRoot, "steer-targets", "1");
		state.foregroundControls.set(runId, { runId, mode: "parallel", startedAt: 1, updatedAt: 1 });
		state.foregroundLiveChildren.set(`${runId}:0`, { runId, index: 0, agent: "worker-a", status: "running", controlRoot, steerInboxDir: path.join(controlRoot, "steer-targets", "0"), actionControlDir: path.join(controlRoot, "action-targets", "0"), updatedAt: 1 });
		state.foregroundLiveChildren.set(`${runId}:1`, { runId, index: 1, agent: "worker-b", status: "running", controlRoot, steerInboxDir: inbox, actionControlDir: path.join(controlRoot, "action-targets", "1"), updatedAt: 1 });
		try {
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: runId, index: 1, message: "Focus on validation." }, new AbortController().signal, undefined, ctx());
			assert.equal(result.isError, undefined);
			assert.match(text(result), /foreground run .* child 1/i);
			const files = fs.readdirSync(inbox);
			assert.equal(files.length, 1);
			assert.equal(JSON.parse(fs.readFileSync(path.join(inbox, files[0]!), "utf-8")).message, "Focus on validation.");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("steers a detached foreground child from the live registry after its foreground control is gone", async () => {
		const state = createState();
		const runId = `foreground-detached-steer-${Date.now().toString(36)}`;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "foreground-detached-steer-"));
		const controlRoot = path.join(root, "control");
		const inbox = path.join(controlRoot, "steer-targets", "0");
		state.foregroundRuns?.set(runId, { runId, mode: "single", cwd: root, updatedAt: 1, children: [] });
		state.foregroundLiveChildren.set(`${runId}:0`, { runId, index: 0, agent: "worker", status: "running", controlRoot, steerInboxDir: inbox, actionControlDir: path.join(controlRoot, "action-targets", "0"), updatedAt: 1 });
		try {
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: runId, message: "Continue after the reply." }, new AbortController().signal, undefined, ctx());
			assert.equal(result.isError, undefined);
			const files = fs.readdirSync(inbox);
			assert.equal(files.length, 1);
			assert.equal(JSON.parse(fs.readFileSync(path.join(inbox, files[0]!), "utf-8")).message, "Continue after the reply.");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("queues steering for a running async child", async () => {
		const state = createState();
		const runId = `steer-disk-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false });
		try {
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: runId, message: "Focus on tests." }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			assert.match(text(result), new RegExp(`Steering queued for async run ${runId}`));
			const requests = consumeSteerRequests(asyncDir);
			assert.equal(requests.length, 1);
			assert.equal(requests[0]?.message, "Focus on tests.");
			assert.equal(requests[0]?.source, "steer-action");
			assert.equal(requests[0]?.targetIndex, undefined);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("queues steering for a pending indexed async child", async () => {
		const state = createState();
		const runId = `steer-pending-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeJson(path.join(asyncDir, "status.json"), {
			runId,
			mode: "chain",
			state: "running",
			pid: 12345,
			cwd: os.tmpdir(),
			startedAt: 100,
			lastUpdate: Date.now(),
			steps: [
				{ agent: "done", status: "complete", startedAt: 100 },
				{ agent: "later", status: "pending" },
			],
		});
		try {
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: runId, index: 1, message: "Use the new API." }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			const requests = consumeSteerRequests(asyncDir);
			assert.equal(requests.length, 1);
			assert.equal(requests[0]?.message, "Use the new API.");
			assert.equal(requests[0]?.targetIndex, 1);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("interrupts a running async run resolved from disk after in-memory tracking is gone", async () => {
		const state = createState();
		const runId = `interrupt-disk-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false });
		try {
			const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
			const result = await executorWithKill(state, (pid, signal) => {
				kills.push({ pid, signal });
				return true;
			}).execute("interrupt", { action: "interrupt", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			assert.match(text(result), new RegExp(`Interrupt requested for async run ${runId}`));
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), true);
			assert.deepEqual(kills, [{ pid: 12345, signal: 0 }, { pid: 12345, signal: process.platform === "win32" ? "SIGBREAK" : "SIGUSR2" }]);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("reports success and writes the portable request when the signal is unavailable", async () => {
		const state = createState();
		const runId = `interrupt-enosys-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId);
		try {
			const result = await executorWithKill(state, (_pid, signal) => {
				if (signal === 0) return true;
				const error = new Error("kill ENOSYS") as NodeJS.ErrnoException;
				error.code = "ENOSYS";
				throw error;
			}).execute("interrupt", { action: "interrupt", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			assert.match(text(result), new RegExp(`Interrupt requested for async run ${runId}`));
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), true);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("does not report success for stale running status with a dead pid", async () => {
		const state = createState();
		const runId = `interrupt-esrch-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId);
		try {
			const result = await executorWithKill(state, () => {
				const error = new Error("missing process") as NodeJS.ErrnoException;
				error.code = "ESRCH";
				throw error;
			}).execute("interrupt", { action: "interrupt", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, true);
			assert.match(text(result), /No running async run with an interrupt-capable pid/);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), false);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(status.state, "failed");
		} finally {
			cleanup(runId, asyncDir);
		}
	});
});
