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

describe("async execution utilities — chain & dynamic fanout", { skip: !available ? "pi packages not available" : undefined }, () => {
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

	it("top-level async parallel conversion preserves output, reads, and progress", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Async top-level report" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker", { defaultProgress: true })] }),
		});

		const result = await executor.execute(
			"async-parallel-fields",
			{
				tasks: [{ agent: "worker", task: "Do async work", output: "async-top-output.md", reads: ["input.md"] }],
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
		const statusPath = path.join(ASYNC_DIR, asyncId, "status.json");
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.mode, "parallel");
			assert.equal(payload.sessionId, "session-123");
			assert.equal(payload.results[0]?.acceptance?.status, "checked");
			assert.equal(status.sessionId, "session-123");
			assert.equal(status.steps?.[0]?.acceptance?.status, "checked");
		const outputPath = path.join(tempDir, ".pi-subagents", "artifacts", "outputs", asyncId, "async-top-output.md");
		const outputDeadline = Date.now() + 5_000;
		while (!fs.existsSync(outputPath)) {
			if (Date.now() > outputDeadline) {
				assert.fail(`Timed out waiting for saved output file: ${outputPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Async top-level report");
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		const taskArg = args.at(-1) ?? "";
		const progressPath = path.join(tempDir, ".pi-subagents", "artifacts", "progress", asyncId, "progress.md");
		assert.ok(taskArg.includes(`[Read from: ${path.join(tempDir, "input.md")}]`));
		assert.ok(taskArg.includes(`Update progress at: ${progressPath}`));
		assert.ok(taskArg.includes(`Write your findings to exactly this path: ${outputPath}`));
		assert.equal(fs.existsSync(progressPath), true);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("async single rejects explicit reviewed acceptance without a reviewer result", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
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
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const id = `async-acceptance-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement acceptance-covered fix",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-acceptance" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: { level: "reviewed", criteria: ["Patch bug"], review: false },
		});
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;

		assert.equal(result.success, false);
		assert.equal(result.results[0]?.acceptance?.status, "rejected");
		assert.ok(result.results[0]?.acceptance?.childReport);
		assert.equal(result.results[0]?.acceptance?.reviewResult?.status, "needs-parent-decision");
		assert.equal(status.steps?.[0]?.acceptance?.status, "rejected");
	});

	it("top-level async chain suppresses progress for {task} review-only tasks", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Async review" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("reviewer", { defaultProgress: true })] }),
		});

		const result = await executor.execute(
			"async-chain-read-only-progress",
			{
				chain: [{ agent: "reviewer" }],
				task: "Review-only. Do not edit files. Return findings.",
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		assert.doesNotMatch(args.at(-1) ?? "", /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("async chains reject malformed named output references before spawning", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-malformed-output-ref-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "consumer", task: "Use {outputs.bad-name}" }],
			agents: [makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-malformed" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Invalid chain output reference '\{outputs\.bad-name\}'/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("async chains persist structured outputs, named outputs, and graph labels", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const schema = {
			type: "object",
			required: ["value"],
			properties: { value: { type: "string" } },
		};
		mockPi.onCall({ structuredOutput: { value: "Alpha structured" } });
		mockPi.onCall({ output: "used named output" });
		const id = `async-structured-chain-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{
					agent: "producer",
					task: "Produce data",
					phase: "Collect",
					label: "Produce structured data",
					as: "data",
					outputSchema: schema,
				},
				{ agent: "consumer", task: "Use {outputs.data}", phase: "Use", label: "Consume data" },
			],
			agents: [makeAgent("producer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-structured" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.deepEqual(payload.results[0]?.structuredOutput, { value: "Alpha structured" });
		assert.deepEqual(payload.outputs?.data?.structured, { value: "Alpha structured" });
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Alpha structured/);
		assert.equal(status.steps?.[0]?.label, "Produce structured data");
		assert.equal(status.steps?.[0]?.phase, "Collect");
		assert.equal(status.steps?.[0]?.outputName, "data");
		assert.equal(status.steps?.[0]?.structured, true);
		assert.equal(payload.workflowGraph?.nodes?.[0]?.label, "Produce structured data");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.outputName, "data");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
	});

	it("async chains can start parallel, funnel into one step, then fan back out", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ matchArgIncludes: "Scout API", output: "Scout A async findings" });
		mockPi.onCall({ matchArgIncludes: "Scout UI", output: "Scout B async findings" });
		mockPi.onCall({ matchArgIncludes: "Synthesize:", output: "Async funnel synthesis" });
		mockPi.onCall({ matchArgIncludes: "Review funnel A:", output: "Async reviewer A done" });
		mockPi.onCall({ matchArgIncludes: "Review funnel B:", output: "Async reviewer B done" });
		const id = `async-parallel-funnel-fanout-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{
					parallel: [
						{ agent: "scout-a", task: "Scout API" },
						{ agent: "scout-b", task: "Scout UI" },
					],
					concurrency: 2,
				},
				{ agent: "synthesizer", task: "Synthesize:\n{previous}" },
				{
					parallel: [
						{ agent: "review-a", task: "Review funnel A:\n{previous}" },
						{ agent: "review-b", task: "Review funnel B:\n{previous}" },
					],
					concurrency: 2,
				},
			],
			agents: [makeAgent("scout-a"), makeAgent("scout-b"), makeAgent("synthesizer"), makeAgent("review-a"), makeAgent("review-b")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-parallel-funnel-fanout" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError, `should launch: ${JSON.stringify(result.content)}`);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results.map((entry) => entry.output), [
			"Scout A async findings",
			"Scout B async findings",
			"Async funnel synthesis",
			"Async reviewer A done",
			"Async reviewer B done",
		]);
		assert.deepEqual(status.steps?.map((step) => step.status), ["complete", "complete", "complete", "complete", "complete"]);
		assert.deepEqual(status.parallelGroups, [
			{ start: 0, count: 2, stepIndex: 0 },
			{ start: 3, count: 2, stepIndex: 2 },
		]);
		const funnelTask = readMockPiArgsMatching(mockPi, "Synthesize:").at(-1) ?? "";
		assert.match(funnelTask, /=== Parallel Task 1 \(scout-a\) ===/);
		assert.match(funnelTask, /Scout A async findings/);
		assert.match(funnelTask, /=== Parallel Task 2 \(scout-b\) ===/);
		assert.match(funnelTask, /Scout B async findings/);
		assert.match(readMockPiArgsMatching(mockPi, "Review funnel A:").at(-1) ?? "", /Review funnel A:\nAsync funnel synthesis/);
		assert.match(readMockPiArgsMatching(mockPi, "Review funnel B:").at(-1) ?? "", /Review funnel B:\nAsync funnel synthesis/);
		assert.equal(payload.workflowGraph?.nodes?.[0]?.kind, "parallel-group");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.kind, "step");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[2]?.kind, "parallel-group");
		assert.equal(payload.workflowGraph?.nodes?.[2]?.status, "completed");
	});

	it("async dynamic status shows a placeholder before materialization", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 800, output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "used reviews" });
		const id = `async-dynamic-placeholder-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", label: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-placeholder" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const statusPath = path.join(ASYNC_DIR, id, "status.json");
		const deadline = Date.now() + 5_000;
		let status: AsyncStatusPayload | undefined;
		while (!status) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async status file: ${statusPath}`);
			if (fs.existsSync(statusPath)) status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			else await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.deepEqual(status.steps?.map((step) => step.agent), ["producer", "expand:reviewer", "consumer"]);
		assert.equal(status.steps?.[1]?.label, "Review {target.path}");
		assert.equal(status.steps?.[1]?.outputName, "reviews");
		assert.deepEqual(status.parallelGroups, [{ start: 1, count: 1, stepIndex: 1 }]);

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const finalStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(finalStatus.steps?.map((step) => step.agent), ["producer", "reviewer", "reviewer", "consumer"]);
		assert.deepEqual(finalStatus.parallelGroups, [{ start: 1, count: 2, stepIndex: 1 }]);
	});

	it("async chains expand dynamic fanout and persist collected output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "used reviews" });
		const id = `async-dynamic-chain-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: {
						agent: "reviewer",
						task: "Review {target.path}",
						label: "Review {target.path}",
						outputSchema: { type: "object" },
				},
				collect: { as: "reviews" },
				concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, true);
		assert.equal(mockPi.callCount(), 4);
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Review src\/a\.ts/);
		assert.match(readMockPiArgs(mockPi, 2).at(-1) ?? "", /Review src\/b\.ts/);
		assert.match(readMockPiArgs(mockPi, 3).at(-1) ?? "", /"key":"src\/a\.ts"/);
		const collected = payload.outputs?.reviews?.structured as Array<{ key: string; structured: unknown }>;
		assert.deepEqual(collected.map((item) => item.key), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(collected.map((item) => item.structured), [{ ok: "a" }, { ok: "b" }]);
		assert.equal(status.steps?.length, 4);
		assert.deepEqual(status.parallelGroups, [{ start: 1, count: 2, stepIndex: 1 }]);
		assert.equal(payload.workflowGraph?.nodes?.[1]?.kind, "dynamic-parallel-group");
		assert.deepEqual(payload.workflowGraph?.nodes?.[1]?.children?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
		assert.equal(payload.workflowGraph?.nodes?.[2]?.flatIndex, 3);
	});

	it("async dynamic fanout applies fork session files and thinking overrides to materialized children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		const id = `async-dynamic-fork-thinking-${Date.now().toString(36)}`;
		const sessionA = path.join(tempDir, "dynamic-a.jsonl");
		const sessionB = path.join(tempDir, "dynamic-b.jsonl");
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
					parallel: {
						agent: "reviewer",
						task: "Review {target.path}",
						label: "Review {target.path}",
						outputSchema: { type: "object" },
					},
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer", { model: "anthropic/claude-sonnet-4-5:high", thinking: "high" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionFilesByFlatIndex: [undefined, sessionA, sessionB],
			thinkingOverridesByFlatIndex: [undefined, "off", "off"],
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		const firstDynamicArgs = readMockPiArgs(mockPi, 1);
		const secondDynamicArgs = readMockPiArgs(mockPi, 2);
		assert.equal(payload.success, true);
		assert.equal(firstDynamicArgs[firstDynamicArgs.indexOf("--session") + 1], sessionA);
		assert.equal(secondDynamicArgs[secondDynamicArgs.indexOf("--session") + 1], sessionB);
		assert.equal(firstDynamicArgs[firstDynamicArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5:off");
		assert.equal(secondDynamicArgs[secondDynamicArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5:off");
		assert.deepEqual(status.steps?.slice(1).map((step) => step.sessionFile), [sessionA, sessionB]);
		assert.deepEqual(status.steps?.slice(1).map((step) => step.thinking), ["off", "off"]);
	});

});
