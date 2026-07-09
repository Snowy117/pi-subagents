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


	it("treats forced drain after final assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "done-before-drain");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("treats forced drain after empty terminal assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "mock/test-model",
					stopReason: "stop",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after empty terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "completed");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("keeps explicit assistant errors as failures during final-drain cleanup", async () => {
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
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "provider exploded");
		assert.equal(result.progress.status, "failed");
	});

	it("handles abort signal (completes faster than delay)", async () => {
		mockPi.onCall({ delay: 10000 }); // Long delay — process should be killed before this
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			signal: controller.signal,
		});
		const elapsed = Date.now() - start;

		// The key assertion: the run should complete much faster than the 10s delay,
		// proving the abort signal terminated the process early.
		assert.ok(elapsed < 5000, `should abort early, took ${elapsed}ms`);
		// Exit code is platform-dependent (Windows: often 1 or 0, Linux: null/143)
	});

	it("marks foreground runs that exceed timeoutMs as timed out", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			timeoutMs: 150,
		});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should time out early, took ${elapsed}ms`);
		assert.notEqual(result.exitCode, 0);
		assert.equal(result.timedOut, true);
		assert.equal(result.error, "Subagent timed out after 150ms.");
		assert.match(result.finalOutput ?? "", /Subagent timed out after 150ms\./);
		assert.equal(result.progress.status, "failed");
	});

	it("allows a foreground run to finish on the final turn-budget grace turn", async () => {
		mockPi.onCall({
			jsonl: [
				mockAssistantMessage("working before wrap-up", "tool_use"),
				mockAssistantMessage("final wrapped output", "stop"),
			],
		});
		const agents = makeAgentConfigs(["worker"]);

		const result = await runSync(tempDir, agents, "worker", "Use the final grace turn to wrap up.", {
			turnBudget: { maxTurns: 1, graceTurns: 1 },
			runId: "foreground-turn-budget-soft",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.turnBudgetExceeded, undefined);
		assert.equal(result.wrapUpRequested, true);
		assert.equal(result.turnBudget?.outcome, "wrap-up-requested");
		assert.equal(result.turnBudget?.turnCount, 2);
		assert.match(result.finalOutput ?? "", /Turn budget wrap-up was requested after 1 assistant turn/);
		assert.match(result.finalOutput ?? "", /final wrapped output/);
	});

	it("does not run acceptance verification after a foreground timeout", async () => {
		const markerPath = path.join(tempDir, "verify-ran.txt");
		const report = [
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
			}),
			"```",
		].join("\n");
		mockPi.onCall({ jsonl: [events.assistantMessage(report)], keepAliveAfterFinalMessageMs: 10000 });
		const agents = makeAgentConfigs(["slow"]);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			timeoutMs: 150,
			acceptance: {
				level: "verified",
				verify: [{
					id: "marker",
					command: "node -e \"require('node:fs').writeFileSync(process.env.VERIFY_MARKER, 'ran')\"",
					env: { VERIFY_MARKER: markerPath },
					timeoutMs: 10_000,
				}],
			},
		});

		assert.equal(result.timedOut, true);
		assert.equal(result.acceptance?.status, "rejected");
		assert.equal(result.acceptance?.runtimeChecks?.[0]?.id, "timeout");
		assert.equal(result.acceptance?.verifyRuns?.length, 0);
		assert.equal(fs.existsSync(markerPath), false);
	});

	it("soft-interrupts the current turn and returns a paused result", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();
		const controlEvents: Array<{ type?: string; to?: string }> = [];

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "interrupt-run",
			interruptSignal: controller.signal,
			onControlEvent: (event: { type?: string; to?: string }) => {
				controlEvents.push(event);
			},
		});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should interrupt early, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.progress.activityState, undefined);
		assert.deepEqual(controlEvents, []);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});

	it("preserves manual interrupt semantics when a timeout is also configured", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		setTimeout(() => controller.abort(), 100);
		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			interruptSignal: controller.signal,
			timeoutMs: 500,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.timedOut, undefined);
		assert.equal(result.error, undefined);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});

	for (const toolName of ["intercom", "contact_supervisor"]) {
		it(`detaches cleanly on ${toolName} handoff without aborting the child process`, async () => {
			const eventBus = createEventBus();
			let accepted = false;
			eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
				if (!payload || typeof payload !== "object") return;
				accepted = (payload as { accepted?: unknown }).accepted === true;
			});
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(toolName, toolName === "intercom" ? { action: "ask", to: "orchestrator" } : { reason: "need_decision", message: "Need a decision" })] },
					{ delay: 1000, jsonl: [events.assistantMessage("received pong")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			// Emit the detach request the moment we observe the coordination tool start
			// in a progress update — this is the signal the parent has set
			// `intercomStarted=true`. Using a fixed delay here races the mock's
			// cold spawn and flakes under load.
			let detachEmitted = false;
			const runPromise = runSync(tempDir, agents, "echo", "Task", {
				runId: `${toolName}-detach`,
				allowIntercomDetach: true,
				intercomEvents: eventBus,
				onUpdate: (update) => {
					if (detachEmitted) return;
					const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
					const sawCoordinationTool = Array.isArray(progress) && progress.some((p) => p?.currentTool === toolName);
					if (!sawCoordinationTool) return;
					detachEmitted = true;
					eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "test-request" });
				},
			});

			const result = await runPromise;

			assert.equal(result.exitCode, -2);
			assert.equal(result.detached, true);
			assert.equal(result.detachedReason, "intercom coordination");
			assert.equal(result.finalOutput, "Detached for intercom coordination before task completion.");
			assert.equal(result.progress?.status, "detached");
			assert.equal(accepted, true);
		});
	}

	it("does not save a detached placeholder to an explicit file-only output", async () => {
		const eventBus = createEventBus();
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const outputPath = path.join(tempDir, "detached-output.md");
		let detachEmitted = false;

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "detached-file-only-output",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			outputPath,
			outputMode: "file-only",
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((p) => p?.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "file-only-detach" });
			},
		});

		assert.equal(result.exitCode, -2);
		assert.equal(result.detached, true);
		assert.equal(result.savedOutputPath, undefined);
		assert.equal(fs.existsSync(outputPath), false);
		assert.match(result.outputSaveError ?? "", /not finalized/);
	});

	it("finalizes explicit output before reporting detached child post-exit success", async () => {
		const eventBus = createEventBus();
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 100, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const outputPath = path.join(tempDir, "detached-final-output.md");
		let detachEmitted = false;

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "detached-file-only-post-exit-output",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			outputPath,
			outputMode: "file-only",
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((p) => p?.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "file-only-post-exit-detach" });
			},
		});

		assert.equal(result.exitCode, -2);
		assert.equal(result.detached, true);
		assert.equal(fs.existsSync(outputPath), false);

		for (let attempt = 0; attempt < 100 && !fs.existsSync(outputPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		assert.equal(fs.readFileSync(outputPath, "utf-8"), "after reply");
		assert.equal(result.exitCode, 0);
		assert.equal(result.progress?.status, "completed");
		assert.equal(result.savedOutputPath, outputPath);
		assert.equal(result.outputSaveError, undefined);
		assert.match(result.finalOutput ?? "", /^Output saved to:/);
	});

	it("aborts a foreground coordination tool start instead of detaching without a delivered handoff", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 10000, jsonl: [events.assistantMessage("after abort")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controller = new AbortController();
		let aborted = false;

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "contact-supervisor-abort-without-handoff",
			allowIntercomDetach: true,
			signal: controller.signal,
			onUpdate: (update) => {
				if (aborted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((p) => p?.currentTool === "contact_supervisor")) return;
				aborted = true;
				controller.abort();
			},
		});

		assert.equal(aborted, true);
		assert.notEqual(result.exitCode, -2);
		assert.equal(result.detached, undefined);
		assert.notEqual(result.progress?.status, "detached");
	});

	for (const testCase of [
		{ name: "intercom ask", toolName: "intercom", args: { action: "ask", to: "orchestrator" } },
		{ name: "contact_supervisor need_decision", toolName: "contact_supervisor", args: { reason: "need_decision", message: "Need a decision" } },
		{ name: "contact_supervisor interview_request", toolName: "contact_supervisor", args: { reason: "interview_request", message: "Need input", interview: { questions: [] } } },
	]) {
		it(`does not detach foreground children on blocking ${testCase.name} before a delivered handoff`, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
					{ delay: 50, jsonl: [events.assistantMessage("received pong")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: `${testCase.toolName}-blocking-detach`,
				allowIntercomDetach: true,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.detached, undefined);
			assert.equal(result.finalOutput, "received pong");
			assert.equal(result.progress?.status, "completed");
		});
	}

	for (const testCase of [
		{ name: "intercom send", toolName: "intercom", args: { action: "send", to: "orchestrator", message: "FYI" } },
		{ name: "contact_supervisor progress_update", toolName: "contact_supervisor", args: { reason: "progress_update", message: "FYI" } },
	]) {
		it(`does not proactively detach foreground children on non-blocking ${testCase.name}`, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
					{ jsonl: [events.toolEnd(testCase.toolName)] },
					{ jsonl: [events.assistantMessage("done")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: `${testCase.toolName}-nonblocking`,
				allowIntercomDetach: true,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.detached, undefined);
			assert.equal(result.finalOutput, "done");
			assert.equal(result.progress?.status, "completed");
		});
	}

});
