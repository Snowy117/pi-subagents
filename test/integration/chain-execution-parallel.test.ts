import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";
import { INTERCOM_DETACH_REQUEST_EVENT } from "../../src/shared/types.ts";
import { available, executeChain } from "../support/chain-execution-harness.ts";
import type { ChainExecutionResult, ChainResultItem, TestChainStep } from "../support/chain-execution-harness.ts";

describe("chain execution — parallel steps", { skip: !available ? "pi packages not available" : undefined }, () => {
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
			artifactsDir: path.join(tempDir, "artifacts"),
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

	function readCallArgsMatching(text: string): string[] {
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		for (const callFile of callFiles) {
			const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
			if (args.join("\n").includes(text)) return args;
		}
		assert.fail(`expected recorded call containing ${text}`);
	}


	it("runs parallel tasks within a chain step", async () => {
		mockPi.onCall({ output: "Parallel task done" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review auth module" },
							{ agent: "reviewer-b", task: "Review data layer" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
	});

	it("aggregates parallel outputs for next sequential step", async () => {
		mockPi.onCall({ output: "Review findings here" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b"), makeAgent("synthesizer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review security" },
							{ agent: "reviewer-b", task: "Review performance" },
						],
					},
					{ agent: "synthesizer" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 3);
		const synthTask = result.details.results[2].task;
		assert.ok(
			synthTask.includes("=== Parallel Task 1 (reviewer-a) ==="),
			"synthesizer should include reviewer-a output block",
		);
		assert.ok(
			synthTask.includes("=== Parallel Task 2 (reviewer-b) ==="),
			"synthesizer should include reviewer-b output block",
		);
	});

	it("passes completed parallel task outputs to later {outputs.name} references", async () => {
		mockPi.onCall({ matchArgIncludes: "Alpha", output: "Alpha named output" });
		mockPi.onCall({ matchArgIncludes: "Beta", output: "Beta named output" });
		mockPi.onCall({ output: "Final" });
		const agents = [makeAgent("alpha"), makeAgent("beta"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "alpha", task: "Alpha", as: "alphaOutput" },
							{ agent: "beta", task: "Beta", as: "betaOutput" },
						],
					},
					{ agent: "writer", task: "Use {outputs.alphaOutput} and {outputs.betaOutput}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		const finalTask = readCallArgs(2).at(-1) ?? "";
		assert.match(finalTask, /Alpha named output/);
		assert.match(finalTask, /Beta named output/);
	});

	it("funnels an initial parallel step through one agent, then fans the funnel output back out", async () => {
		mockPi.onCall({ matchArgIncludes: "Scout API", output: "Scout A findings" });
		mockPi.onCall({ matchArgIncludes: "Scout UI", output: "Scout B findings" });
		mockPi.onCall({ matchArgIncludes: "Synthesize:", output: "Funnel synthesis" });
		mockPi.onCall({ matchArgIncludes: "Review funnel A:", output: "Reviewer A done" });
		mockPi.onCall({ matchArgIncludes: "Review funnel B:", output: "Reviewer B done" });
		const agents = [makeAgent("scout-a"), makeAgent("scout-b"), makeAgent("synthesizer"), makeAgent("review-a"), makeAgent("review-b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "scout-a", task: "Scout API" },
							{ agent: "scout-b", task: "Scout UI" },
						],
					},
					{ agent: "synthesizer", task: "Synthesize:\n{previous}" },
					{
						parallel: [
							{ agent: "review-a", task: "Review funnel A:\n{previous}" },
							{ agent: "review-b", task: "Review funnel B:\n{previous}" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(result.details.results.map((entry) => entry.agent), ["scout-a", "scout-b", "synthesizer", "review-a", "review-b"]);
		assert.equal(result.details.totalSteps, 3);
		const funnelTask = readCallArgsMatching("Synthesize:").at(-1) ?? "";
		assert.match(funnelTask, /=== Parallel Task 1 \(scout-a\) ===/);
		assert.match(funnelTask, /Scout A findings/);
		assert.match(funnelTask, /=== Parallel Task 2 \(scout-b\) ===/);
		assert.match(funnelTask, /Scout B findings/);
		const fanoutTaskA = readCallArgsMatching("Review funnel A:").at(-1) ?? "";
		const fanoutTaskB = readCallArgsMatching("Review funnel B:").at(-1) ?? "";
		assert.match(fanoutTaskA, /Review funnel A:\nFunnel synthesis/);
		assert.match(fanoutTaskB, /Review funnel B:\nFunnel synthesis/);
		assert.equal(result.details.workflowGraph?.nodes[0]?.kind, "parallel-group");
		assert.equal(result.details.workflowGraph?.nodes[1]?.kind, "step");
		assert.equal(result.details.workflowGraph?.nodes[2]?.kind, "parallel-group");
	});

	it("aggregates file-only parallel outputs as file references for the next step", async () => {
		mockPi.onCall({ output: "full parallel chain output\nwith details" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b"), makeAgent("synthesizer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review A", output: "a.md", outputMode: "file-only" },
							{ agent: "reviewer-b", task: "Review B", output: "b.md", outputMode: "file-only" },
						],
					},
					{ agent: "synthesizer" },
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.doesNotMatch(result.details.results[0]?.finalOutput ?? "", /full parallel chain output/);
		assert.doesNotMatch(result.details.results[1]?.finalOutput ?? "", /full parallel chain output/);
		const synthTaskArg = readCallArgs(2).at(-1) ?? "";
		assert.match(synthTaskArg, /Output saved to:/);
		assert.match(synthTaskArg, /2 lines/);
		assert.doesNotMatch(synthTaskArg, /full parallel chain output/);
	});

	it("rejects chain parallel file-only output without spawning siblings", async () => {
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b")];

		const result = await executeChain(
			makeChainParams(
				[{
					parallel: [
						{ agent: "reviewer-a", task: "Review A", outputMode: "file-only" },
						{ agent: "reviewer-b", task: "Review B", output: "b.md" },
					],
				}],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("detaches parallel chain children cleanly on intercom handoff", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after handoff")] },
			],
		});
		mockPi.onCall({ output: "Other task done" });
		const agents = [
			makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("b", { systemPrompt: "Intercom orchestration channel:" }),
		];
		const intercomEvents = createEventBus();
		let detachEmitted = false;

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Send handoff" },
							{ agent: "b", task: "Keep working" },
						],
					},
				],
				agents,
				{
					intercomEvents,
					onUpdate(update: { details?: { progress?: Array<{ currentTool?: string }> } }) {
						if (detachEmitted) return;
						if (!update.details?.progress?.some((entry) => entry.currentTool === "intercom")) return;
						detachEmitted = true;
						intercomEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-parallel-detach" });
					},
				},
			),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /resume/);
		assert.equal(detachEmitted, true);
		assert.equal(result.details.results.some((entry) => entry.detached === true && entry.exitCode === -2), true);
	});

	it("stops a sequential chain when a child detaches for intercom coordination", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const agents = [
			makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("b"),
		];
		const intercomEvents = createEventBus();
		let detachEmitted = false;

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "a", task: "Ask supervisor" },
					{ agent: "b", task: "Must not run yet" },
				],
				agents,
				{
					intercomEvents,
					onUpdate(update: { details?: { progress?: Array<{ currentTool?: string }> } }) {
						if (detachEmitted) return;
						if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
						detachEmitted = true;
						intercomEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-sequential-detach" });
					},
				},
			),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /resume/);
		assert.equal(detachEmitted, true);
		assert.equal(mockPi.callCount(), 1);
	});

	it("fails chain on parallel step failure", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Parallel task failed" });
		const agents = [makeAgent("a"), makeAgent("b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail when parallel step fails");
	});

	it("rejects worktree parallel steps that set a different task cwd", async () => {
		const agents = [makeAgent("a"), makeAgent("b")];
		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B", cwd: path.join(tempDir, "other") },
						],
						worktree: true,
					},
				],
				agents,
			),
		);

		assert.ok(result.isError, "chain should reject conflicting task cwd under worktree");
		assert.match(result.content[0]?.text ?? "", /worktree isolation uses the shared cwd/i);
		assert.match(result.content[0]?.text ?? "", /task 2 \(b\) sets cwd/i);
	});

	it("sequential → parallel → sequential (mixed chain)", async () => {
		mockPi.onCall({ output: "Step complete" });
		const agents = [makeAgent("scout"), makeAgent("rev-a"), makeAgent("rev-b"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Initial scan" },
					{
						parallel: [
							{ agent: "rev-a", task: "Deep review A" },
							{ agent: "rev-b", task: "Deep review B" },
						],
					},
					{ agent: "writer" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 4);
		assert.equal(result.details.totalSteps, 3);
	});
});
