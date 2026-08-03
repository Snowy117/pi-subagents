import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completionToToolResult } from "../../src/runs/background/completion-result.ts";

describe("completion result conversion", () => {
	it("maps rich child data and uses explicit zero usage for legacy results", () => {
		const result = completionToToolResult({
			runId: "r", sessionId: "s", mode: "single", cachedAt: 1,
			data: { success: true, state: "complete", summary: "delegate:\nfull output", totalTokens: { input: 2, output: 3 }, results: [{ agent: "delegate", task: "work", output: "full output", exitCode: 0, model: "p/m" }] },
		}, [{ agent: "delegate", task: "work" }]);
		assert.equal(result.details?.mode, "single");
		assert.equal(result.details?.results[0]?.task, "work");
		assert.deepEqual(result.details?.results[0]?.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
		assert.equal(result.details?.totalChildUsage?.input, 2);
		assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "full output");
	});
	it("preserves timeout, budget, cost, nested, and truncation metadata", () => {
		const turnBudget = { maxTurns: 4, graceTurns: 1, outcome: "exceeded", turnCount: 6, exceededAtTurn: 6 } as const;
		const toolBudget = { hard: 3, block: "*", outcome: "hard-blocked", toolCount: 3, hardReachedAt: 3, blockedTool: "write" } as const;
		const child = {
			id: "nested-child",
			parentRunId: "r",
			parentStepIndex: 0,
			depth: 1,
			path: [{ runId: "r", stepIndex: 0 }],
			state: "failed",
			agent: "nested",
		} as const;
		const artifactPaths = {
			inputPath: "/artifacts/input.md",
			outputPath: "/artifacts/output.md",
			jsonlPath: "/artifacts/events.jsonl",
			transcriptPath: "/artifacts/transcript.md",
			metadataPath: "/artifacts/metadata.json",
		};
		const usage = { input: 11, output: 7, cacheRead: 2, cacheWrite: 1, cost: 0.25, turns: 6 };
		const cost = { inputTokens: 11, outputTokens: 7, costUsd: 0.25 };
		const result = completionToToolResult({
			runId: "r", sessionId: "s", mode: "single", cachedAt: 1,
			data: {
				id: "r",
				sessionId: "s",
				sessionFile: "/sessions/root.jsonl",
				cwd: "/repo",
				asyncDir: "/runs/r",
				success: false,
				state: "failed",
				timeoutMs: 500,
				deadlineAt: 900,
				timedOut: true,
				turnBudget,
				turnBudgetExceeded: true,
				wrapUpRequested: true,
				toolBudget,
				toolBudgetBlocked: true,
				exitCode: 1,
				timestamp: 1000,
				durationMs: 250,
				truncated: true,
				totalCost: cost,
				nestedChildren: [child],
				results: [{
					agent: "delegate",
					task: "work",
					output: "partial output",
					error: "budget exhausted",
					success: false,
					exitCode: 1,
					usage,
					interrupted: true,
					timedOut: true,
					turnBudget,
					turnBudgetExceeded: true,
					wrapUpRequested: true,
					toolBudget,
					toolBudgetBlocked: true,
					totalCost: cost,
					artifactPaths,
					truncated: true,
					children: [child],
				}],
			},
		}, [{ agent: "delegate", task: "work" }]);

		const details = result.details!;
		const converted = details.results[0]!;
		assert.equal(details.asyncId, "r");
		assert.equal(details.asyncDir, "/runs/r");
		assert.equal(details.timeoutMs, 500);
		assert.equal(details.deadlineAt, 900);
		assert.equal(details.timedOut, true);
		assert.deepEqual(details.turnBudget, turnBudget);
		assert.equal(details.turnBudgetExceeded, true);
		assert.equal(details.wrapUpRequested, true);
		assert.deepEqual(details.toolBudget, toolBudget);
		assert.equal(details.toolBudgetBlocked, true);
		assert.deepEqual(details.nestedChildren, [child]);
		assert.deepEqual(details.truncation, { truncated: true, artifactPath: artifactPaths.outputPath });
		assert.deepEqual(converted.usage, usage);
		assert.equal(converted.interrupted, true);
		assert.equal(converted.timedOut, true);
		assert.deepEqual(converted.turnBudget, turnBudget);
		assert.equal(converted.turnBudgetExceeded, true);
		assert.equal(converted.wrapUpRequested, true);
		assert.deepEqual(converted.toolBudget, toolBudget);
		assert.equal(converted.toolBudgetBlocked, true);
		assert.deepEqual(converted.totalCost, cost);
		assert.deepEqual(converted.children, [child]);
		assert.deepEqual(converted.truncation, { text: "partial output", truncated: true, artifactPath: artifactPaths.outputPath });
	});
	it("formats parallel completions like the normal multi-result path", () => {
		const result = completionToToolResult({
			runId: "r", sessionId: "s", mode: "parallel", cachedAt: 1,
			data: {
				success: false,
				state: "failed",
				results: [
					{ agent: "a", task: "one", output: "A done", exitCode: 0, success: true },
					{ agent: "b", task: "two", output: "partial", error: "B failed", exitCode: 1, success: false },
				],
			},
		}, [{ agent: "a", task: "one" }, { agent: "b", task: "two" }]);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, /^1\/2 succeeded/);
		assert.match(text, /=== Task 1: a ===\nA done/);
		assert.match(text, /=== Task 2: b ===\nFAILED \(exit code 1\): B failed\npartial/);
		assert.equal(result.isError, true);
	});
	it("marks failed completions as errors", () => {
		const result = completionToToolResult({ runId: "r", sessionId: "s", mode: "single", cachedAt: 1, data: { success: false, state: "failed", error: "bad", results: [] } }, []);
		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "bad");
	});
});
