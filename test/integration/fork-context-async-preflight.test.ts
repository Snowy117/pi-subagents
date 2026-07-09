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


	it("rejects top-level parallel worktree runs with a conflicting task cwd", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: "leaf-777" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				tasks: [
					{ agent: "echo", task: "task one" },
					{ agent: "second", task: "task two", cwd: `${tempDir}/other` },
				],
				worktree: true,
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /worktree isolation uses the shared cwd/i);
		assert.match(result.content[0]?.text ?? "", /task 2 \(second\) sets cwd/i);
	});

	it("rejects top-level parallel counts that expand past MAX_PARALLEL", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: "leaf-max" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				tasks: [{ agent: "echo", task: "task one", count: 9 }],
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Max 8 tasks/);
	});

	it("uses top-level parallel config overrides for maxTasks and concurrency", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: "leaf-max-config" });
		const maxTasksExecutor = makeExecutorWithConfig({ parallel: { maxTasks: 9 } });

		const maxTasksResult = await maxTasksExecutor.execute(
			"id",
			{
				tasks: [{ agent: "echo", task: "task one", count: 9 }],
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(maxTasksResult.isError, undefined);
		assert.equal(mockPi.callCount(), 9);

		for (const testCase of [
			{ name: "config", configConcurrency: 2, paramsConcurrency: undefined, expectedMaxRunning: 2 },
			{ name: "per-call", configConcurrency: 3, paramsConcurrency: 1, expectedMaxRunning: 1 },
		]) {
			mockPi.reset();
			for (let i = 0; i < 3; i++) {
				mockPi.onCall({
					steps: [
						{ jsonl: [events.toolStart("bash", { command: `${testCase.name}-${i}` })] },
						{ delay: 250 },
						{ jsonl: [events.toolEnd("bash"), events.assistantMessage(`done-${i}`)] },
					],
				});
			}

			const executor = makeExecutorWithConfig({ parallel: { concurrency: testCase.configConcurrency } });
			let maxRunning = 0;

			const result = await executor.execute(
				"id",
				{
					tasks: [
						{ agent: "echo", task: "task one" },
						{ agent: "second", task: "task two" },
						{ agent: "echo", task: "task three" },
					],
					...(testCase.paramsConcurrency ? { concurrency: testCase.paramsConcurrency } : {}),
				},
				new AbortController().signal,
				(update: ProgressUpdate) => {
					const progress = update.details?.progress ?? [];
					const running = progress.filter((entry) => entry.status === "running").length;
					maxRunning = Math.max(maxRunning, running);
				},
				makeCtx(makeSessionManagerRecorder().manager),
			);

			assert.equal(result.isError, undefined, testCase.name);
			assert.equal(maxRunning, testCase.expectedMaxRunning, testCase.name);
		}
	});

	it("caps top-level foreground parallel execution with globalConcurrencyLimit", async () => {
		mockPi.reset();
		for (let i = 0; i < 4; i++) {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart("bash", { command: `global-${i}` })] },
					{ delay: 250 },
					{ jsonl: [events.toolEnd("bash"), events.assistantMessage(`done-${i}`)] },
				],
			});
		}

		const executor = makeExecutorWithConfig({ globalConcurrencyLimit: 2, parallel: { concurrency: 4 } });
		let maxRunning = 0;

		const result = await executor.execute(
			"id",
			{
				tasks: [
					{ agent: "echo", task: "task one" },
					{ agent: "second", task: "task two" },
					{ agent: "echo", task: "task three" },
					{ agent: "second", task: "task four" },
				],
			},
			new AbortController().signal,
			(update: ProgressUpdate) => {
				const progress = update.details?.progress ?? [];
				const running = progress.filter((entry) => entry.status === "running").length;
				maxRunning = Math.max(maxRunning, running);
			},
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 4);
		assert.equal(maxRunning, 2);
	});

	it("detaches parallel child runs cleanly on intercom handoff", async () => {
		mockPi.reset();
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after handoff")] },
			],
		});
		mockPi.onCall({ output: "other done" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "echo", description: "Echo", systemPrompt: "Intercom orchestration channel:" },
				{ name: "second", description: "Second", systemPrompt: "Intercom orchestration channel:" },
			],
			projectAgentsDir: null,
		}));
		let detachEmitted = false;
		const result = await executor.execute(
			"intercom-parallel",
			{
				tasks: [
					{ agent: "echo", task: "send handoff" },
					{ agent: "second", task: "continue" },
				],
			},
			new AbortController().signal,
			(update: ProgressUpdate) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "intercom")) return;
				detachEmitted = true;
				executor.eventsApi.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "parallel-detach" });
			},
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Parallel run detached for intercom coordination/);
		assert.equal(detachEmitted, true);
		assert.equal(result.details?.results?.some((entry) => entry.detached === true && entry.exitCode === -2), true);
	});

	it("runs top-level parallel async requests in the background", { skip: !asyncAvailable ? "jiti not available" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				tasks: [
					{ agent: "echo", task: "task one" },
					{ agent: "second", task: "task two" },
				],
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.mode, "parallel");
		assert.ok(result.details?.asyncId, "expected an asyncId for background top-level parallel runs");
		assert.match(result.content[0]?.text ?? "", /Async parallel:/);
	});

	it("runs async chain requests in the background when clarify is omitted", { skip: !asyncAvailable ? "jiti not available" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				chain: [
					{ agent: "echo", task: "task one" },
					{ agent: "second", task: "task two" },
				],
				async: true,
			},
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.mode, "chain");
		assert.ok(result.details?.asyncId, "expected an asyncId for background chain runs");
		assert.match(result.content[0]?.text ?? "", /Async chain:/);
	});

	it("keeps explicit clarify async chain requests in the foreground", async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				chain: [
					{ agent: "echo", task: "task one" },
					{ agent: "second", task: "task two" },
				],
				async: true,
				clarify: true,
			},
			new AbortController().signal,
			undefined,
			makeCtx(makeSessionManagerRecorder().manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.mode, "chain");
		assert.equal(result.details?.asyncId, undefined);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Async chain:/);
	});

	it("rejects invalid background top-level parallel requests during executor preflight", async () => {
		const executor = makeExecutor();
		for (const testCase of [
			{
				name: "max tasks",
				params: { tasks: [{ agent: "echo", task: "task one", count: 9 }], async: true, clarify: false },
				patterns: [/Max 8 tasks/],
			},
			{
				name: "worktree cwd conflict",
				params: {
					tasks: [
						{ agent: "echo", task: "task one" },
						{ agent: "second", task: "task two", cwd: `${tempDir}/other` },
					],
					worktree: true,
					async: true,
					clarify: false,
				},
				patterns: [/worktree isolation uses the shared cwd/i, /task 2 \(second\) sets cwd/i],
			},
		]) {
			const result = await executor.execute(
				"id",
				testCase.params,
				new AbortController().signal,
				undefined,
				makeCtx(makeSessionManagerRecorder().manager),
			);

			assert.equal(result.isError, true, testCase.name);
			for (const pattern of testCase.patterns) {
				assert.match(result.content[0]?.text ?? "", pattern, testCase.name);
			}
		}
	});

});
