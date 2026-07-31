import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { SubagentState } from "../../src/shared/types.ts";
import { listSteerViewTargets } from "../../src/tui/steer-view/target-model.ts";

function state(): SubagentState {
	return {
		baseCwd: "/tmp", currentSessionId: "session", asyncJobs: new Map(), foregroundRuns: new Map(),
		foregroundLiveChildren: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
		cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null,
		watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

describe("steer view target model", () => {
	it("merges at child granularity and prefers active memory over disk duplicates", () => {
		const current = state();
		current.asyncJobs.set("run-a", {
			asyncId: "run-a", asyncDir: "/tmp/async/run-a", status: "running", updatedAt: 20,
			steps: [{ index: 0, agent: "memory-agent", status: "running", recentOutput: ["memory"] }],
		});
		const targets = listSteerViewTargets(current, { listRuns: () => [{
			id: "run-a", asyncDir: "/tmp/async/run-a", state: "running", mode: "single", startedAt: 1,
			cwd: "/tmp/project",
			steps: [{ index: 0, agent: "disk-agent", status: "running", recentOutput: ["disk"], transcriptPath: "/tmp/project/.pi-subagents/artifacts/run-a.jsonl" }, { index: 1, agent: "second", status: "pending" }],
		}] });
		assert.equal(targets.length, 2);
		assert.equal(targets.find((target) => target.index === 0)?.agent, "memory-agent");
		assert.equal(targets.find((target) => target.index === 0)?.transcriptPath, "/tmp/project/.pi-subagents/artifacts/run-a.jsonl");
		assert.equal(targets.find((target) => target.index === 1)?.agent, "second");
	});

	it("prefers foreground live children over remembered terminal fallback", () => {
		const current = state();
		current.foregroundRuns!.set("fg", { runId: "fg", mode: "single", cwd: "/tmp", updatedAt: 1, children: [{ index: 0, agent: "old", status: "completed", transcriptPath: "/old" }] });
		current.foregroundLiveChildren.set("fg:0", {
			runId: "fg", index: 0, agent: "live", status: "running", controlRoot: "/control",
			steerInboxDir: "/steer", actionControlDir: "/action", transcriptPath: "/live", updatedAt: 2,
		});
		const targets = listSteerViewTargets(current, { listRuns: () => [] });
		assert.equal(targets.length, 1);
		assert.equal(targets[0]?.agent, "live");
		assert.equal(targets[0]?.active, true);
	});

	it("supports optional legacy foreground state", () => {
		const current = state() as SubagentState & { foregroundLiveChildren?: SubagentState["foregroundLiveChildren"] };
		delete current.foregroundLiveChildren;
		assert.doesNotThrow(() => listSteerViewTargets(current as SubagentState, { listRuns: () => [] }));
	});

	it("derives direct async action routing metadata", () => {
		const current = state();
		current.asyncJobs.set("r", { asyncId: "r", asyncDir: "/tmp/r", status: "queued", agents: ["a"] });
		const target = listSteerViewTargets(current, { listRuns: () => [] })[0]!;
		assert.equal(target.actionControlDir, path.join("/tmp/r", "control", "action-targets", "0"));
		assert.equal(target.active, true);
	});
});
