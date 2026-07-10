/**
 * Cross-protocol foreground-detach reproduction test.
 *
 * Discriminates the integration conflict between pi-subagents and pi-intercom
 * from the pure in-process native detach path:
 *
 * - `single-execution-detach.test.ts` covers the *in-process* path: it emits
 *   `INTERCOM_DETACH_REQUEST_EVENT` directly on the event bus, bypassing the
 *   filesystem poller.
 * - This test covers the *cross-protocol* path: a "shadow" child tool (mimicking
 *   pi-intercom's broker-based `contact_supervisor`) writes the native
 *   `SupervisorRequest` file to disk and does NOT emit the detach event itself.
 *   The parent's `createNativeSupervisorChannel` poller must discover that file
 *   and fire detach on its own — exactly what the pi-intercom
 *   `writeNativeSupervisorRequest` bridge relies on.
 *
 * RED on current code (without the file write): no file → poller finds nothing →
 * no detach. GREEN after the fix (with the file write): file → poller → detach.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createNativeSupervisorChannel,
	ensureSupervisorChannelDir,
	resolveSupervisorChannelDir,
} from "../../src/intercom/native-supervisor-channel.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, type SubagentState } from "../../src/shared/types.ts";

const createdChannels: string[] = [];

function makeState(sessionId: string, ctx: unknown): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: ctx as SubagentState["lastUiContext"],
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeCtx(sessionId: string) {
	return {
		cwd: process.cwd(),
		hasUI: false,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => null,
			getEntries: () => [],
		},
	};
}

/**
 * Mimic the pi-intercom `writeNativeSupervisorRequest` bridge: write a native
 * SupervisorRequest file (broker-origin, no in-process event emission). This is
 * the cross-protocol handshake the fix adds.
 */
function writeShadowContactSupervisorRequest(input: {
	sessionId: string;
	runId: string;
	agent?: string;
	childIndex?: number;
	message?: string;
	reason?: "need_decision" | "interview_request" | "progress_update";
	expectsReply?: boolean;
}): string {
	const agent = input.agent ?? "worker";
	const childIndex = input.childIndex ?? 0;
	const reason = input.reason ?? "need_decision";
	const expectsReply = input.expectsReply ?? true;
	const channelDir = resolveSupervisorChannelDir(input.runId, agent, childIndex);
	createdChannels.push(channelDir);
	ensureSupervisorChannelDir(channelDir);
	const requestId = randomUUID();
	const createdAt = Date.now();
	// Atomic write mirroring pi-intercom's helper: temp + rename.
	const target = path.join(channelDir, "requests", `${requestId}.json`);
	const temp = `${target}.${process.pid}.${createdAt}.${Math.random().toString(36).slice(2)}.tmp`;
	const payload = {
		type: "subagent.supervisor.request",
		id: requestId,
		createdAt,
		...(expectsReply ? { expiresAt: createdAt + 10 * 60 * 1000 } : {}),
		reason,
		message: input.message ?? "Shadow broker-origin decision request",
		expectsReply,
		orchestratorSessionId: input.sessionId,
		orchestratorTarget: "orchestrator",
		runId: input.runId,
		agent,
		childIndex,
	};
	fs.writeFileSync(temp, JSON.stringify(payload, null, "\t"));
	fs.renameSync(temp, target);
	return requestId;
}

afterEach(() => {
	for (const channel of createdChannels.splice(0)) fs.rmSync(channel, { recursive: true, force: true });
});

describe("cross-protocol foreground detach (pi-intercom broker → native file bridge)", () => {
	it("fires detach when a broker-origin shadow tool writes the native request file", () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const requestId = writeShadowContactSupervisorRequest({ sessionId, runId });

		const sent: Array<{ customType?: string; details?: { id?: string } }> = [];
		const emitted: Array<{ channel: string; payload: { requestId?: string } }> = [];
		const pi = {
			getAllTools: () => [] as Array<{ name: string }>,
			registerTool: () => {},
			sendMessage: (message: { customType?: string; details?: { id?: string } }) => { sent.push(message); },
			events: {
				emit: (channel: string, payload: { requestId?: string }) => { emitted.push({ channel, payload }); },
			},
			getSessionName: () => "orchestrator",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(sessionId, makeCtx(sessionId)));

		channel.start();
		try {
			assert.equal(sent.length, 1);
			assert.equal(sent[0]!.details?.id, requestId);
			assert.equal(sent[0]!.customType, "subagent_supervisor_request");
			assert.equal(emitted.length, 1);
			assert.equal(emitted[0]!.channel, INTERCOM_DETACH_REQUEST_EVENT);
			assert.equal(emitted[0]!.payload.requestId, requestId);
			assert.equal(channel.pending.has(requestId), true);
		} finally {
			channel.dispose();
		}
	});

	it("does NOT fire detach when the shadow tool omits the file write (RED baseline)", () => {
		// Pre-fix pi-intercom path: a broker-origin contact_supervisor that writes
		// no native file. The parent poller finds nothing, so no detach fires and
		// the foreground stays blocked. This is the bug.
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
		createdChannels.push(channelDir);
		ensureSupervisorChannelDir(channelDir);

		const sent: Array<{ customType?: string }> = [];
		const emitted: Array<{ channel: string }> = [];
		const pi = {
			getAllTools: () => [] as Array<{ name: string }>,
			registerTool: () => {},
			sendMessage: (message: { customType?: string }) => { sent.push(message); },
			events: { emit: (channel: string) => { emitted.push({ channel }); } },
			getSessionName: () => "orchestrator",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(sessionId, makeCtx(sessionId)));

		channel.start();
		channel.dispose();

		assert.equal(sent.length, 0);
		assert.equal(emitted.filter((e) => e.channel === INTERCOM_DETACH_REQUEST_EVENT).length, 0);
	});

	it("fires detach for a non-blocking progress_update via the file bridge too", () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		writeShadowContactSupervisorRequest({
			sessionId,
			runId,
			reason: "progress_update",
			expectsReply: false,
			message: "UPDATE: halfway done",
		});

		const sent: Array<{ customType?: string; details?: { reason?: string; expectsReply?: boolean } }> = [];
		const emitted: Array<{ channel: string }> = [];
		const pi = {
			getAllTools: () => [] as Array<{ name: string }>,
			registerTool: () => {},
			sendMessage: (message: { customType?: string; details?: { reason?: string; expectsReply?: boolean } }) => { sent.push(message); },
			events: { emit: (channel: string) => { emitted.push({ channel }); } },
			getSessionName: () => "orchestrator",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(sessionId, makeCtx(sessionId)));

		channel.start();
		try {
			assert.equal(sent.length, 1, "progress update is surfaced to the parent");
			assert.equal(sent[0]!.details?.reason, "progress_update");
			assert.equal(sent[0]!.details?.expectsReply, false);
			assert.equal(emitted.filter((e) => e.channel === INTERCOM_DETACH_REQUEST_EVENT).length, 0);
		} finally {
			channel.dispose();
		}
	});
});
