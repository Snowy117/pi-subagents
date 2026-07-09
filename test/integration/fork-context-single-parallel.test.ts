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


	it("runs a single agent when task is omitted", async () => {
		const { manager } = makeSessionManagerRecorder();
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		const args = readCallArgs();
		assert.ok((args.at(-1) ?? "").startsWith("Task: \n\n## Acceptance Contract"));
	});

	it("does not treat top-level agent as single mode when tasks are present", async () => {
		const { manager } = makeSessionManagerRecorder();
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo", tasks: [{ agent: "second", task: "parallel task" }] },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		const args = readCallArgs();
		assert.ok((args.at(-1) ?? "").startsWith("Task: parallel task\n\n## Acceptance Contract"));
	});

	it("uses agent defaultContext fork when launch context is omitted", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, "fork");
		assert.deepEqual(openedPaths, [parentSessionFile]);
		assert.deepEqual(branchedLeafIds, ["leaf-current"]);
		assert.deepEqual(readSessionArgsFromCalls(), [path.join(tempDir, "fork-1.jsonl")]);
	});

	it("sanitizes inherited signed thinking and forces child thinking off", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const childSessionFile = path.join(tempDir, "fork-with-thinking.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "assistant-1",
			openSession: () => ({
				createBranchedSession: () => {
					fs.writeFileSync(childSessionFile, [
						{ type: "session", version: 1, id: "child", timestamp: "2026-04-16T00:00:00.000Z", cwd: "/tmp", parentSession: parentSessionFile },
						{ type: "message", id: "user-1", parentId: null, timestamp: "2026-04-16T00:00:01.000Z", message: { role: "user", content: "prompt" } },
						{ type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-04-16T00:00:02.000Z", message: { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "anthropic/claude-sonnet-4-5", content: [{ type: "thinking", thinking: "private chain", thinkingSignature: "signed" }, { type: "text", text: "answer" }] } },
					].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
					return childSessionFile;
				},
			}),
		};
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork", model: "anthropic/claude-sonnet-4-5:high", thinking: "high" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		const args = readCallArgs();
		assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5:off");
		const entries = fs.readFileSync(childSessionFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(entries[2].message.content, [{ type: "text", text: "answer" }]);
		assert.equal(entries[3].type, "thinking_level_change");
		assert.equal(entries[3].thinkingLevel, "off");
	});

	it("forces every foreground fallback attempt off after sanitizing inherited signed thinking", async () => {
		mockPi.reset();
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "temporary provider failure" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const childSessionFile = path.join(tempDir, "fork-with-thinking.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "assistant-1",
			openSession: () => ({
				createBranchedSession: () => {
					fs.writeFileSync(childSessionFile, [
						{ type: "session", version: 1, id: "child", timestamp: "2026-04-16T00:00:00.000Z", cwd: "/tmp", parentSession: parentSessionFile },
						{ type: "message", id: "assistant-1", parentId: null, timestamp: "2026-04-16T00:00:02.000Z", message: { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "anthropic/claude-sonnet-4-5", content: [{ type: "thinking", thinking: "private chain", thinkingSignature: "signed" }, { type: "text", text: "answer" }] } },
					].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
					return childSessionFile;
				},
			}),
		};
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork", model: "openai/gpt-5-mini:high", fallbackModels: ["anthropic/claude-sonnet-4:low"], thinking: "high" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ agent: "worker", task: "test" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		const modelArgs = readAllCallArgs().map((args) => args[args.indexOf("--model") + 1]);
		assert.deepEqual(modelArgs, ["openai/gpt-5-mini:off", "anthropic/claude-sonnet-4:off"]);
	});

	it("keeps default-fork context on run-path errors", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const ctx = makeCtx(manager);
		ctx.modelRegistry.getAvailable = () => {
			throw new Error("model registry unavailable");
		};

		const result = await executor.execute(
			"id",
			{ agent: "worker" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /model registry unavailable/);
		assert.equal(result.details?.context, "fork");
	});

	it("keeps explicit fresh context over agent defaultContext fork", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "oracle", description: "Oracle", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ agent: "oracle", task: "test", context: "fresh" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, undefined);
		assert.deepEqual(openedPaths, []);
		assert.deepEqual(branchedLeafIds, []);
		assert.notEqual(readSessionArgsFromCalls()[0], path.join(tempDir, "fork-1.jsonl"));
	});

	it("uses each agent defaultContext for top-level parallel when launch context is omitted", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork" },
				{ name: "second", description: "Second" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ tasks: [{ agent: "worker", task: "one" }, { agent: "second", task: "two" }] },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, "fork");
		assert.deepEqual(openedPaths, [parentSessionFile]);
		assert.deepEqual(branchedLeafIds, ["leaf-current"]);
		const workerArgs = readCallArgsForTask("one");
		const freshArgs = readCallArgsForTask("two");
		assert.match(workerArgs.at(-1) ?? "", /delegated subagent running from a fork/);
		assert.doesNotMatch(freshArgs.at(-1) ?? "", /delegated subagent running from a fork/);
		assert.equal(readSessionArg(workerArgs), path.join(tempDir, "fork-1.jsonl"));
		assert.notEqual(readSessionArg(freshArgs), path.join(tempDir, "fork-1.jsonl"));
	});

	it("keeps explicit fresh context over top-level parallel agent defaultContext fork", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager, openedPaths } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "worker", description: "Worker", defaultContext: "fork" },
				{ name: "second", description: "Second" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ tasks: [{ agent: "worker", task: "one" }, { agent: "second", task: "two" }], context: "fresh" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, undefined);
		assert.deepEqual(openedPaths, []);
	});

	it("uses each agent defaultContext for chain runs when launch context is omitted", async () => {
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "echo", description: "Echo" },
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ chain: [{ agent: "echo", task: "scan" }, { agent: "worker", task: "write" }], clarify: false },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.context, "fork");
		assert.deepEqual(openedPaths, [parentSessionFile]);
		assert.deepEqual(branchedLeafIds, ["leaf-current"]);
		const scanArgs = readCallArgsForTask("scan");
		const writeArgs = readCallArgsForTask("write");
		assert.doesNotMatch(scanArgs.at(-1) ?? "", /delegated subagent running from a fork/);
		assert.match(writeArgs.at(-1) ?? "", /delegated subagent running from a fork/);
		const forkSessionArgs = readSessionArgsFromCalls().filter((sessionFile) => path.basename(sessionFile).startsWith("fork-"));
		assert.deepEqual(forkSessionArgs, [path.join(tempDir, "fork-1.jsonl")]);
	});

});
