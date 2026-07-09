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
	it("uses original child indexes when result metadata contains invalid children", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-original-index-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const sessionFile = path.join(root, "b.jsonl");
			fs.mkdirSync(resultsDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(resultsDir, "run-result-index.json"), JSON.stringify({
				id: "run-result-index",
				success: false,
				state: "failed",
				results: [
					{ output: "missing agent", sessionFile: path.join(root, "a.jsonl") },
					{ agent: "b", success: false, sessionFile },
				],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-result-index" }, { asyncDirRoot: asyncRoot, resultsDir });

			const text = textContent(result);
			assert.match(text, /Revive child: subagent\(\{ action: "resume", id: "run-result-index", index: 1, message: "\.\.\." \}\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("labels chain parallel group children with logical step and agent numbers", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-chain-parallel-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-chain");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-chain",
				mode: "chain",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				currentStep: 1,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				steps: [
					{ agent: "scout", status: "complete", startedAt: 100 },
					{ agent: "reviewer", status: "running", startedAt: 100 },
					{ agent: "auditor", status: "pending" },
					{ agent: "writer", status: "pending" },
				],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-chain" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const text = textContent(result);
			assert.match(text, /Step 1\/3: scout complete/);
			assert.match(text, /Step 2\/3 Agent 1\/2: reviewer running/);
			assert.match(text, /Step 2\/3 Agent 2\/2: auditor pending/);
			assert.match(text, /Step 3\/3: writer pending/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("shows expected intercom target for still-running async steps", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-intercom-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const asyncDir = path.join(asyncRoot, "run-live");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-live",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "scout", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-live" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				now: () => 200,
			});

			const text = textContent(result);
			assert.match(text, /Step 1: scout running/);
			assert.match(text, /Intercom target: subagent-scout-run-live-1 \(if registered\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous async run id prefixes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			fs.mkdirSync(path.join(asyncRoot, "run-aa"), { recursive: true });
			fs.mkdirSync(path.join(asyncRoot, "run-ab"), { recursive: true });

			const result = inspectSubagentStatus({ id: "run-a" }, {
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
			});

			assert.equal(result.isError, true);
			assert.match(textContent(result), /Ambiguous subagent run id prefix 'run-a' matched: async:run-aa, async:run-ab/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects path-like async run ids", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-paths-"));
		try {
			const result = inspectSubagentStatus({ id: "../run" }, {
				asyncDirRoot: path.join(root, "runs"),
				resultsDir: path.join(root, "results"),
			});

			assert.equal(result.isError, true);
			assert.match(textContent(result), /id must be a non-empty safe id token/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not advertise revive for result fallback with only a top-level session file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-no-child-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "run-session-only"), { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(resultsDir, "run-session-only.json"), JSON.stringify({
				id: "run-session-only",
				success: false,
				state: "failed",
				sessionFile,
				summary: "missing child metadata",
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-session-only" }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Resume: unavailable/);
			assert.doesNotMatch(text, /Revive:/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats a top-level completed result as one transcript child", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-transcript-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "run-result-transcript"), { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(resultsDir, "run-result-transcript.json"), JSON.stringify({
				id: "run-result-transcript",
				agent: "worker",
				success: false,
				state: "failed",
				sessionFile,
				summary: "legacy result transcript",
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-result-transcript", view: "transcript", index: 0 }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /Child: 0 \(worker\)/);
			assert.match(text, /legacy result transcript/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("validates completed result transcript indexes as integers", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-transcript-index-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "run-result-index-validation"), { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });
			fs.writeFileSync(path.join(resultsDir, "run-result-index-validation.json"), JSON.stringify({
				id: "run-result-index-validation",
				agent: "worker",
				success: true,
				summary: "done",
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-result-index-validation", view: "transcript", index: 0.5 }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
			});

			assert.equal(result.isError, true);
			assert.match(textContent(result), /Transcript index must be an integer/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to an existing result when async dir has no status file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-fallback-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "run-result-only"), { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(resultsDir, "run-result-only.json"), JSON.stringify({
				id: "run-result-only",
				agent: "worker",
				success: false,
				state: "failed",
				sessionFile,
				summary: "result survived missing status",
			}, null, 2), "utf-8");

			const result = inspectSubagentStatus({ id: "run-result-only" }, {
				asyncDirRoot: asyncRoot,
				resultsDir,
			});

			const text = textContent(result);
			assert.equal(result.isError, undefined);
			assert.match(text, /State: failed/);
			assert.match(text, /Result: /);
			assert.match(text, /Revive: subagent\(\{ action: "resume", id: "run-result-only", message: "\.\.\." \}\)/);
			assert.match(text, /result survived missing status/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
