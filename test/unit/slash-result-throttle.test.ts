import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSlashResultComponent } from "../../src/extension/registration/message-renderers.ts";
import { applySlashUpdate, buildSlashInitialResult, clearSlashSnapshots, finalizeSlashResult } from "../../src/slash/slash-live-state.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Details } from "../../src/shared/types.ts";

const theme = {
	fg(_name: string, text: string) { return text; },
	bg(_name: string, text: string) { return text; },
	bold(text: string) { return text; },
} as Theme;

const singleParams = { agent: "delegate", task: "do the thing" };

const runningProgress = (overrides: Partial<NonNullable<Details["progress"]>[number]> = {}): Details["progress"] => [{
	index: 0,
	agent: "delegate",
	status: "running",
	task: "do the thing",
	recentTools: [],
	recentOutput: [],
	toolCount: 0,
	tokens: 0,
	durationMs: 1000,
	...overrides,
}];

describe("slash child-view rebuild throttle", () => {
	it("rebuilds on first render and on version change, at most ~1/500ms while running", () => {
		clearSlashSnapshots();
		const details = buildSlashInitialResult("r1", singleParams);
		let now = 0;
		let rebuilds = 0;
		const component = createSlashResultComponent(details, { expanded: false }, theme, {
			now: () => now,
			rebuild: () => { rebuilds++; },
		});

		component.render(50);
		assert.equal(rebuilds, 1, "first render rebuilds");

		// Same version, running, clock not advanced: throttled.
		component.render(50);
		assert.equal(rebuilds, 1, "no rebuild before the throttle window elapses");

		// 500ms elapsed: rebuilds again to keep live durations ticking.
		now = 500;
		component.render(50);
		assert.equal(rebuilds, 2, "rebuild after the 500ms throttle window");

		// Only 1ms later: throttled again.
		now = 501;
		component.render(50);
		assert.equal(rebuilds, 2, "throttled again within the window");

		// A real data change (version bump) rebuilds immediately.
		applySlashUpdate("r1", { requestId: "r1", progress: runningProgress({ durationMs: 2000 }) });
		component.render(50);
		assert.equal(rebuilds, 3, "version change rebuilds immediately");
		clearSlashSnapshots();
	});

	it("does not rebuild periodically once completed", () => {
		clearSlashSnapshots();
		const details = buildSlashInitialResult("r2", singleParams);
		let now = 0;
		let rebuilds = 0;
		const component = createSlashResultComponent(details, { expanded: false }, theme, {
			now: () => now,
			rebuild: () => { rebuilds++; },
		});
		component.render(50);
		assert.equal(rebuilds, 1);

		// Finalize: completed snapshot with a fresh version — rebuild once.
		finalizeSlashResult({
			requestId: "r2",
			isError: false,
			result: {
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "single",
					results: [{
						agent: "delegate", task: "do the thing", exitCode: 0, finalOutput: "done",
						usage: { input: 0, output: 0, turns: 1 },
						progress: { index: 0, agent: "delegate", status: "completed", task: "do the thing", recentTools: [], recentOutput: [], toolCount: 1, tokens: 1, durationMs: 1000 },
					}],
					progress: [{ index: 0, agent: "delegate", status: "completed", task: "do the thing", recentTools: [], recentOutput: [], toolCount: 1, tokens: 1, durationMs: 1000 }],
				},
			},
		});
		component.render(50);
		assert.equal(rebuilds, 2, "completion version change rebuilds once");

		// Long idle window with no version change: no rebuilds.
		now = 10000;
		component.render(50);
		component.render(50);
		assert.equal(rebuilds, 2, "completed results never rebuild on idle renders");
		clearSlashSnapshots();
	});
});
