import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { createNativeSupervisorChannel, ensureSupervisorChannelDir, resolveSupervisorChannelDir } from "../../src/intercom/native-supervisor-channel.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, type SubagentState } from "../../src/shared/types.ts";

const channels: string[] = [];

function state(sessionId: string, ctx: unknown): SubagentState {
	return {
		baseCwd: process.cwd(), currentSessionId: sessionId, asyncJobs: new Map(), foregroundControls: new Map(),
		lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: ctx as SubagentState["lastUiContext"],
		poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}

function writeReceipt(sessionId: string, runId: string): { id: string; file: string } {
	const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
	channels.push(channelDir);
	ensureSupervisorChannelDir(channelDir);
	const id = randomUUID();
	const file = path.join(channelDir, "requests", `${id}.json`);
	fs.writeFileSync(file, JSON.stringify({
		type: "subagent.supervisor.request", id, createdAt: Date.now(), reason: "need_decision", message: "broker owns this",
		expectsReply: true, orchestratorSessionId: sessionId, runId, agent: "worker", childIndex: 0,
		replyTransport: "pi-intercom",
	}));
	return { id, file };
}

afterEach(() => {
	for (const channel of channels.splice(0)) fs.rmSync(channel, { recursive: true, force: true });
});

describe("native supervisor channel pi-intercom receipts", () => {
	it("emits a wake without duplicate native delivery or native reply visibility", async () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const receipt = writeReceipt(sessionId, runId);
		const sent: unknown[] = [];
		const emitted: string[] = [];
		const tools = new Map<string, { execute: (_id: string, params: { action: string; replyTo?: string; message?: string }) => Promise<{ content: Array<{ text?: string }> }> }>();
		const ctx = { sessionManager: { getSessionId: () => sessionId } };
		const pi = {
			getAllTools: () => [...tools.keys()].map((name) => ({ name })),
			registerTool: (tool: never) => { const typed = tool as unknown as { name: string }; tools.set(typed.name, tool as never); },
			sendMessage: (message: unknown) => sent.push(message),
			events: { emit: (channel: string) => emitted.push(channel) },
		};
		const channel = createNativeSupervisorChannel(pi as never, state(sessionId, ctx));
		try {
			channel.start();
			assert.deepEqual(sent, []);
			assert.deepEqual(emitted, [INTERCOM_DETACH_REQUEST_EVENT]);
			assert.deepEqual(channel.getActionableRequests(), [{
				id: receipt.id, runId, agent: "worker", childIndex: 0, reason: "need_decision", replyTransport: "pi-intercom",
			}]);
			const pending = await tools.get("subagent_supervisor")!.execute("pending", { action: "pending" });
			assert.match(pending.content[0]!.text ?? "", /No pending/);
			const status = await tools.get("subagent_supervisor")!.execute("status", { action: "status" });
			assert.match(status.content[0]!.text ?? "", /Pending replies: 0/);
			await assert.rejects(() => tools.get("subagent_supervisor")!.execute("reply", { action: "reply", replyTo: receipt.id, message: "yes" }), /No pending native/);
		} finally {
			channel.dispose();
		}
	});

	it("returns immutable summaries and prunes a removed receipt on query", () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const receipt = writeReceipt(sessionId, runId);
		const ctx = { sessionManager: { getSessionId: () => sessionId } };
		const pi = { getAllTools: () => [], registerTool: () => {}, sendMessage: () => {}, events: { emit: () => {} } };
		const channel = createNativeSupervisorChannel(pi as never, state(sessionId, ctx));
		try {
			channel.start();
			const [summary] = channel.getActionableRequests();
			assert.equal(Object.isFrozen(summary), true);
			assert.equal(Object.isFrozen(channel.getActionableRequests()), true);
			fs.rmSync(receipt.file);
			assert.deepEqual(channel.getActionableRequests(), []);
		} finally {
			channel.dispose();
		}
	});
});
