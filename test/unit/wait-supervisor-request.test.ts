import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { waitForSubagents, type WaitDeps, type WaitEventBus } from "../../src/runs/background/wait.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, type SubagentState } from "../../src/shared/types.ts";
import type { SupervisorAttentionRequest } from "../../src/intercom/native-supervisor-channel/types.ts";

class FakeEventBus implements WaitEventBus {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(channel) ?? new Set();
		handlers.add(handler);
		this.handlers.set(channel, handlers);
		return () => handlers.delete(handler);
	}

	emit(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
	}
}

function makeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: "session-1",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}

function writeRunningStatus(root: string, runId: string): void {
	const dir = path.join(root, "runs", runId);
	fs.mkdirSync(dir, { recursive: true });
	const now = Date.now();
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
		runId,
		mode: "single",
		state: "running",
		sessionId: "session-1",
		pid: 999999,
		startedAt: now,
		lastUpdate: now,
		steps: [{ agent: "worker", status: "running" }],
	}));
}

function request(id = "request-1", runId = "run-a", replyTransport?: "pi-intercom"): SupervisorAttentionRequest {
	return { id, runId, agent: "worker", childIndex: 0, reason: "need_decision", ...(replyTransport ? { replyTransport } : {}) };
}

function deps(root: string, overrides: Partial<WaitDeps>): WaitDeps {
	return {
		state: makeState(),
		asyncDirRoot: path.join(root, "runs"),
		resultsDir: path.join(root, "results"),
		kill: () => true,
		pollIntervalMs: 60_000,
		...overrides,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((entry) => entry.text ?? "").join("");
}

describe("wait supervisor attention", () => {
	it("returns immediately for a pre-existing blocking request", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-supervisor-existing-"));
		try {
			writeRunningStatus(root, "run-a");
			let sleeps = 0;
			const result = await waitForSubagents({}, undefined, deps(root, {
				getActionableSupervisorRequests: () => [request()],
				sleep: async () => { sleeps++; },
			}));
			assert.equal(sleeps, 0);
			assert.match(textOf(result), /request-1.*run-a.*subagent_supervisor/s);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes promptly when a request arrives after event subscription", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-supervisor-event-"));
		try {
			writeRunningStatus(root, "run-a");
			const events = new FakeEventBus();
			let current: ReadonlyArray<SupervisorAttentionRequest> = [];
			const sleep = (_ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
				queueMicrotask(() => {
					current = [request("broker-request", "run-a", "pi-intercom")];
					events.emit(INTERCOM_DETACH_REQUEST_EVENT, {});
				});
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			const result = await waitForSubagents({}, undefined, deps(root, {
				events,
				sleep,
				getActionableSupervisorRequests: () => current,
			}));
			assert.match(textOf(result), /broker-request.*intercom\(\{ action: "reply"/s);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reconciles a request created at the initial check and subscription boundary", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-supervisor-boundary-"));
		try {
			writeRunningStatus(root, "run-a");
			let queries = 0;
			let slept = false;
			const result = await waitForSubagents({}, undefined, deps(root, {
				events: new FakeEventBus(),
				getActionableSupervisorRequests: () => ++queries === 1 ? [] : [request("boundary-request")],
				sleep: async () => { slept = true; },
			}));
			assert.equal(slept, false);
			assert.match(textOf(result), /boundary-request/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("filters requests to the exact initial run snapshot", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-supervisor-scope-"));
		try {
			writeRunningStatus(root, "run-a");
			let wakes = 0;
			const result = await waitForSubagents({}, undefined, deps(root, {
				getActionableSupervisorRequests: () => [request("unrelated", "run-b")],
				sleep: async () => {
					wakes++;
					const status = JSON.parse(fs.readFileSync(path.join(root, "runs/run-a/status.json"), "utf-8")) as Record<string, unknown>;
					fs.writeFileSync(path.join(root, "runs/run-a/status.json"), JSON.stringify({ ...status, state: "complete", steps: [{ agent: "worker", status: "complete" }] }));
				},
			}));
			assert.equal(wakes, 1);
			assert.doesNotMatch(textOf(result), /unrelated/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not let a later-launched run satisfy the wait", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-supervisor-later-run-"));
		try {
			writeRunningStatus(root, "run-a");
			let current: ReadonlyArray<SupervisorAttentionRequest> = [];
			let sleeps = 0;
			const result = await waitForSubagents({}, undefined, deps(root, {
				getActionableSupervisorRequests: () => current,
				sleep: async () => {
					sleeps++;
					if (sleeps === 1) {
						writeRunningStatus(root, "run-later");
						current = [request("later-request", "run-later")];
					} else {
						const statusPath = path.join(root, "runs/run-a/status.json");
						const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
						fs.writeFileSync(statusPath, JSON.stringify({ ...status, state: "complete", steps: [{ agent: "worker", status: "complete" }] }));
					}
				},
			}));
			assert.equal(sleeps, 2);
			assert.doesNotMatch(textOf(result), /later-request/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores progress updates and requests removed before reconciliation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-supervisor-resolved-"));
		try {
			writeRunningStatus(root, "run-a");
			const events = new FakeEventBus();
			let current: ReadonlyArray<SupervisorAttentionRequest> = [{ ...request("progress"), reason: "progress_update" }];
			let sleeps = 0;
			const sleep = (_ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
				sleeps++;
				queueMicrotask(() => {
					current = [request("transient")];
					events.emit(INTERCOM_DETACH_REQUEST_EVENT, {});
					current = [];
					if (sleeps === 2) {
						const statusPath = path.join(root, "runs/run-a/status.json");
						const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
						fs.writeFileSync(statusPath, JSON.stringify({ ...status, state: "complete", steps: [{ agent: "worker", status: "complete" }] }));
					}
				});
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			const result = await waitForSubagents({}, undefined, deps(root, {
				events,
				sleep,
				getActionableSupervisorRequests: () => current,
			}));
			assert.ok(sleeps >= 2, "a resolved request must not terminate wait");
			assert.doesNotMatch(textOf(result), /transient/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("remains level-triggered across repeated waits until resolution", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-supervisor-level-"));
		try {
			writeRunningStatus(root, "run-a");
			let current: ReadonlyArray<SupervisorAttentionRequest> = [request("level-request")];
			const waitDeps = deps(root, { getActionableSupervisorRequests: () => current });
			const first = await waitForSubagents({}, undefined, waitDeps);
			const second = await waitForSubagents({}, undefined, waitDeps);
			assert.match(textOf(first), /level-request/);
			assert.match(textOf(second), /level-request/);
			current = [];
			const statusPath = path.join(root, "runs/run-a/status.json");
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
			fs.writeFileSync(statusPath, JSON.stringify({ ...status, state: "complete", steps: [{ agent: "worker", status: "complete" }] }));
			const afterResolution = await waitForSubagents({}, undefined, waitDeps);
			assert.match(textOf(afterResolution), /Nothing to wait for/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
