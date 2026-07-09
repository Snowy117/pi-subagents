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

describe("async execution utilities — drain, control & live streaming", { skip: !available ? "pi packages not available" : undefined }, () => {
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

	it("background forced drain after final assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("async-done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		const start = Date.now();
		executeAsyncSingle(id, {
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

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 9000, `should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "async-done-before-drain");
	});

	it("background forced drain after empty terminal assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("")],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-empty-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "scout",
			task: "Inspect something",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 9000, `should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "");
	});

	it("background final-drain cleanup preserves explicit assistant errors", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "failed" }],
					model: "mock/test-model",
					stopReason: "stop",
					errorMessage: "provider exploded",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-error-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.equal(payload.results[0].error, "provider exploded");
	});

	it("background runs emit active-long-running control events from child turns", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("still working")] },
				{ delay: 2_000, jsonl: [events.assistantMessage("done")] },
			],
		});

		const id = `async-active-long-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "scout",
			task: "Investigate behavior",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 1,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "active_long_running" && status.steps?.[0]?.activityState === "active_long_running") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed active_long_running");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"active_long_running"/);
		assert.match(eventText, /"reason":"turn_threshold"/);
		assert.ok(statusDuringEvent, "expected status.json to expose active_long_running while the run is still active");
		assert.equal(statusDuringEvent.activityState, "active_long_running");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "active_long_running");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs escalate repeated mutating tool failures", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ delay: 2_000, jsonl: [events.assistantMessage("I need another attempt.")] },
			],
		});

		const id = `async-tool-failures-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed needs_attention");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"needs_attention"/);
		assert.match(eventText, /"reason":"tool_failures"/);
		assert.match(eventText, /subagent-runner\.ts/);
		assert.ok(statusDuringEvent, "expected status.json to expose needs_attention while the run is still active");
		assert.equal(statusDuringEvent.activityState, "needs_attention");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "needs_attention");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background event logs drop noisy message updates and cap child diagnostics", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const previousMaxBytes = process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES;
		process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES = "900";
		try {
			mockPi.onCall({
				steps: [
					{
						jsonl: [
							{
								type: "message_update",
								assistantMessageEvent: {
									type: "thinking_delta",
									delta: "NOISY_PARTIAL_DELTA",
									partial: { role: "assistant", content: [{ type: "text", text: "NOISY_PARTIAL_SNAPSHOT".repeat(200) }] },
								},
								message: { role: "assistant", content: [{ type: "text", text: "NOISY_PARTIAL_MESSAGE".repeat(200) }] },
							},
							events.toolStart("bash", { command: `echo ${"BIG_COMMAND_PAYLOAD".repeat(200)}` }),
							events.assistantMessage("Done after noisy stream"),
						],
					},
				],
			});

			const id = `async-noisy-events-${Date.now().toString(36)}`;
			const asyncDir = path.join(ASYNC_DIR, id);
			const sessionRoot = path.join(tempDir, "sessions");

			executeAsyncSingle(id, {
				agent: "worker",
				task: "Stream noisy diagnostics",
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

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "Done after noisy stream");

			const eventsText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
			assert.doesNotMatch(eventsText, /"type":"message_update"/);
			assert.doesNotMatch(eventsText, /NOISY_PARTIAL_/);
			assert.doesNotMatch(eventsText, /BIG_COMMAND_PAYLOAD/);
			assert.match(eventsText, /"type":"subagent\.events\.truncated"/);
			assert.match(eventsText, /"droppedEventType":"tool_execution_start"/);
		} finally {
			if (previousMaxBytes === undefined) delete process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES;
			else process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES = previousMaxBytes;
		}
	});

	it("background runs stream child events and live output while active", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ delay: 200, jsonl: [events.toolStart("bash", { command: "ls" })] },
				{ delay: 600, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "file-a\nfile-b")] },
				{ delay: 600, jsonl: [events.assistantMessage("Done streaming")], stderr: "warning: mock stderr\n" },
			],
		});

		const id = `async-stream-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const outputPath = path.join(asyncDir, "output-0.log");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Stream detailed progress",
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

		const liveDeadline = Date.now() + 10_000;
		let sawChildEvent = false;
		let sawLiveOutput = false;
		while (Date.now() < liveDeadline && (!sawChildEvent || !sawLiveOutput)) {
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, "utf-8");
				sawChildEvent = content.includes('"type":"tool_execution_start"')
					&& content.includes('"subagentSource":"child"');
			}
			if (fs.existsSync(outputPath)) {
				const content = fs.readFileSync(outputPath, "utf-8");
				sawLiveOutput = content.includes("bash: ls") || content.includes("file-a") || content.includes("warning: mock stderr");
			}
			if (sawChildEvent && sawLiveOutput) break;
			assert.equal(fs.existsSync(resultPath), false, "run finished before live observability was written");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.equal(sawChildEvent, true, "expected child JSON events to be streamed into events.jsonl");
		assert.equal(sawLiveOutput, true, "expected output-0.log to receive live child output");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].output, "Done streaming");

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.deepEqual(status.steps[0].recentTools.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })), [{ tool: "bash", args: "ls" }]);
		assert.deepEqual(status.steps[0].recentOutput, ["file-a", "file-b", "Done streaming"]);
	});
});
