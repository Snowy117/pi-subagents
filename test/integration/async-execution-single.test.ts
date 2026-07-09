import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";
import {
	available,
	ASYNC_DIR,
	createRepo,
	createSubagentExecutor,
	deliverInterruptRequest,
	escapeRegExp,
	executeAsyncChain,
	executeAsyncSingle,
	git,
	isAsyncAvailable,
	mockAssistantMessage,
	readLastMockPiArgs,
	readMockPiArgs,
	readMockPiArgsMatching,
	readStatus,
	RESULTS_DIR,
	TEMP_ROOT_DIR,
	waitForAsyncResultFile,
	waitForMockPiArgs,
	waitForMockPiCall,
	writePackageSkill,
} from "../support/async-execution-harness.ts";
import type { AsyncExecutionResult, AsyncResultPayload, AsyncStatusPayload, MockPiCallRecord } from "../support/async-execution-harness.ts";

describe("async execution utilities — background single execution", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
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
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("background runs treat recovered child errors as successful", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage("Recovered asynchronously"),
			],
		});
		const id = `async-recovered-child-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.state, "complete");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0]?.success, true);
		assert.equal(payload.results[0]?.error, undefined);
		assert.equal(payload.results[0]?.output, "Recovered asynchronously");
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "complete");
		assert.equal(statusPayload.steps?.[0]?.status, "complete");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 0);
	});

	it("background runs keep provider errors failed when followed only by empty assistant output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage(""),
			],
		});
		const id = `async-provider-error-empty-stop-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0]?.success, false);
		assert.match(payload.results[0]?.error ?? "", /provider transport failed/);
		assert.equal(payload.results[0]?.output, "");
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "failed");
		assert.equal(statusPayload.steps?.[0]?.status, "failed");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 1);
	});

	it("background file-only runs write full output but return only a file reference", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async full output\nwith details" });
		const id = `async-file-only-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const outputPath = path.join(tempDir, "async-file-only.md");
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.match(payload.summary ?? "", /Output saved to:/);
		assert.match(payload.summary ?? "", /2 lines/);
		assert.doesNotMatch(payload.summary ?? "", /async full output/);
		assert.match(payload.results[0]?.output ?? "", /Output saved to:/);
		assert.doesNotMatch(payload.results[0]?.output ?? "", /async full output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async full output\nwith details");
	});

	it("background single runs route relative outputs to outputBaseDir", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async configured report" });
		const id = `async-configured-output-base-${Date.now().toString(36)}`;
		const outputBaseDir = path.join(tempDir, "async-configured-outputs");
		const run = executeAsyncSingle(id, {
			agent: "researcher",
			task: "Write report",
			agentConfig: makeAgent("researcher", { output: "context.md" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: "context.md",
			outputBaseDir,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const outputPath = path.join(outputBaseDir, "context.md");
		const call = await waitForMockPiCall(mockPi, 0);
		const taskArg = call.args.at(-1) ?? "";
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async configured report");
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("background single runs make output overrides authoritative in the child system prompt", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async override report" });
		const id = `async-output-override-system-prompt-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, "async-custom-report.md");
		const run = executeAsyncSingle(id, {
			agent: "researcher",
			task: "Write report",
			agentConfig: makeAgent("researcher", {
				output: "default-report.md",
				systemPrompt: "Output format (`default-report.md`):\n\nWrite the full report to default-report.md.",
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const call = await waitForMockPiCall(mockPi, 0);
		const taskArg = call.args.at(-1) ?? "";
		const systemPrompt = call.systemPrompts[0]?.text ?? "";
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		assert.match(systemPrompt, /Output format \(`default-report\.md`\):/);
		assert.match(systemPrompt, /Runtime output path override:/);
		assert.match(systemPrompt, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		assert.match(systemPrompt, /Ignore any other output filename or output path mentioned elsewhere/);
		await waitForAsyncResultFile(id);
	});

	it("background single runs treat string false as disabled output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async inline report" });
		const id = `async-string-false-output-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { output: "default-report.md" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: "false",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "async inline report");
		assert.doesNotMatch(payload.summary ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readLastMockPiArgs(mockPi).at(-1) ?? "", /Write your findings to(?: exactly this path)?:/);
	});

	it("background runs detect hidden tool failures even when the child exits 0", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "connection refused")],
		});

		const id = `async-hidden-failure-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Deploy app",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
	});

	it("background implementation runs fail when no mutation attempt occurred", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });

		const id = `async-no-mutation-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.match(String(payload.results[0].error ?? ""), /completed without making edits/);
		assert.match(String(payload.results[0].modelAttempts?.[0]?.error ?? ""), /completed without making edits/);

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.match(eventsText, /"reason":"completion_guard"/);
		assert.match(eventsText, /Subagent failed: worker/);
		assert.doesNotMatch(eventsText, /Status:/);
		assert.doesNotMatch(eventsText, /Interrupt:/);
	});

	it("background bash-enabled non-implementation agents can opt out of the completion guard", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "cold start test after patch" });

		const id = `async-completion-guard-optout-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "test-runner",
			task: "Run cold start test after patch",
			agentConfig: makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "cold start test after patch");

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.doesNotMatch(eventsText, /"reason":"completion_guard"/);
	});

	it("background runs prefer the parent session provider for ambiguous bare model ids", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-provider-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "gpt-5-mini" }),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "github-copilot",
			},
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(payload.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

});
