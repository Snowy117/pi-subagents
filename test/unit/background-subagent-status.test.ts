import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countBackgroundSubagents, renderBackgroundSubagentStatus } from "../../src/tui/render.ts";
import type { AsyncJobState } from "../../src/shared/types.ts";

describe("background subagent status", () => {
	it("counts active caller-detached steps and excludes sync-owned runs", () => {
		const jobs: AsyncJobState[] = [
			{ asyncId: "sync", asyncDir: "/tmp/sync", status: "running", sessionId: "session", agents: ["worker"] },
			{
				asyncId: "background",
				asyncDir: "/tmp/background",
				status: "running",
				steps: [
					{ agent: "done", status: "complete" },
					{ agent: "worker", status: "running" },
					{ agent: "reviewer", status: "pending" },
				],
			},
			{ asyncId: "complete", asyncDir: "/tmp/complete", status: "complete", agents: ["finished"] },
		];

		assert.equal(countBackgroundSubagents(jobs, (runId) => runId === "sync"), 2);
	});

	it("clears the legacy widget and writes only a status-bar count", () => {
		const widgets: unknown[] = [];
		const statuses: Array<string | undefined> = [];
		const ctx = {
			hasUI: true,
			ui: {
				setWidget(_key: string, value: unknown) { widgets.push(value); },
				setStatus(_key: string, value: string | undefined) { statuses.push(value); },
			},
		};
		const jobs: AsyncJobState[] = [
			{ asyncId: "background", asyncDir: "/tmp/background", status: "queued", agents: ["worker"] },
		];

		assert.equal(renderBackgroundSubagentStatus(ctx as never, jobs), 1);
		assert.equal(widgets.at(-1), undefined);
		assert.equal(statuses.at(-1), "1 background subagent");

		assert.equal(renderBackgroundSubagentStatus(ctx as never, []), 0);
		assert.equal(statuses.at(-1), undefined);
	});
});
