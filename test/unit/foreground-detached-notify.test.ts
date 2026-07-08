import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notifyForegroundDetachedCompletion } from "../../src/runs/foreground/subagent-executor.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type SingleResult, type SubagentState } from "../../src/shared/types.ts";

function makeEventBus() {
	const handlers = new Map<string, Array<(d: unknown) => void>>();
	return {
		on(channel: string, handler: (d: unknown) => void) {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
			return () => {
				const l = handlers.get(channel) ?? [];
				handlers.set(channel, l.filter((h) => h !== handler));
			};
		},
		emit(channel: string, data: unknown) {
			for (const h of handlers.get(channel) ?? []) h(data);
		},
	};
}

function makeState(sessionId: string | null): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		completionSeen: new Map(),
		poller: null,
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		task: "do something",
		exitCode: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		finalOutput: "all done",
		progressSummary: { toolCount: 1, tokens: 10, durationMs: 100 },
		...overrides,
	};
}

describe("notifyForegroundDetachedCompletion", () => {
	it("emits the async-complete event tagged with the parent session id", () => {
		const events = makeEventBus();
		const state = makeState("parent-session");
		const seen: unknown[] = [];
		events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => seen.push(data));

		notifyForegroundDetachedCompletion({
			events: events as never,
			state,
			runId: "fg-run-1",
			mode: "single",
			index: 0,
			result: makeResult(),
		});

		assert.equal(seen.length, 1);
		const payload = seen[0] as { id: string; sessionId: string; success: boolean; agent: string; summary: string };
		assert.equal(payload.id, "fg-run-1");
		assert.equal(payload.sessionId, "parent-session");
		assert.equal(payload.success, true);
		assert.equal(payload.agent, "worker");
		assert.equal(payload.summary, "all done");
	});

	it("marks a failed run as unsuccessful", () => {
		const events = makeEventBus();
		const state = makeState("parent-session");
		const seen: unknown[] = [];
		events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => seen.push(data));

		notifyForegroundDetachedCompletion({
			events: events as never,
			state,
			runId: "fg-run-2",
			mode: "single",
			index: 0,
			result: makeResult({ exitCode: 1, error: "boom", finalOutput: undefined }),
		});

		assert.equal((seen[0] as { success: boolean }).success, false);
	});

	it("does not throw when intercom delivery is not acknowledged", async () => {
		const events = makeEventBus();
		const state = makeState("parent-session");

		assert.doesNotThrow(() => notifyForegroundDetachedCompletion({
			events: events as never,
			state,
			runId: "fg-run-3",
			mode: "single",
			index: 0,
			result: makeResult(),
			orchestratorIntercomTarget: "orchestrator",
		}));
		await new Promise((resolve) => setImmediate(resolve));
	});
});
