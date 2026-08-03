import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { waitForLaunchedRunAttention } from "../../src/runs/foreground/executor/async-path.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function state(sessionId: string): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: sessionId,
		subagentInProgress: false,
		subagentSpawns: { sessionId, count: 0 },
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
		resultFileCoalescer: { schedule: () => false, clear() {} },
	};
}

describe("sync detached-runner wait registration", () => {
	it("does not treat the runner's pre-status startup window as a terminal result", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-startup-wait-"));
		const asyncRoot = path.join(root, "runs");
		const resultsDir = path.join(root, "results");
		const runId = "startup-race";
		const sessionId = "session-startup";
		fs.mkdirSync(asyncRoot, { recursive: true });
		fs.mkdirSync(resultsDir, { recursive: true });
		let sleeps = 0;
		try {
			const result = await waitForLaunchedRunAttention(runId, new AbortController().signal, {
				state: state(sessionId),
				asyncDirRoot: asyncRoot,
				resultsDir,
				pollIntervalMs: 250,
				sleep: async () => {
					sleeps++;
					const runDir = path.join(asyncRoot, runId);
					fs.mkdirSync(runDir, { recursive: true });
					fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
						id: runId,
						sessionId,
						state: "running",
						mode: "single",
						cwd: root,
						startedAt: 1,
						lastUpdate: 1,
						steps: [],
					}));
				},
				getActionableSupervisorRequests: () => [{
					id: "request-startup",
					runId,
					agent: "delegate",
					childIndex: 0,
					reason: "need_decision",
					replyTransport: "native",
				} as never],
			});

			assert.equal(sleeps, 1);
			assert.match(result?.content[0]?.text ?? "", /attention required/);
			assert.doesNotMatch(result?.content[0]?.text ?? "", /No active run matched/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
