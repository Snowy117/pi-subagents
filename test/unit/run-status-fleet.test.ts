import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { TEMP_ROOT_DIR, type SubagentState } from "../../src/shared/types.ts";

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function textContent(result: ReturnType<typeof inspectSubagentStatus>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

describe("async run status inspection", () => {
	it("does not fall back to aggregate result output for an explicit completed child index", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-index-fallback-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "run-result-index-fallback"), { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });
			fs.writeFileSync(path.join(resultsDir, "run-result-index-fallback.json"), JSON.stringify({
				id: "run-result-index-fallback",
				success: true,
				summary: "AGGREGATE_SENTINEL",
				results: [
					{ agent: "worker", output: "first child" },
					{ agent: "reviewer" },
				],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-result-index-fallback", view: "transcript", index: 1 }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Child: 1 \(reviewer\)/);
			assert.match(text, /\(no transcript lines available yet\)/);
			assert.doesNotMatch(text, /AGGREGATE_SENTINEL/);
			assert.doesNotMatch(text, /first child/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces steering counts and timestamps in exact and list status", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-steering-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-steered");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-steered",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 200,
				currentStep: 0,
				steerCount: 2,
				lastSteerAt: 150,
				steps: [{ agent: "worker", status: "running", startedAt: 100, steerCount: 2, lastSteerAt: 150 }],
			}, null, 2), "utf-8");

			const exact = inspectSubagentStatus({ id: "run-steered" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 250,
			});
			const exactText = textContent(exact);
			assert.equal(exact.isError, undefined);
			assert.match(exactText, /Steering: 2 steers, last 1970-01-01T00:00:00\.150Z/);
			assert.match(exactText, /Step 1: worker running, steering: 2 steers, last 1970-01-01T00:00:00\.150Z/);

			const list = inspectSubagentStatus({}, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 250,
			});
			const listText = textContent(list);
			assert.equal(list.isError, undefined);
			assert.match(listText, /2 steers \| last steer 1970-01-01T00:00:00\.150Z/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows nested runs under owning steps with exact status hints", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-root-"));
		const route = createNestedRoute("run-nested-root");
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-nested-root");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-nested-root",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");
			writeNestedEvent(route, {
				type: "subagent.nested.updated",
				ts: 150,
				parentRunId: "run-nested-root",
				parentStepIndex: 0,
				child: {
					id: "nested-status-child",
					parentRunId: "run-nested-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-nested-root", stepIndex: 0, agent: "orchestrator" }],
					state: "running",
					agent: "reviewer",
					currentTool: "read",
					lastUpdate: 150,
				},
			});

			const result = inspectSubagentStatus({ id: "run-nested-root" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Step 1: orchestrator running/);
			assert.match(text, /↳ reviewer \[nested-status-child\] running \| tool read/);
			assert.match(text, /Status: subagent\(\{ action: "status", id: "nested-status-child" \}\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("repairs stale nested async descendants before rendering root status", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-stale-nested-"));
		const route = createNestedRoute("run-stale-nested-root");
		const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "run-stale-nested-root", "nested-stale");
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-stale-nested-root");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.mkdirSync(nestedAsyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-stale-nested-root",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 300,
				steps: [{ agent: "orchestrator", status: "complete", startedAt: 100 }],
			}, null, 2), "utf-8");
			fs.writeFileSync(path.join(nestedAsyncDir, "status.json"), JSON.stringify({
				runId: "nested-stale",
				mode: "single",
				state: "running",
				pid: 54321,
				startedAt: 150,
				lastUpdate: 150,
				steps: [{ agent: "reviewer", status: "running", startedAt: 150 }],
			}, null, 2), "utf-8");
			writeNestedEvent(route, {
				type: "subagent.nested.updated",
				ts: 150,
				parentRunId: "run-stale-nested-root",
				parentStepIndex: 0,
				child: {
					id: "nested-stale",
					parentRunId: "run-stale-nested-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-stale-nested-root", stepIndex: 0 }],
					asyncDir: nestedAsyncDir,
					pid: 54321,
					state: "running",
					agent: "reviewer",
					lastUpdate: 150,
				},
			});

			const result = inspectSubagentStatus({ id: "run-stale-nested-root" }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 500,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /↳ reviewer \[nested-stale\] failed/);
			assert.match(text, /1\. reviewer failed \| error: Async runner process 54321 exited or disappeared/);
			assert.ok(fs.existsSync(path.join(resultsDir, "nested", "run-stale-nested-root", "nested-stale.json")));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
			fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
		}
	});

	it("shows a warning when nested projection fails for detailed status", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-warning-"));
		const route = createNestedRoute("run-nested-warning");
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-nested-warning");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(path.dirname(route.eventSink), "registry.json"), "{", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-nested-warning",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-nested-warning" }, { asyncDirRoot: asyncRoot, resultsDir });

			assert.equal(result.isError, undefined);
			assert.match(textContent(result), /Warning: Nested status unavailable:/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("shows a warning when nested projection fails for active status lists", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-list-warning-"));
		const route = createNestedRoute("run-nested-list-warning");
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-nested-list-warning");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(path.dirname(route.eventSink), "registry.json"), "{", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-nested-list-warning",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({}, { asyncDirRoot: asyncRoot, resultsDir, kill: () => true, now: () => 200 });

			assert.equal(result.isError, undefined);
			assert.match(textContent(result), /Warning: Nested status unavailable:/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("resolves exact nested run ids from the nested registry", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-exact-"));
		const route = createNestedRoute("run-nested-exact-root");
		try {
			writeNestedEvent(route, {
				type: "subagent.nested.updated",
				ts: 150,
				parentRunId: "run-nested-exact-root",
				parentStepIndex: 0,
				child: {
					id: "nested-exact-child",
					parentRunId: "run-nested-exact-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-nested-exact-root", stepIndex: 0, agent: "orchestrator" }],
					state: "running",
					mode: "single",
					agent: "validator",
					steps: [{ agent: "leaf", status: "running", currentTool: "grep" }],
					lastUpdate: 150,
				},
			});

			const result = inspectSubagentStatus({ id: "nested-exact-child" }, {
				asyncDirRoot: path.join(root, "runs"),
				resultsDir: path.join(root, "results"),
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Nested run: nested-exact-child/);
			assert.match(text, /Root: run-nested-exact-root/);
			assert.match(text, /Agent: validator/);
			assert.match(text, /1\. leaf running/);
			assert.match(text, /Root status: subagent\(\{ action: "status", id: "run-nested-exact-root" \}\)/);
			assert.match(text, /Interrupt: subagent\(\{ action: "interrupt", id: "nested-exact-child" \}\)/);
			assert.match(text, /Resume: subagent\(\{ action: "resume", id: "nested-exact-child", message: "\.\.\." \}\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("shows indexed revive guidance for completed multi-child async runs with child sessions", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-multi-resume-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-multi");
			const firstSession = path.join(root, "a.jsonl");
			const secondSession = path.join(root, "b.jsonl");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(firstSession, "", "utf-8");
			fs.writeFileSync(secondSession, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-multi",
				mode: "parallel",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "a", status: "complete", sessionFile: firstSession },
					{ agent: "b", status: "complete", sessionFile: secondSession },
				],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-multi" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
			});

			const text = textContent(result);
			assert.match(text, /Revive child: subagent\(\{ action: "resume", id: "run-multi", index: 0, message: "\.\.\." \}\)/);
			assert.doesNotMatch(text, /unsupported for multi-child/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

});
