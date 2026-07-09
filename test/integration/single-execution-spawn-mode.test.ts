import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeAgentConfigs, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT } from "../../src/shared/types.ts";
import {
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { available, createSubagentExecutor, escapeRegExp, getFinalOutput, mockAssistantMessage, runSync, writePackageSkill } from "../support/single-execution-harness.ts";
import type { ArtifactPaths, ModelAttempt, MockPiCallRecord, ProgressSummary, RunSyncResult } from "../support/single-execution-harness.ts";

describe("single sync execution", { skip: !available ? "pi packages not available" : undefined }, () => {
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

	function readCall(): { args: string[]; systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]> } {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return { args: payload.args, systemPrompts: payload.systemPrompts ?? [] };
	}

	function readCallArgs(): string[] {
		return readCall().args;
	}

	function makeExecutor(agents = [makeAgent("echo")], config: Record<string, unknown> = {}) {
		return createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config,
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
	}


	it("spawns agent and captures output", async () => {
		mockPi.onCall({ output: "Hello from mock agent" });
		const agents = makeAgentConfigs(["echo"]);

		const sessionFile = path.join(tempDir, "child-session.jsonl");
		const result = await runSync(tempDir, agents, "echo", "Say hello", { sessionFile });

		assert.equal(result.exitCode, 0);
		assert.equal(result.agent, "echo");
		assert.equal(result.sessionFile, sessionFile);
		assert.ok(result.messages.length > 0, "should have messages");

		const output = getFinalOutput(result.messages);
		assert.equal(output, "Hello from mock agent");
	});

	it("treats action='single' with execution fields as single execution", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "single alias finished" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-alias",
			{ action: "single", agent: "echo", task: "Run through alias" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /single alias finished/);
	});

	it("rejects unknown action strings at runtime", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"unknown-action",
			{ action: "not-a-real-action" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Unknown action: not-a-real-action/);
		assert.match(result.content[0]?.text ?? "", /Valid:/);
	});

	it("rejects duplicate concurrent subagent execution calls", async () => {
		mockPi.onCall({ output: "first call completed", delay: 100 });
		const executor = makeExecutor([makeAgent("echo")]);
		const ctx = makeMinimalCtx(tempDir);

		const first = executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const second = await executor.execute("second", { agent: "echo", task: "Duplicate call" }, new AbortController().signal, undefined, ctx);
		const firstResult = await first;

		assert.equal(firstResult.isError, undefined);
		assert.equal(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /Issue exactly ONE subagent call per turn/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("blocks total subagent spawns after the per-session quota", async () => {
		mockPi.onCall({ output: "first call completed" });
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 1 });
		const ctx = makeMinimalCtx(tempDir);

		const first = await executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const second = await executor.execute("second", { agent: "echo", task: "Second call" }, new AbortController().signal, undefined, ctx);

		assert.equal(first.isError, undefined);
		assert.equal(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /Subagent spawn limit reached for this session \(1\/1 used, 1 requested\)/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("allows management actions while an execution call is in progress", async () => {
		mockPi.onCall({ output: "first call completed", delay: 100 });
		const executor = makeExecutor([makeAgent("echo")]);
		const ctx = makeMinimalCtx(tempDir);

		const first = executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const status = await executor.execute("status", { action: "status" }, new AbortController().signal, undefined, ctx);
		const firstResult = await first;

		assert.equal(firstResult.isError, undefined);
		assert.equal(status.isError, undefined);
		assert.doesNotMatch(status.content[0]?.text ?? "", /Rejected: a subagent call is already in progress/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("allows intentional parallel tasks inside one subagent execution call", async () => {
		mockPi.onCall({ output: "first parallel result" });
		mockPi.onCall({ output: "second parallel result" });
		const executor = makeExecutor([makeAgent("echo"), makeAgent("second")]);

		const result = await executor.execute(
			"parallel",
			{ tasks: [{ agent: "echo", task: "First task" }, { agent: "second", task: "Second task" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual(result.details?.totalCost, { inputTokens: 200, outputTokens: 100, costUsd: 0.002 });
	});

	it("reports total cost for foreground single runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "single result" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-cost",
			{ agent: "echo", task: "Single task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details?.totalCost, { inputTokens: 100, outputTokens: 50, costUsd: 0.001 });
	});

	it("fails implementation runs that complete without mutation attempts", async () => {
		mockPi.onCall({ output: "Validation:\nlet rawFilename = params.filename.trim();" });
		const agents = [makeAgent("worker")];
		const controlEvents: Array<{ message: string }> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-run",
			onControlEvent: (event: { message: string }) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
		assert.equal(result.finalOutput, "Validation:\nlet rawFilename = params.filename.trim();");
		assert.equal(result.progress.status, "failed");
		assert.deepEqual(controlEvents.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
		assert.deepEqual(result.controlEvents?.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
	});

	it("returns captured output when the foreground executor fails an implementation run", async () => {
		mockPi.onCall({ output: "Oracle review:\n- finding one\n- finding two" });
		const executor = makeExecutor([makeAgent("oracle")]);

		const result = await executor.execute(
			"failed-single-output",
			{ agent: "oracle", task: "Implement the approved file changes" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, true);
		assert.match(text, /completed without making edits/);
		assert.match(text, /Output:\nOracle review:\n- finding one\n- finding two/);
		assert.match(text, /Output artifact: /);
	});

	it("fails future-tense implementation summaries when no mutation attempt occurred", async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "guard-future-tense",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
	});

	it("allows declared read-only agents to mention implementation words without edits", async () => {
		mockPi.onCall({ output: "Validation report after the patch" });
		const agents = [makeAgent("architect", { tools: ["read", "grep", "find", "ls"] })];

		const result = await runSync(tempDir, agents, "architect", "Produce a proposal that implements the approved fix", {
			runId: "guard-readonly-tools",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Validation report after the patch");
	});

	it("keeps bash-enabled implementation tasks conservative unless completion guard is disabled", async () => {
		mockPi.onCall({ output: "cold start test after patch" });
		mockPi.onCall({ output: "cold start test after patch" });
		const agents = [
			makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"] }),
			makeAgent("test-runner-optout", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
		];

		const withoutOptOut = await runSync(tempDir, agents, "test-runner", "Patch the cold start test", {
			runId: "guard-bash-conservative",
		});
		assert.equal(withoutOptOut.exitCode, 1);
		assert.match(withoutOptOut.error ?? "", /completed without making edits/);

		const withOptOut = await runSync(tempDir, agents, "test-runner-optout", "Patch the cold start test", {
			runId: "guard-bash-optout",
		});
		assert.equal(withOptOut.exitCode, 0);
		assert.equal(withOptOut.progress.status, "completed");
	});

	it("allows implementation runs when parsed messages include a real edit tool call", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "edit", arguments: { path: "src/file.ts", oldText: "a", newText: "b" } }],
						model: "mock/test-model",
						stopReason: "toolUse",
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
				events.assistantMessage("Applied edit"),
			],
		});
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-success",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Applied edit");
	});

	it("returns error for unknown agent", async () => {
		const agents = makeAgentConfigs(["echo"]);
		const result = await runSync(tempDir, agents, "nonexistent", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Unknown agent"));
	});


	it("emits an active-long-running notice after the turn threshold", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-active",
			controlConfig: { enabled: true, activeNoticeAfterTurns: 2, activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 999_999, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(controlEvents.length, 1);
		assert.equal(controlEvents[0]?.type, "active_long_running");
		assert.equal(controlEvents[0]?.reason, "turn_threshold");
		assert.equal(controlEvents[0]?.turns, 2);
		assert.equal(result.controlEvents?.[0]?.type, "active_long_running");
		assert.equal(result.progress.activityState, "active_long_running");
	});

	it("escalates repeated mutating tool failures to needs attention", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.assistantMessage("I need to retry the same edit."),
			],
		});
		const agents = [makeAgent("worker")];
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "run-failures",
			controlConfig: { enabled: true, failedToolAttemptsBeforeAttention: 3, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		const failureEvent = controlEvents.find((event) => event.reason === "tool_failures");
		assert.equal(failureEvent?.type, "needs_attention");
		assert.equal(failureEvent?.currentPath, "src/runs/background/async-status.ts");
		assert.match(failureEvent?.recentFailureSummary ?? "", /No exact match/);
		assert.equal(result.progress.activityState, "needs_attention");
	});

	it("does not surface control state or events when control is disabled", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-control-disabled",
			controlConfig: { enabled: false, activeNoticeAfterTurns: 1, activeNoticeAfterMs: 1, activeNoticeAfterTokens: 1, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.activityState, undefined);
		assert.equal(result.controlEvents, undefined);
		assert.equal(controlEvents.length, 0);
	});

	it("captures non-zero exit code", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Something went wrong" });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Something went wrong"));
	});

	it("handles long tasks via temp file (ENAMETOOLONG prevention)", async () => {
		mockPi.onCall({ output: "Got it" });
		const longTask = "Analyze ".repeat(2000); // ~16KB
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", longTask, {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.equal(output, "Got it");
	});

	it("uses agent model config", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
		// result.model is set from agent config via applyThinkingSuffix, then
		// overwritten by the first message_end event only if result.model is unset.
		// Since agent has model config, it stays as the configured value.
		assert.equal(result.model, "anthropic/claude-sonnet-4");
	});

	it("model override from options takes precedence", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			modelOverride: "openai/gpt-4o",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "openai/gpt-4o");
	});

	it("prefers the parent session provider for ambiguous bare model ids", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			preferredModelProvider: "github-copilot",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("tracks usage from message events", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 100); // from mock
		assert.equal(result.usage.output, 50); // from mock
	});

});
