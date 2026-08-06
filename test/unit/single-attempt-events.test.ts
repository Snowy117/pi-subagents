import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_RUNNING_UPDATE_CHARS, runningUpdateText } from "../../src/runs/foreground/execution/single-attempt-events.ts";

describe("foreground single-attempt running updates", () => {
	it("uses bounded recent progress without reading the historical transcript", () => {
		const result = {
			timedOut: false,
			turnBudgetExceeded: false,
			finalOutput: undefined,
			get messages(): never {
				throw new Error("ordinary updates must not inspect messages");
			},
		};
		assert.equal(runningUpdateText(result, ["older", "", "latest progress"]), "latest progress");
	});

	it("preserves captured timeout and turn-budget terminal output", () => {
		assert.equal(runningUpdateText({ timedOut: true, finalOutput: "timed out detail" }, ["recent"]), "timed out detail");
		assert.equal(runningUpdateText({ turnBudgetExceeded: true, finalOutput: "budget detail" }, []), "budget detail");
	});

	it("bounds a very large ordinary recent-output line", () => {
		const text = runningUpdateText({}, [`prefix-${"x".repeat(MAX_RUNNING_UPDATE_CHARS * 2)}`]);
		assert.equal(text.length, MAX_RUNNING_UPDATE_CHARS);
		assert.ok(text.startsWith("…"));
	});

	it("falls back to the stable running placeholder", () => {
		assert.equal(runningUpdateText({}, ["", "   "]), "(running...)");
	});
});
