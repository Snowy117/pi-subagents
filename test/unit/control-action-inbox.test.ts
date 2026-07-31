import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { applyControlAction, registerControlActionInbox } from "../../src/runs/shared/subagent-prompt-runtime/control-action-inbox.ts";
import type { ChildControlActionRequest } from "../../src/runs/shared/control-actions/actions.ts";
import { consumeControlActionResponses, requestControlAction } from "../../src/runs/shared/control-actions/channel.ts";
import { SUBAGENT_ACTION_CONTROL_DIR_ENV } from "../../src/runs/shared/pi-args.ts";

const request: ChildControlActionRequest = { version: 1, type: "action", id: "req", ts: 1, action: "cycleThinking" };
const reasoningModel = { provider: "test", id: "reasoner", name: "Reasoner", api: "test", baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as any;

describe("child control action inbox", () => {
	it("cycles using model-supported levels and reports the actual clamped level", () => {
		let level = "medium";
		const set: string[] = [];
		const response = applyControlAction({
			getThinkingLevel: () => level as any,
			setThinkingLevel: (next) => { set.push(next); level = "high"; },
		}, request, reasoningModel, () => 50);
		assert.deepEqual(set, ["high"]);
		assert.deepEqual(response, { version: 1, type: "action_response", requestId: "req", ts: 50, status: "applied", action: "cycleThinking", result: { thinkingLevel: "high" } });
	});

	it("includes off in the native model-supported cycle when valid", () => {
		let level = "high";
		const set: string[] = [];
		applyControlAction({ getThinkingLevel: () => level as any, setThinkingLevel: (next) => { set.push(next); level = next; } }, request, reasoningModel);
		assert.deepEqual(set, ["off"]);
	});

	it("rejects non-reasoning models, payloads, unknown actions, and API failures", () => {
		const pi = { getThinkingLevel: () => "medium" as const, setThinkingLevel: () => {} };
		assert.equal(applyControlAction(pi, request, { ...reasoningModel, reasoning: false }).status, "rejected");
		assert.equal(applyControlAction(pi, { ...request, payload: {} }, reasoningModel).status, "rejected");
		assert.equal(applyControlAction(pi, { ...request, action: "unknown" }, reasoningModel).status, "rejected");
		const failed = applyControlAction({ getThinkingLevel: () => { throw new Error("boom"); }, setThinkingLevel: () => {} }, request, reasoningModel);
		assert.equal(failed.status, "rejected");
		assert.match(failed.error ?? "", /boom/);
	});

	it("registers only with an action directory, dedupes replayed ids, and disposes its runtime resources", () => {
		const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-action-inbox-"));
		try {
			const handlers = new Map<string, (event: unknown, ctx: { model?: typeof reasoningModel }) => void>();
			let watchClosed = 0;
			let intervalCleared = 0;
			let intervalCallback: (() => void) | undefined;
			let level = "medium";
			let setCount = 0;
			const pi = {
				on(event: string, handler: (event: unknown, ctx: { model?: typeof reasoningModel }) => void) {
					handlers.set(event, handler);
				},
				getThinkingLevel: () => level as any,
				setThinkingLevel(next: string) {
					setCount++;
					level = next;
				},
			};
			registerControlActionInbox(pi as any, {
				env: { [SUBAGENT_ACTION_CONTROL_DIR_ENV]: targetDir },
				fs: {
					...fs,
					watch: (() => ({ close: () => { watchClosed++; }, on() {} })) as any,
				},
				setInterval: ((callback: () => void) => {
					intervalCallback = callback;
					return { unref() {} };
				}) as any,
				clearInterval: (() => { intervalCleared++; }) as any,
				now: () => 50,
				pid: 7,
				random: () => 0.25,
				wait: () => {},
			});
			const first = requestControlAction(targetDir, "cycleThinking", {}, { id: () => "same-id", now: () => 1 });
			handlers.get("session_start")?.({}, { model: reasoningModel });
			assert.equal(setCount, 1);
			assert.equal(consumeControlActionResponses(targetDir)[0]?.requestId, first.id);

			requestControlAction(targetDir, "cycleThinking", {}, { id: () => "same-id", now: () => 2 });
			intervalCallback?.();
			const replay = consumeControlActionResponses(targetDir);
			assert.equal(setCount, 1);
			assert.equal(replay[0]?.requestId, first.id);
			assert.deepEqual(replay[0]?.result, { thinkingLevel: "high" });

			handlers.get("session_shutdown")?.({}, {});
			assert.equal(watchClosed, 1);
			assert.equal(intervalCleared, 1);
		} finally {
			fs.rmSync(targetDir, { recursive: true, force: true });
		}
	});
});
