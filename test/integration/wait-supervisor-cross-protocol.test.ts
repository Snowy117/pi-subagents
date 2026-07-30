import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createNativeSupervisorChannel, ensureSupervisorChannelDir, resolveSupervisorChannelDir } from "../../src/intercom/native-supervisor-channel.ts";
import { waitForSubagents, type WaitEventBus } from "../../src/runs/background/wait.ts";
import type { IntercomEventBus, SubagentState } from "../../src/shared/types.ts";

class SharedEventBus implements WaitEventBus, IntercomEventBus {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(channel) ?? new Set();
		handlers.add(handler);
		this.handlers.set(channel, handlers);
		return () => handlers.delete(handler);
	}

	emit(channel: string, data: unknown): boolean {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
		return true;
	}
}

function makeState(sessionId: string, ctx: unknown): SubagentState {
	return {
		baseCwd: process.cwd(), currentSessionId: sessionId, asyncJobs: new Map(), foregroundControls: new Map(),
		lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: ctx as SubagentState["lastUiContext"],
		poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}

function writeRunningStatus(root: string, runId: string, sessionId: string): void {
	const dir = path.join(root, "runs", runId);
	fs.mkdirSync(dir, { recursive: true });
	const now = Date.now();
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
		runId, mode: "single", state: "running", sessionId, pid: 999999,
		startedAt: now, lastUpdate: now, steps: [{ agent: "worker", status: "running" }],
	}));
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((entry) => entry.text ?? "").join("");
}

describe("cross-protocol supervisor request during wait", () => {
	for (const replyTransport of [undefined, "pi-intercom"] as const) it(`returns a ${replyTransport ?? "native"} request through the supervisor event path before the long poll fallback`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-supervisor-live-"));
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const requestId = randomUUID();
		const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
		ensureSupervisorChannelDir(channelDir);
		writeRunningStatus(root, runId, sessionId);
		const events = new SharedEventBus();
		const ctx = { hasUI: false, sessionManager: { getSessionId: () => sessionId } };
		const state = makeState(sessionId, ctx);
		const sent: unknown[] = [];
		const pi = {
			getAllTools: () => [] as Array<{ name: string }>, registerTool: () => {},
			sendMessage: (message: unknown) => { sent.push(message); }, events,
		};
		const channel = createNativeSupervisorChannel(pi as never, state);
		channel.start();
		try {
			const startedAt = Date.now();
			const waitPromise = waitForSubagents({}, undefined, {
				state, events, getActionableSupervisorRequests: channel.getActionableRequests,
				asyncDirRoot: path.join(root, "runs"), resultsDir: path.join(root, "results"),
				kill: () => true, pollIntervalMs: 60_000,
			});
			setTimeout(() => {
				const createdAt = Date.now();
				fs.writeFileSync(path.join(channelDir, "requests", `${requestId}.json`), JSON.stringify({
					type: "subagent.supervisor.request", id: requestId, createdAt, expiresAt: createdAt + 60_000,
					reason: "need_decision", message: "Choose the API", expectsReply: true,
					orchestratorSessionId: sessionId, runId, agent: "worker", childIndex: 0,
					...(replyTransport ? { replyTransport } : {}),
				}));
			}, 25);
			const result = await waitPromise;
			assert.ok(Date.now() - startedAt < 5_000, "event discovery should beat the 60 second fallback");
			assert.match(textOf(result), new RegExp(`${requestId}.*${runId}.*${replyTransport ? "intercom" : "subagent_supervisor"}`, "s"));
			assert.equal(sent.length, replyTransport ? 0 : 1, "exactly the authoritative transport should be visible");
		} finally {
			channel.dispose();
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(channelDir, { recursive: true, force: true });
		}
	});
});
