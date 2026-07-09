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


	it("runs a 3-step chain end-to-end", async () => {
		mockPi.onCall({ output: "Step output" });
		const agents = [makeAgent("scout"), makeAgent("planner"), makeAgent("executor")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Survey the codebase" },
					{ agent: "planner" },
					{ agent: "executor" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 3);
		assert.ok(result.details.results.every((r) => r.exitCode === 0));
	});

	it("runs a 40-step alternating worker and reviewer chain", async () => {
		const chainLength = 40;
		for (let i = 0; i < chainLength; i++) {
			mockPi.onCall({ output: `step-${i}-output` });
		}
		const chain = Array.from({ length: chainLength }, (_, i): TestSequentialStep => ({
			agent: i % 2 === 0 ? "worker" : "reviewer",
			...(i === 0 ? { task: "Start long worker/reviewer chain" } : {}),
		}));
		const agents = [makeAgent("worker"), makeAgent("reviewer")];

		const result = await executeChain(makeChainParams(chain, agents));

		assert.ok(!result.isError, `long chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(mockPi.callCount(), chainLength);
		assert.equal(result.details.results.length, chainLength);
		assert.equal(result.details.totalSteps, chainLength);
		assert.equal(result.details.chainAgents?.length, chainLength);
		assert.equal(result.details.workflowGraph?.nodes.length, chainLength);
		assert.equal(result.details.workflowGraph?.nodes.at(-1)?.agent, "reviewer");
		assert.equal(result.details.workflowGraph?.nodes.at(-1)?.flatIndex, chainLength - 1);
		assert.ok(result.details.results.every((r) => r.exitCode === 0));
		assert.deepEqual(
			result.details.results.map((r) => r.agent),
			chain.map((step) => step.agent),
		);

		const finalTaskArg = readCallArgs(chainLength - 1).at(-1) ?? "";
		assert.match(finalTaskArg, /step-38-output/);
		assert.doesNotMatch(finalTaskArg, /step-37-output/);
		assert.match(result.content[0]?.text ?? "", /40 steps/);
	});

	it("returns error for unknown agent in chain", async () => {
		const agents = [makeAgent("scout")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "scout", task: "Start" }, { agent: "nonexistent" }],
				agents,
			),
		);

		assert.ok(result.isError);
		assert.ok(result.content[0].text.includes("Unknown agent"));
	});

	it("resolves relative step cwd values against the chain cwd for skills", async () => {
		mockPi.onCall({ output: "ok" });
		const chainCwd = path.join(tempDir, "worktree");
		const stepPackageDir = path.join(chainCwd, "packages", "app");
		writePackageSkill(stepPackageDir, "chain-step-skill");
		const agents = [makeAgent("analyst", { skills: ["chain-step-skill"] })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze", cwd: "packages/app" }],
				agents,
				{ cwd: chainCwd },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(result.details.results[0]?.skills, ["chain-step-skill"]);
	});

	it("tracks chain metadata (chainAgents, totalSteps)", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("a"), makeAgent("b")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "a", task: "Start" }, { agent: "b" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.deepEqual(result.details.chainAgents, ["a", "b"]);
		assert.equal(result.details.totalSteps, 2);
	});

	it("uses custom chainDir when provided", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];
		const customChainDir = path.join(tempDir, "my-chain");

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Use {chain_dir}" }],
				agents,
				{ chainDir: customChainDir },
			),
		);

		assert.ok(!result.isError);
		assert.ok(fs.existsSync(customChainDir), "custom chainDir should exist");
	});

	it("tightens child recursion depth per agent without relaxing the inherited chain max", async () => {
		const originalDepth = process.env.PI_SUBAGENT_DEPTH;
		const originalMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		try {
			mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
			const agents = [makeAgent("worker", { maxSubagentDepth: 1 })];

			const result = await executeChain(
				makeChainParams(
					[{ agent: "worker", task: "Inspect env" }],
					agents,
					{ maxSubagentDepth: 3 },
				),
			);

			assert.ok(!result.isError);
			assert.deepEqual(JSON.parse(result.details.results[0].finalOutput ?? "{}"), {
				PI_SUBAGENT_DEPTH: "1",
				PI_SUBAGENT_MAX_DEPTH: "1",
			});
		} finally {
			if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = originalDepth;
			if (originalMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
			else process.env.PI_SUBAGENT_MAX_DEPTH = originalMaxDepth;
		}
	});
});
