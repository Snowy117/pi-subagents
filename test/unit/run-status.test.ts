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
	it("repairs stale running status and reports diagnosis plus result path", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-stale-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-stale");
			fs.mkdirSync(asyncDir, { recursive: true });
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-stale",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				currentStep: 0,
				sessionFile,
				steps: [{ agent: "scout", status: "running", startedAt: 100, sessionFile }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-stale" }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 200,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /State: failed/);
			assert.match(text, /Diagnosis: Async runner process 12345 exited or disappeared/);
			assert.match(text, new RegExp(`Result: ${path.join(resultsDir, "run-stale.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.match(text, /Step 1: scout failed, error: Async runner process 12345 exited or disappeared/);
			assert.match(text, /Revive: subagent\(\{ action: "resume", id: "run-stale", message: "\.\.\." \}\)/);
			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-stale.json"), "utf-8"));
			assert.equal(resultJson.success, false);
			assert.equal(resultJson.results[0].sessionFile, sessionFile);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows parallel mode and aggregate progress for top-level async parallel runs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-parallel-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-parallel");
			fs.mkdirSync(asyncDir, { recursive: true });
			const runOutputPath = path.join(asyncDir, "combined-output.log");
			const firstStepOutputPath = path.join(asyncDir, "output-0.log");
			const secondStepOutputPath = path.join(asyncDir, "output-1.log");
			fs.writeFileSync(firstStepOutputPath, "reviewer one", "utf-8");
			fs.writeFileSync(secondStepOutputPath, "reviewer two", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-parallel",
				mode: "parallel",
				state: "running",
				error: "top-level async status error",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				currentStep: 0,
				outputFile: runOutputPath,
				chainStepCount: 1,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
				steps: [
					{ agent: "reviewer", status: "running", startedAt: 100, model: "openai-codex/gpt-5.5:high" },
					{ agent: "reviewer", status: "running", startedAt: 100, model: "anthropic/claude-haiku-4-5", thinking: "low" },
					{ agent: "reviewer", status: "pending" },
				],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-parallel" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const text = textContent(result);
			assert.match(text, /Mode: parallel/);
			assert.match(text, /Error: top-level async status error/);
			assert.match(text, /Progress: 2 agents running · 0\/3 done/);
			assert.match(text, new RegExp(`Output: ${runOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.match(text, /Agent 1\/3: reviewer running \(gpt-5\.5 · thinking high\)/);
			assert.match(text, /Agent 2\/3: reviewer running \(claude-haiku-4-5 · thinking low\)/);
			assert.match(text, /Agent 3\/3: reviewer pending/);
			assert.doesNotMatch(text, /openai-codex\/gpt-5\.5/);
			assert.match(text, new RegExp(`  Output: ${firstStepOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.match(text, new RegExp(`  Output: ${secondStepOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.doesNotMatch(text, /Step 1: reviewer/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("tails a readable transcript from async output artifacts", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-transcript-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-transcript");
			fs.mkdirSync(asyncDir, { recursive: true });
			const outputPath = path.join(asyncDir, "output-0.log");
			fs.writeFileSync(outputPath, ["first line", "second line", "third line"].join("\n"), "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-transcript",
				mode: "single",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				currentStep: 0,
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-transcript", view: "transcript", lines: 2 }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 250,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Run: run-transcript/);
			assert.match(text, /Step: 0 \(worker\) \| running/);
			assert.match(text, new RegExp(`Transcript tail from ${outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(tail truncated\\):`));
			assert.doesNotMatch(text, /first line/);
			assert.match(text, /second line/);
			assert.match(text, /third line/);
			assert.match(text, new RegExp(`Output: ${outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not fall back to another child output when an explicit transcript index output is missing", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-transcript-index-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-indexed-transcript");
			fs.mkdirSync(asyncDir, { recursive: true });
			const wrongOutputPath = path.join(asyncDir, "output-0.log");
			fs.writeFileSync(wrongOutputPath, "WRONG_CHILD_OUTPUT", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-indexed-transcript",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				currentStep: 0,
				outputFile: wrongOutputPath,
				steps: [
					{ agent: "worker", status: "running", startedAt: 100 },
					{ agent: "reviewer", status: "pending", recentOutput: ["RIGHT_CHILD_RECENT"] },
				],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-indexed-transcript", view: "transcript", index: 1 }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 250,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Agent: 1 \(reviewer\) \| pending/);
			assert.match(text, /Recent output from status\.json:/);
			assert.match(text, /RIGHT_CHILD_RECENT/);
			assert.doesNotMatch(text, /WRONG_CHILD_OUTPUT/);
			assert.doesNotMatch(text, new RegExp(`Transcript tail from ${wrongOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses to tail status outputFile paths outside the async directory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-transcript-escape-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-escape");
			fs.mkdirSync(asyncDir, { recursive: true });
			const outsideOutput = path.join(root, "outside.log");
			fs.writeFileSync(outsideOutput, "OUTSIDE_SENTINEL", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-escape",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				outputFile: path.relative(asyncDir, outsideOutput),
				steps: [],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-escape", view: "transcript" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Output read failed .*outside trusted roots/);
			assert.doesNotMatch(text, /OUTSIDE_SENTINEL/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses symlink session transcript paths even under trusted roots", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-transcript-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-session-symlink");
			const sessionRoot = path.join(root, "sessions");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.mkdirSync(sessionRoot, { recursive: true });
			const outsideSession = path.join(root, "outside-session.jsonl");
			const linkedSession = path.join(sessionRoot, "session.jsonl");
			fs.writeFileSync(outsideSession, `${JSON.stringify({ message: { role: "assistant", content: "OUTSIDE_SESSION_SENTINEL" } })}\n`, "utf-8");
			fs.symlinkSync(outsideSession, linkedSession);
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-session-symlink",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				steps: [{ agent: "worker", status: "complete", sessionFile: linkedSession }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-session-symlink", view: "transcript", index: 0 }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				sessionRoots: [sessionRoot],
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Session read failed .*Refusing to read symlink session transcript path/);
			assert.match(text, new RegExp(`Session: ${linkedSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.doesNotMatch(text, /OUTSIDE_SESSION_SENTINEL/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows an active read-only fleet view with transcript commands", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-fleet-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-fleet");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "output-0.log"), "worker output", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-fleet",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				currentStep: 0,
				chainStepCount: 1,
				parallelGroups: [{ start: 0, count: 2, stepIndex: 0 }],
				steps: [
					{ agent: "worker", status: "running", startedAt: 100 },
					{ agent: "reviewer", status: "pending" },
				],
			}, null, 2), "utf-8");
			const state = {
				foregroundControls: new Map([["fg-run", {
					runId: "fg-run",
					mode: "single",
					startedAt: 100,
					updatedAt: 250,
					currentAgent: "scout",
					currentIndex: 0,
					lastActivityAt: 240,
				}]]),
			} as unknown as SubagentState;

			const result = inspectSubagentStatus({ view: "fleet" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				state,
				kill: () => true,
				now: () => 250,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Subagent fleet: 2 tracked/);
			assert.match(text, /Foreground runs:/);
			assert.match(text, /fg-run \| running \| scout/);
			assert.match(text, /Async runs:/);
			assert.match(text, /run-fleet \| running .*\| parallel \| 1 agent running · 0\/2 done/);
			assert.match(text, /transcript: subagent\(\{ action: "status", id: "run-fleet", view: "transcript" \}\)/);
			assert.match(text, /transcript: subagent\(\{ action: "status", id: "run-fleet", index: 0, view: "transcript" \}\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("scopes fleet active-run discovery to the current session", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-fleet-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const currentDir = path.join(asyncRoot, "run-current");
			const otherDir = path.join(asyncRoot, "run-other");
			fs.mkdirSync(currentDir, { recursive: true });
			fs.mkdirSync(otherDir, { recursive: true });
			fs.writeFileSync(path.join(currentDir, "status.json"), JSON.stringify({
				runId: "run-current",
				sessionId: "session-current",
				mode: "single",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");
			fs.writeFileSync(path.join(otherDir, "status.json"), JSON.stringify({
				runId: "run-other",
				sessionId: "session-other",
				mode: "single",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [{ agent: "reviewer", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");
			const state = {
				currentSessionId: "session-current",
				asyncJobs: new Map(),
				foregroundControls: new Map(),
			} as unknown as SubagentState;

			const result = inspectSubagentStatus({ view: "fleet" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				state,
				kill: () => true,
				now: () => 250,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /run-current/);
			assert.doesNotMatch(text, /run-other/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses transcript reads for async runs owned by another session", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-transcript-session-scope-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-other-session");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "output-0.log"), "OTHER_SESSION_SENTINEL", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-other-session",
				sessionId: "session-other",
				mode: "single",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				currentStep: 0,
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");
			const state = {
				currentSessionId: "session-current",
				asyncJobs: new Map(),
				foregroundControls: new Map(),
			} as unknown as SubagentState;

			const result = inspectSubagentStatus({ id: "run-other-session", view: "transcript" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				state,
				kill: () => true,
				now: () => 250,
			});

			const text = textContent(result);
			assert.equal(result.isError, true);
			assert.match(text, /owned by the current session/);
			assert.doesNotMatch(text, /OTHER_SESSION_SENTINEL/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

});
