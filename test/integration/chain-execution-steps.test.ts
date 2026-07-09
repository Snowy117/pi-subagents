import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";
import { available, executeChain } from "../support/chain-execution-harness.ts";
import type { ChainExecutionResult, ChainResultItem, TestChainStep } from "../support/chain-execution-harness.ts";

describe("chain execution — sequential", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let artifactsDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		artifactsDir = path.join(tempDir, "artifacts");
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeChainParams(
		chain: TestChainStep[],
		agents: ReturnType<typeof makeAgent>[],
		overrides: Record<string, unknown> = {},
	) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir,
			artifactConfig: { enabled: false },
			clarify: false,
			...overrides,
		};
	}

	function readCallArgs(index: number): string[] {
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		const callFile = callFiles[index];
		assert.ok(callFile, `expected call ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	function acceptanceReport(overrides: Record<string, unknown> = {}): string {
		return [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "integration test evidence" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: ["test/a.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["validation passed"],
				residualRisks: [],
				noStagedFiles: true,
				notes: "complete",
				...overrides,
			}),
			"```",
		].join("\n");
	}

	function writePackageSkill(packageRoot: string, skillName: string): void {
		const skillDir = path.join(packageRoot, "skills", skillName);
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, "package.json"),
			JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
			"utf-8",
		);
	}


	it("runs a 2-step chain", async () => {
		mockPi.onCall({ output: "Analysis complete: found 3 issues" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze the code" }, { agent: "reporter" }],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0].agent, "analyst");
		assert.equal(result.details.results[1].agent, "reporter");
		assert.deepEqual(result.details.totalCost, { inputTokens: 200, outputTokens: 100, costUsd: 0.002 });
	});

	it("runs a foreground sequential chain without clarify UI when clarify is omitted", async () => {
		mockPi.onCall({ output: "Analysis complete" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];
		let customCalls = 0;
		const ctx = {
			...makeMinimalCtx(tempDir),
			hasUI: true,
			ui: {
				custom: async () => {
					customCalls += 1;
					return undefined;
				},
			},
		};

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze the code" }, { agent: "reporter" }],
				agents,
				{ ctx, clarify: undefined },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Chain cancelled/);
		assert.equal(result.details.results.length, 2);
		assert.equal(mockPi.callCount(), 2);
		assert.equal(customCalls, 0);
	});

	it("uses clarify UI for a foreground sequential chain when clarify is true", async () => {
		mockPi.onCall({ output: "Analysis complete" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];
		let customCalls = 0;
		const ctx = {
			...makeMinimalCtx(tempDir),
			hasUI: true,
			ui: {
				custom: async () => {
					customCalls += 1;
					return {
						confirmed: true,
						templates: ["Clarified analysis", "Report on {previous}"],
						behaviorOverrides: [],
					};
				},
			},
		};

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze the code" }, { agent: "reporter" }],
				agents,
				{ ctx, clarify: true },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(customCalls, 1);
		assert.equal(mockPi.callCount(), 2);
		assert.match(readCallArgs(0).at(-1) ?? "", /Clarified analysis/);
	});

	it("preserves completed chain results and marks the timed-out current step", async () => {
		mockPi.onCall({ matchArgIncludes: "Quick first step", output: "first done" });
		mockPi.onCall({ matchArgIncludes: "Slow second step", delay: 10000 });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];

		const start = Date.now();
		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Quick first step" }, { agent: "reporter", task: "Slow second step" }],
				agents,
				{ timeoutMs: 300 },
			),
		);
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should time out early, took ${elapsed}ms`);
		assert.equal(result.isError, true);
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0]?.exitCode, 0);
		assert.equal(result.details.results[0]?.finalOutput, "first done");
		assert.equal(result.details.results[1]?.timedOut, true);
		assert.equal(result.details.results[1]?.error, "Subagent timed out after 300ms.");
		assert.match(result.content[0]?.text ?? "", /Subagent timed out after 300ms\./);
	});

	it("passes file-only saved-output references through {previous}", async () => {
		mockPi.onCall({ output: "full chain output\nwith details" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "analyst", task: "Analyze", output: "analysis.md", outputMode: "file-only" },
					{ agent: "reporter" },
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.match(result.details.results[0]?.finalOutput ?? "", /Output saved to:/);
		assert.doesNotMatch(result.details.results[0]?.finalOutput ?? "", /full chain output/);
		const secondTaskArg = readCallArgs(1).at(-1) ?? "";
		assert.match(secondTaskArg, /Output saved to:/);
		assert.match(secondTaskArg, /2 lines/);
		assert.doesNotMatch(secondTaskArg, /full chain output/);
	});

	it("persists explicit checked acceptance and rejects missing evidence", async () => {
		mockPi.onCall({
			output: [
				"implemented",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
					changedFiles: ["src/file.ts"],
					testsAddedOrUpdated: ["test/file.test.ts"],
					commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
					validationOutput: ["passed"],
					residualRisks: [],
					noStagedFiles: true,
					notes: "done",
				}),
				"```",
			].join("\n"),
		});
		const agents = [makeAgent("worker", { completionGuard: false })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", output: "accepted.md", outputMode: "file-only", acceptance: { level: "checked", criteria: ["Patch bug"] } }],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.match(result.details.results[0]?.finalOutput ?? "", /Output saved to:/);
		assert.equal(result.details.results[0]?.acceptance?.status, "checked");
		assert.ok(result.details.results[0]?.acceptance?.childReport);

		mockPi.onCall({
			output: [
				"implemented",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
					changedFiles: ["src/file.ts"],
					testsAddedOrUpdated: [],
					commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
					residualRisks: [],
					noStagedFiles: true,
				}),
				"```",
			].join("\n"),
		});

		const failed = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", acceptance: { level: "checked" } }],
				agents,
			),
		);
		assert.equal(failed.isError, true);
		assert.equal(failed.details.results[0]?.acceptance?.status, "rejected");
		assert.match(failed.details.results[0]?.error ?? "", /tests-added evidence missing/);
	});

	it("runs explicit verified acceptance commands and does not trust child command claims as verification", async () => {
		const acceptanceReport = [
			"implemented",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
				changedFiles: ["src/file.ts"],
				testsAddedOrUpdated: ["test/file.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "child claimed pass" }],
				validationOutput: ["child output"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: acceptanceReport });
		const agents = [makeAgent("worker", { completionGuard: false })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", acceptance: { level: "verified", verify: [{ id: "runtime-pass", command: "node -e \"process.exit(0)\"" }] } }],
				agents,
			),
		);
		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results[0]?.acceptance?.status, "verified");
		assert.equal(result.details.results[0]?.acceptance?.verifyRuns?.[0]?.status, "passed");

		mockPi.onCall({ output: acceptanceReport });
		const failed = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", acceptance: { level: "verified", verify: [{ id: "runtime-fail", command: "node -e \"process.exit(5)\"" }] } }],
				agents,
			),
		);
		assert.equal(failed.isError, true);
		assert.equal(failed.details.results[0]?.acceptance?.status, "rejected");
		assert.equal(failed.details.results[0]?.acceptance?.verifyRuns?.[0]?.status, "failed");
		assert.match(failed.details.results[0]?.error ?? "", /runtime-fail/);
	});

	it("retries chain steps with fallback models on retryable provider failures", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "provider unavailable",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Step 1 recovered" });
		mockPi.onCall({ output: "Step 2 ran" });
		const agents = [
			makeAgent("step1", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] }),
			makeAgent("step2"),
		];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
		assert.deepEqual(result.details.results[0].attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(mockPi.callCount(), 3);
	});

	it("prefers the parent session provider for ambiguous bare chain step models", async () => {
		mockPi.onCall({ output: "Step 1 ran" });
		mockPi.onCall({ output: "Step 2 ran" });
		const agents = [makeAgent("step1", { model: "gpt-5-mini" }), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }, { agent: "step2" }],
				agents,
				{
					ctx: {
						...makeMinimalCtx(tempDir),
						model: { provider: "github-copilot" },
						modelRegistry: {
							getAvailable: () => [
								{ provider: "openai", id: "gpt-5-mini" },
								{ provider: "github-copilot", id: "gpt-5-mini" },
							],
						},
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.details.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("foreground chains inherit the parent session model when no step or agent model is set", async () => {
		mockPi.onCall({ output: "Step ran" });

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Do work" }],
				[makeAgent("worker")],
				{
					ctx: {
						...makeMinimalCtx(tempDir),
						model: { provider: "deepseek", id: "deepseek-v4-flash" },
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		const args = readCallArgs(0);
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
		assert.equal(result.details.results[0].model, "deepseek/deepseek-v4-flash");
	});

	it("foreground chains treat the inherit model sentinel as the parent session model", async () => {
		mockPi.onCall({ output: "Step ran" });

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Do work", model: "inherit" }],
				[makeAgent("worker")],
				{
					ctx: {
						...makeMinimalCtx(tempDir),
						model: { provider: "deepseek", id: "deepseek-v4-flash" },
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		const args = readCallArgs(0);
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
		assert.equal(result.details.results[0].model, "deepseek/deepseek-v4-flash");
	});

	it("suppresses progress for {task} chain templates when the top-level task is review-only", async () => {
		mockPi.onCall({ output: "Review done" });
		const agents = [makeAgent("reviewer", { defaultProgress: true })];

		await executeChain(
			makeChainParams(
				[{ agent: "reviewer" }],
				agents,
				{ task: "Review-only. Do not edit files. Return findings." },
			),
		);

		const taskArg = readCallArgs(0).at(-1) ?? "";
		assert.doesNotMatch(taskArg, /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("foreground chains still resolve defaultProgress inside the chain directory", async () => {
		mockPi.onCall({ output: "Progress done" });
		const agents = [makeAgent("reviewer", { defaultProgress: true })];
		const chainDir = path.join(tempDir, "chain-progress");
		const runId = "chain-progress-run";

		await executeChain(
			makeChainParams(
				[{ agent: "reviewer", task: "Track chain work" }],
				agents,
				{ chainDir, runId },
			),
		);

		const taskArg = readCallArgs(0).at(-1) ?? "";
		assert.ok(taskArg.includes(`Create and maintain progress at: ${path.join(chainDir, runId, "progress.md")}`), taskArg);
	});

	it("passes {previous} between steps (step 2 receives step 1 output)", async () => {
		mockPi.onCall({ output: "Step 1 unique output: MARKER_ABC_123" });
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Produce output" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		const step2Task = result.details.results[1].task;
		assert.ok(
			step2Task.includes("MARKER_ABC_123"),
			`step 2 task should contain step 1 output via {previous}: ${step2Task.slice(0, 200)}`,
		);
	});

});
