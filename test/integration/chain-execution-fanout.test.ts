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


	it("passes named sequential outputs through {outputs.name}", async () => {
		mockPi.onCall({ output: "Context marker: CTX_123" });
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("context"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "context", task: "Gather context", as: "contextOutput" },
					{ agent: "writer", task: "Use {outputs.contextOutput}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.match(readCallArgs(1).at(-1) ?? "", /CTX_123/);
		assert.equal(result.details.workflowGraph?.nodes[0]?.outputName, "contextOutput");
	});

	it("expands structured named output into dynamic parallel children and collects results", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "synthesized" });
		const agents = [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
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
					{ agent: "writer", task: "Use {outputs.reviews}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(mockPi.callCount(), 4);
		assert.match(readCallArgs(1).at(-1) ?? "", /Review src\/a\.ts/);
		assert.match(readCallArgs(2).at(-1) ?? "", /Review src\/b\.ts/);
		assert.match(readCallArgs(3).at(-1) ?? "", /"key":"src\/a\.ts"/);
		const collected = result.details.outputs?.reviews?.structured as Array<{ key: string; structured: unknown }>;
		assert.deepEqual(collected.map((item) => item.key), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(collected.map((item) => item.structured), [{ ok: "a" }, { ok: "b" }]);
		const dynamicNode = result.details.workflowGraph?.nodes[1];
		assert.equal(dynamicNode?.kind, "dynamic-parallel-group");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
	});

	it("persists checked acceptance status for dynamic fanout materialized children and aggregate group", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: acceptanceReport({ changedFiles: ["src/a.ts"] }), structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: acceptanceReport({ changedFiles: ["src/b.ts"] }), structuredOutput: { ok: "b" } });
		const agents = [makeAgent("scout"), makeAgent("reviewer", { completionGuard: false })];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" }, acceptance: { level: "checked" } },
						collect: { as: "reviews" },
						acceptance: { level: "checked" },
						concurrency: 1,
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		const dynamicNode = result.details.workflowGraph?.nodes[1];
		assert.equal(dynamicNode?.acceptanceStatus, "checked");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.acceptanceStatus), ["checked", "checked"]);
	});

	it("does not expose collected dynamic output when a child fails", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ exitCode: 1, stderr: "review-b failed" });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
						concurrency: 1,
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.equal(mockPi.callCount(), 3);
		assert.equal(result.details.outputs?.reviews, undefined);
		assert.equal(result.details.results.some((entry) => entry.exitCode === 1), true);
	});

	it("fails dynamic fanout before spawning children for invalid source arrays", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "a" }, { path: "b" }] } });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 1 },
						parallel: { agent: "reviewer", task: "Review {item.path}" },
						collect: { as: "reviews" },
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /exceeding maxItems 1/);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "failed");
		assert.match(result.details.workflowGraph?.nodes[1]?.error ?? "", /exceeding maxItems 1/);
	});

	it("marks dynamic file-only validation failures as failed graph groups before spawning children", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputMode: "file-only" },
						collect: { as: "reviews" },
					},
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "failed");
		assert.match(result.details.workflowGraph?.nodes[1]?.error ?? "", /outputMode: "file-only"/);
	});

	it("marks empty dynamic fanout skip as a completed graph group", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [] } });
		mockPi.onCall({ output: "used empty reviews" });
		const agents = [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4, onEmpty: "skip" },
						parallel: { agent: "reviewer", task: "Review {item.path}" },
						collect: { as: "reviews" },
					},
					{ agent: "writer", task: "Use {outputs.reviews}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual(result.details.outputs?.reviews?.structured, []);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "completed");
		assert.deepEqual(result.details.workflowGraph?.nodes[1]?.children, []);
	});

	it("marks dynamic collect schema failures as failed graph groups", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews", outputSchema: { type: "object" } },
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Collected output validation failed/);
		assert.equal(result.details.outputs?.reviews, undefined);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "failed");
		assert.match(result.details.workflowGraph?.nodes[1]?.error ?? "", /Collected output validation failed/);
		assert.equal(result.details.workflowGraph?.nodes[1]?.children?.[0]?.status, "completed");
	});

	it("keeps materialized dynamic children in live graph updates for later sequential steps", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ steps: [{ jsonl: [events.assistantMessage("writer started")] }] });
		const agents = [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")];
		let writerUpdateChildren: Array<{ itemKey?: string; status?: string }> | undefined;

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
						concurrency: 1,
					},
					{ agent: "writer", task: "Use {outputs.reviews}" },
				],
				agents,
				{
					onUpdate(update: { details?: ChainExecutionResult["details"] }) {
						if (update.details?.currentStepIndex !== 2) return;
						writerUpdateChildren = update.details.workflowGraph?.nodes[1]?.children;
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(writerUpdateChildren?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
	});

	it("fails duplicate and unknown named outputs before spawning children", async () => {
		const agents = [makeAgent("a"), makeAgent("b")];

		const duplicate = await executeChain(
			makeChainParams(
				[{ agent: "a", task: "A", as: "same" }, { agent: "b", task: "B", as: "same" }],
				agents,
			),
		);
		assert.equal(duplicate.isError, true);
		assert.match(duplicate.content[0]?.text ?? "", /Duplicate chain output name 'same'/);
		assert.equal(mockPi.callCount(), 0);

		const unknown = await executeChain(
			makeChainParams(
				[{ agent: "b", task: "Use {outputs.missing}" }],
				agents,
			),
		);
		assert.equal(unknown.isError, true);
		assert.match(unknown.content[0]?.text ?? "", /Unknown chain output reference/);
		assert.equal(mockPi.callCount(), 0);

		const malformed = await executeChain(
			makeChainParams(
				[{ agent: "b", task: "Use {outputs.bad-name}" }],
				agents,
			),
		);
		assert.equal(malformed.isError, true);
		assert.match(malformed.content[0]?.text ?? "", /Invalid chain output reference '\{outputs\.bad-name\}'/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("requires schema-valid structured_output when outputSchema is set", async () => {
		const schema = {
			type: "object",
			required: ["ok"],
			properties: { ok: { type: "boolean" }, note: { type: "string" } },
		};
		mockPi.onCall({ output: "prose", structuredOutput: { ok: true, note: "captured" } });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema }], agents),
		);

		assert.ok(!result.isError);
		assert.deepEqual(result.details.results[0]?.structuredOutput, { ok: true, note: "captured" });

		mockPi.reset();
		mockPi.onCall({ structuredOutput: { ok: true, note: "tool-only" } });
		const structuredOnly = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema }], agents),
		);
		assert.ok(!structuredOnly.isError);
		assert.deepEqual(structuredOnly.details.results[0]?.structuredOutput, { ok: true, note: "tool-only" });

		mockPi.reset();
		mockPi.onCall({ output: "prose only" });
		const missing = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema }], agents),
		);
		assert.equal(missing.isError, true);
		assert.match(missing.details.results[0]?.error ?? "", /Missing structured_output call/);

		mockPi.reset();
		mockPi.onCall({ output: "invalid", structuredOutput: { ok: "yes" } });
		const invalid = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema, phase: "Validate", label: "Structured worker", as: "result" }], agents),
		);
		assert.equal(invalid.isError, true);
		assert.match(invalid.details.results[0]?.error ?? "", /Structured output validation failed/);
		assert.equal(invalid.details.workflowGraph?.nodes[0]?.status, "failed");
		assert.equal(invalid.details.workflowGraph?.nodes[0]?.outputName, "result");
		assert.match(invalid.details.workflowGraph?.nodes[0]?.error ?? "", /Structured output validation failed/);
	});

	it("substitutes {task} in templates", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Review {task} carefully" }],
				agents,
				{ task: "the authentication module" },
			),
		);

		assert.ok(!result.isError);
		const workerTask = result.details.results[0].task;
		assert.ok(
			workerTask.includes("the authentication module"),
			`should substitute {task}: ${workerTask.slice(0, 200)}`,
		);
	});

	it("creates and uses chain_dir", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Write to {chain_dir}" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		const summary = result.content[0].text;
		assert.ok(summary.includes("✅ Chain completed:"), `missing completion marker: ${summary}`);
		assert.ok(summary.includes("📁 Artifacts:"), `missing artifacts marker: ${summary}`);
	});

	it("stops chain on step failure", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Agent crashed" });
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do first thing" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail");
		assert.equal(result.details.results.length, 1, "only step1 should have run");
		assert.equal(result.details.results[0].exitCode, 1);
	});

});
