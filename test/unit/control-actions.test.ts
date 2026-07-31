import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseControlActionRequest, parseControlActionResponse } from "../../src/runs/shared/control-actions/actions.ts";
import {
	claimControlActionRequests,
	cleanupControlActionFiles,
	consumeControlActionResponses,
	consumeControlActionResponse,
	requestControlAction,
	requestRunChildControlAction,
	writeControlActionRequest,
	writeControlActionResponse,
} from "../../src/runs/shared/control-actions/channel.ts";
import { actionRequestsDir, actionResponsesDir, actionTargetDir } from "../../src/runs/shared/control-actions/paths.ts";

import {
	cleanupForegroundLiveChildren,
	registerForegroundLiveChild,
	removeForegroundLiveChild,
} from "../../src/runs/foreground/foreground-live-registry.ts";
import type { ForegroundLiveChild } from "../../src/shared/types.ts";

function temporaryTarget(): { root: string; target: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-actions-"));
	return { root, target: actionTargetDir(path.join(root, "control"), 2) };
}

describe("control action protocol", () => {
	it("keeps parallel live children indexed and removes the root after the last child exits", () => {
		const registry = new Map<string, ForegroundLiveChild>();
		const removed: string[] = [];
		const fakeFs = { rmSync: (filePath: string) => removed.push(filePath) };
		const child = (index: number): ForegroundLiveChild => ({
			runId: "parallel-run", index, agent: `agent-${index}`, status: "running",
			controlRoot: "/tmp/control", steerInboxDir: "/tmp/steer", actionControlDir: "/tmp/action", updatedAt: 1,
		});
		registerForegroundLiveChild(registry, child(0));
		registerForegroundLiveChild(registry, child(1));
		assert.equal(registry.size, 2);
		removeForegroundLiveChild(registry, "parallel-run", 0, "completed", fakeFs, () => 2);
		assert.equal(registry.size, 1);
		assert.equal(removed.length, 0);
		removeForegroundLiveChild(registry, "parallel-run", 1, "failed", fakeFs, () => 3);
		assert.equal(registry.size, 0);
		assert.equal(removed.length, 1);
	});

	it("cleans every live run root during session cleanup", () => {
		const registry = new Map<string, ForegroundLiveChild>();
		const removed: string[] = [];
		registerForegroundLiveChild(registry, { runId: "run-a", index: 0, agent: "a", status: "running", controlRoot: "", steerInboxDir: "", actionControlDir: "", updatedAt: 1 });
		registerForegroundLiveChild(registry, { runId: "run-b", index: 0, agent: "b", status: "running", controlRoot: "", steerInboxDir: "", actionControlDir: "", updatedAt: 1 });
		cleanupForegroundLiveChildren(registry, { rmSync: (filePath: string) => removed.push(filePath) });
		assert.equal(registry.size, 0);
		assert.equal(removed.length, 2);
	});

	it("strictly parses versioned request and response envelopes", () => {
		assert.deepEqual(parseControlActionRequest({ version: 1, type: "action", id: " req ", ts: 10, action: " cycleThinking ", source: " tui " }), {
			version: 1, type: "action", id: "req", ts: 10, action: "cycleThinking", source: "tui",
		});
		assert.equal(parseControlActionRequest({ version: 2, type: "action", id: "req", ts: 10, action: "cycleThinking" }), undefined);
		assert.equal(parseControlActionRequest({ version: 1, type: "action", id: "req", ts: 10, action: "cycleThinking", extra: true }), undefined);
		assert.deepEqual(parseControlActionResponse({ version: 1, type: "action_response", requestId: "req", ts: 11, status: "rejected", action: "bad", error: "unknown" }), {
			version: 1, type: "action_response", requestId: "req", ts: 11, status: "rejected", action: "bad", error: "unknown",
		});
		assert.equal(parseControlActionResponse({ version: 1, type: "action_response", requestId: "req", ts: 11, status: "applied", action: "bad", error: "no" }), undefined);
	});

	it("writes atomically, claims once, and dedupes requests with an existing response", () => {
		const { root, target } = temporaryTarget();
		try {
			const request = requestControlAction(target, "cycleThinking", { source: "test" }, { id: () => "one", now: () => 100, random: () => 0.2, pid: 7 });
			assert.equal(fs.readdirSync(actionRequestsDir(target)).some((name) => name.endsWith(".tmp")), false);
			assert.deepEqual(claimControlActionRequests(target), [request]);
			assert.deepEqual(claimControlActionRequests(target), []);

			writeControlActionRequest(target, { ...request, ts: 101 });
			writeControlActionResponse(target, { version: 1, type: "action_response", requestId: request.id, ts: 102, status: "applied", action: request.action, result: { thinkingLevel: "high" } });
			assert.deepEqual(claimControlActionRequests(target), []);
			assert.equal(fs.readdirSync(actionRequestsDir(target)).length, 0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps async queued requests in the child inbox until the child claims them", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-actions-async-"));
		try {
			const request = requestRunChildControlAction(root, 3, "cycleThinking", {}, { id: () => "queued", now: () => 200 });
			const target = actionTargetDir(path.join(root, "control"), 3);
			assert.equal(fs.readdirSync(actionRequestsDir(target)).length, 1);
			assert.deepEqual(claimControlActionRequests(target), [request]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("consumes valid responses, discards damaged files, and removes expired files", () => {
		const { root, target } = temporaryTarget();
		try {
			writeControlActionResponse(target, { version: 1, type: "action_response", requestId: "ok", ts: 20, status: "rejected", action: "unknown", error: "unsupported" });
			fs.writeFileSync(path.join(actionResponsesDir(target), "broken.json"), "{");
			assert.deepEqual(consumeControlActionResponses(target), [{ version: 1, type: "action_response", requestId: "ok", ts: 20, status: "rejected", action: "unknown", error: "unsupported" }]);

			requestControlAction(target, "cycleThinking", {}, { id: () => "old", now: () => 1 });
			const oldPath = path.join(actionRequestsDir(target), fs.readdirSync(actionRequestsDir(target))[0]!);
			fs.utimesSync(oldPath, new Date(0), new Date(0));
			assert.equal(cleanupControlActionFiles(target, { ttlMs: 100 }, { now: () => 1000 }), 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("claims responses before reading so concurrent consumers cannot both return them", () => {
		const { root, target } = temporaryTarget();
		try {
			writeControlActionResponse(target, { version: 1, type: "action_response", requestId: "once", ts: 20, status: "applied", action: "cycleThinking", result: { thinkingLevel: "high" } });
			const responseDir = actionResponsesDir(target);
			let nested: ReturnType<typeof consumeControlActionResponses> = [];
			let triggered = false;
			const fsImpl = {
				...fs,
				renameSync(sourcePath: fs.PathLike, destinationPath: fs.PathLike) {
					fs.renameSync(sourcePath, destinationPath);
					if (!triggered && path.dirname(String(sourcePath)) === responseDir) {
						triggered = true;
						nested = consumeControlActionResponses(target, { pid: 902 });
					}
				},
			};
			const responses = consumeControlActionResponses(target, { fs: fsImpl, pid: 901 });
			assert.equal(responses.length, 1);
			assert.deepEqual(nested, []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("consumes only the requested response without deleting sibling responses", () => {
		const { root, target } = temporaryTarget();
		try {
			writeControlActionResponse(target, { version: 1, type: "action_response", requestId: "first", ts: 1, status: "applied", action: "cycleThinking", result: { thinkingLevel: "low" } });
			writeControlActionResponse(target, { version: 1, type: "action_response", requestId: "second", ts: 2, status: "rejected", action: "cycleThinking", error: "unsupported" });
			assert.equal(consumeControlActionResponse(target, "first")?.requestId, "first");
			assert.deepEqual(consumeControlActionResponses(target).map((response) => response.requestId), ["second"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
