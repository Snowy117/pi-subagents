import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, events, removeTempDir } from "../support/helpers.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import { INTERCOM_DETACH_REQUEST_EVENT } from "../../src/shared/types.ts";
import { available, asyncAvailable, createSubagentExecutor, makeSessionManagerRecorder, makeState, originalHome, originalUserProfile } from "../support/fork-context-harness.ts";
import type { SessionManagerStub, SessionStubOptions } from "../support/fork-context-harness.ts";

describe("fork context execution wiring", { skip: !available ? "subagent executor not importable" : undefined }, () => {
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
		tempDir = createTempDir("pi-subagent-fork-test-");
		mockPi.reset();
		mockPi.onCall({ output: "ok" });
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		removeTempDir(tempDir);
	});

	function makeExecutor() {
		return makeExecutorWithConfig({});
	}

	function makeExecutorWithConfig(config: Record<string, unknown>) {
		return makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "echo", description: "Echo test agent" },
				{ name: "second", description: "Second test agent" },
			],
			projectAgentsDir: null,
		}), config);
	}

	function makeExecutorWithDiscoverAgents(discoverAgentsImpl: typeof discoverAgents, config: Record<string, unknown> = {}) {
		let sessionName: string | undefined;
		const eventsApi = createEventBus();
		return Object.assign(createSubagentExecutor({
			pi: {
				events: eventsApi,
				getSessionName: () => sessionName,
				setSessionName: (name: string) => {
					sessionName = name;
				},
				sendMessage: () => {},
			},
			state: makeState(tempDir),
			config,
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: discoverAgentsImpl,
		}), { eventsApi });
	}

	function readCallArgs(): string[] {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		return readRecordedArgs(callFile);
	}

	function readAllCallArgs(): string[][] {
		return fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.map(readRecordedArgs);
	}

	function readRecordedArgs(callFile: string): string[] {
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8"));
		assert.equal(typeof payload, "object", "expected recorded args payload");
		assert.notEqual(payload, null, "expected recorded args payload");
		assert.ok("args" in payload, "expected recorded args payload");
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return payload.args;
	}

	function readSessionArgsFromCalls(): string[] {
		return readAllCallArgs()
			.map((args) => {
				const sessionIndex = args.indexOf("--session");
				if (sessionIndex === -1) return undefined;
				const sessionFile = args[sessionIndex + 1];
				assert.ok(sessionFile, "expected a session file after --session");
				return sessionFile;
			})
			.filter((sessionFile): sessionFile is string => Boolean(sessionFile));
	}

	function readCallArgsForTask(taskText: string): string[] {
		const args = readAllCallArgs().find((callArgs) => {
			const prompt = callArgs.at(-1) ?? "";
			return prompt.startsWith(`Task: ${taskText}\n`)
				|| prompt.includes(`\n\nTask:\n${taskText}\n`);
		});
		assert.ok(args, `expected a recorded mock pi call for task '${taskText}'`);
		return args;
	}

	function readSessionArg(args: string[]): string {
		const sessionIndex = args.indexOf("--session");
		assert.notEqual(sessionIndex, -1);
		const sessionFile = args[sessionIndex + 1];
		assert.ok(sessionFile, "expected a session file after --session");
		return sessionFile;
	}

	function makeForkingSessionManagerRecorder(options: { sessionFile: string; leafId: string }) {
		const openedPaths: string[] = [];
		const branchedLeafIds: string[] = [];
		let counter = 0;
		fs.mkdirSync(path.dirname(options.sessionFile), { recursive: true });
		fs.writeFileSync(options.sessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => options.sessionFile,
			getLeafId: () => options.leafId,
			openSession: (sessionFile: string) => {
				openedPaths.push(sessionFile);
				return {
					createBranchedSession: (leafId: string) => {
						branchedLeafIds.push(leafId);
						counter++;
						const childSessionFile = path.join(tempDir, `fork-${counter}.jsonl`);
						fs.writeFileSync(childSessionFile, '{"type":"session","version":1,"id":"child","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
						return childSessionFile;
					},
				};
			},
		};
		return { manager, openedPaths, branchedLeafIds };
	}

	function writeAgent(projectRoot: string, name: string, model: string): void {
		const filePath = path.join(projectRoot, ".pi", "agents", `${name}.md`);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			`---\nname: ${name}\ndescription: ${name} agent\nmodel: ${model}\n---\n\nUse ${model}.\n`,
			"utf-8",
		);
	}

	function writeProjectOverride(projectRoot: string, agentName: string, model: string): void {
		const settingsPath = path.join(projectRoot, ".pi", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({ subagents: { agentOverrides: { [agentName]: { model } } } }, null, 2),
			"utf-8",
		);
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

	function makeCtx(sessionManager: SessionManagerStub) {
		return {
			cwd: tempDir,
			hasUI: false,
			ui: {},
			modelRegistry: { getAvailable: () => [] },
			sessionManager,
		};
	}


	it("rejects async chain worktree runs with a conflicting task cwd", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: "leaf-chain" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				chain: [
					{
						parallel: [
							{ agent: "echo", task: "p1" },
							{ agent: "second", task: "p2", cwd: `${tempDir}/other` },
						],
						worktree: true,
					},
				],
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /parallel chain step 1/i);
		assert.match(result.content[0]?.text ?? "", /task 2 \(second\) sets cwd/i);
	});

	it("creates isolated forked sessions per chain step (including counted parallel steps)", async () => {
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
			sessionFile: path.join(tempDir, "parent-chain.jsonl"),
			leafId: "leaf-chain",
		});
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				chain: [
					{ agent: "echo", task: "step 1" },
					{ parallel: [{ agent: "echo", task: "p1", count: 2 }, { agent: "second", task: "p2", count: 2 }] },
					{ agent: "second", task: "step 3" },
				],
				context: "fork",
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(openedPaths, Array(6).fill(path.join(tempDir, "parent-chain.jsonl")));
		assert.deepEqual(branchedLeafIds, Array(6).fill("leaf-chain"));
		const sessionArgs = readSessionArgsFromCalls().filter((sessionFile) => path.dirname(sessionFile) === tempDir && path.basename(sessionFile).startsWith("fork-"));
		assert.equal(sessionArgs.length, 6, "1 sequential + 4 parallel + 1 sequential");
		assert.equal(new Set(sessionArgs).size, 6);
	});

	it("uses request cwd for management actions", async () => {
		const executor = makeExecutor();
		const worktreeDir = path.join(tempDir, "worktree");
		fs.mkdirSync(path.join(worktreeDir, ".pi"), { recursive: true });

		const result = await executor.execute(
			"id",
			{
				action: "create",
				cwd: "worktree",
				config: { name: "local-helper", description: "Local helper", scope: "project" },
			},
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, false);
		assert.equal(fs.existsSync(path.join(worktreeDir, ".pi", "agents", "local-helper.md")), true);
		assert.equal(fs.existsSync(path.join(tempDir, ".pi", "agents", "local-helper.md")), false);
	});

	it("uses request cwd for execution-time agent discovery", async () => {
		const worktreeDir = path.join(tempDir, "worktree");
		writeAgent(tempDir, "echo", "openai/gpt-5-main");
		writeAgent(worktreeDir, "echo", "anthropic/claude-haiku-4-5");
		const executor = makeExecutorWithDiscoverAgents(discoverAgents);
		const task = `test ${path.basename(tempDir)}`;

		const result = await executor.execute(
			"id",
			{ agent: "echo", task, cwd: "worktree" },
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		const args = readAllCallArgs().find((callArgs) => (callArgs.at(-1) ?? "").startsWith(`Task: ${task}\n\n## Acceptance Contract`));
		assert.ok(args, "expected a recorded mock pi call for this test task");
		const modelIndex = args.indexOf("--model");
		assert.notEqual(modelIndex, -1);
		assert.equal(args[modelIndex + 1], "anthropic/claude-haiku-4-5");
	});

	it("resolves parallel task cwd values relative to the request cwd", async () => {
		const worktreeDir = path.join(tempDir, "worktree");
		writePackageSkill(path.join(worktreeDir, "packages", "app"), "parallel-step-skill");
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [{ name: "echo", description: "Echo test agent", skills: ["parallel-step-skill"] }],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{
				tasks: [{ agent: "echo", task: "test", cwd: "packages/app" }],
				cwd: worktreeDir,
			},
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details?.results?.[0]?.skills, ["parallel-step-skill"]);
	});

	it("uses request cwd for project builtin overrides during management", async () => {
		const tempHome = createTempDir("pi-subagent-home-");
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		const worktreeDir = path.join(tempDir, "worktree");
		fs.mkdirSync(worktreeDir, { recursive: true });
		writeProjectOverride(tempDir, "reviewer", "openai/gpt-5-main");
		writeProjectOverride(worktreeDir, "reviewer", "openai/gpt-5-worktree");
		const executor = makeExecutor();

		try {
			const result = await executor.execute(
				"id",
				{ action: "get", agent: "reviewer", cwd: "worktree" },
				new AbortController().signal,
				undefined,
				makeCtx(makeSessionManagerRecorder().manager),
			);

			assert.equal(result.isError, false);
			assert.match(result.content[0]?.text ?? "", /Model: openai\/gpt-5-worktree/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Model: openai\/gpt-5-main/);
		} finally {
			removeTempDir(tempHome);
		}
	});
});
