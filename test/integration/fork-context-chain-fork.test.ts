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


	it("fails before launching mixed parallel children when a default-fork session cannot branch", async () => {
		const parentSessionFile = path.join(tempDir, "parent-mixed-fail.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "leaf-fail",
			openSession: () => ({
				createBranchedSession: () => {
					throw new Error("branch write failed");
				},
			}),
		};
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "scout", description: "Scout", defaultContext: "fresh" },
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ tasks: [{ agent: "scout", task: "scan" }, { agent: "worker", task: "write" }] },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to create forked subagent session/);
		assert.match(result.content[0]?.text ?? "", /branch write failed/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("preflights static default-fork chain steps even when the chain also has dynamic fanout", async () => {
		const parentSessionFile = path.join(tempDir, "parent-dynamic-chain-fail.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "leaf-fail",
			openSession: () => ({
				createBranchedSession: () => {
					throw new Error("branch write failed");
				},
			}),
		};
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "scout", description: "Scout", defaultContext: "fresh" },
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{
				chain: [
					{ agent: "scout", task: "scan" },
					{ agent: "worker", task: "write" },
					{
						expand: { from: { output: "items", path: "$" } },
						parallel: { agent: "scout", task: "inspect item" },
						collect: { as: "inspections" },
					},
				],
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to create forked subagent session/);
		assert.match(result.content[0]?.text ?? "", /branch write failed/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("keeps later foreground forked chain steps aligned after short dynamic fanout", async () => {
		mockPi.reset();
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ id: "one" }] } });
		mockPi.onCall({ output: "inspected one" });
		mockPi.onCall({ output: "final done" });
		const parentSessionFile = path.join(tempDir, "parent-dynamic-chain.jsonl");
		const { manager } = makeForkingSessionManagerRecorder({ sessionFile: parentSessionFile, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [
				{ name: "producer", description: "Producer", defaultContext: "fresh" },
				{ name: "worker", description: "Worker", defaultContext: "fork" },
			],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{
				chain: [
					{ agent: "producer", task: "produce", as: "items", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "items", path: "/items" }, item: "item", key: "/id", maxItems: 3 },
						parallel: { agent: "worker", task: "inspect {item.id}" },
						collect: { as: "inspections" },
					},
					{ agent: "worker", task: "final" },
				],
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 3);
		assert.equal(readSessionArg(readCallArgsForTask("inspect one")), path.join(tempDir, "fork-1.jsonl"));
		assert.equal(readSessionArg(readCallArgsForTask("final")), path.join(tempDir, "fork-4.jsonl"));
	});

	it("reports unknown top-level parallel agents before default-fork preconditions", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: undefined, leafId: "leaf-current" });
		const executor = makeExecutorWithDiscoverAgents(() => ({
			agents: [{ name: "worker", description: "Worker", defaultContext: "fork" }],
			projectAgentsDir: null,
		}));

		const result = await executor.execute(
			"id",
			{ tasks: [{ agent: "worker", task: "one" }, { agent: "missing", task: "two" }] },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Unknown agent: missing/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /persisted parent session/);
	});

	it("fails fast when context=fork and parent session is missing", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: undefined, leafId: "leaf-current" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "test", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /persisted parent session/);
	});

	it("fails fast when context=fork and leaf is missing", async () => {
		const { manager } = makeSessionManagerRecorder({ sessionFile: "/tmp/parent.jsonl", leafId: null });
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "test", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /current leaf/);
	});

	it("returns a tool error (instead of throwing) when branch creation fails", async () => {
		const executor = makeExecutor();
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const manager = {
			getSessionId: () => "session-123",
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "leaf-fail",
			openSession: () => ({
				createBranchedSession: () => {
					throw new Error("branch write failed");
				},
			}),
		};

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "test", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to create forked subagent session/);
		assert.match(result.content[0]?.text ?? "", /branch write failed/);
	});

	it("creates one forked session for single mode", async () => {
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
			sessionFile: path.join(tempDir, "parent.jsonl"),
			leafId: "leaf-123",
		});
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{ agent: "echo", task: "single task", context: "fork" },
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(openedPaths, [path.join(tempDir, "parent.jsonl")]);
		assert.deepEqual(branchedLeafIds, ["leaf-123"]);
		const args = readCallArgs();
		const sessionIndex = args.indexOf("--session");
		assert.notEqual(sessionIndex, -1);
		assert.notEqual(args[sessionIndex + 1], path.join(tempDir, "parent.jsonl"));
		assert.ok(args[sessionIndex + 1]);
		assert.equal(fs.existsSync(args[sessionIndex + 1]!), true);
	});

	it("creates isolated forked sessions per parallel task", async () => {
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
			sessionFile: path.join(tempDir, "parent-parallel.jsonl"),
			leafId: "leaf-777",
		});
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				tasks: [
					{ agent: "echo", task: "task one" },
					{ agent: "second", task: "task two" },
				],
				context: "fork",
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(openedPaths, [path.join(tempDir, "parent-parallel.jsonl"), path.join(tempDir, "parent-parallel.jsonl")]);
		assert.deepEqual(branchedLeafIds, ["leaf-777", "leaf-777"]);
		const sessionArgs = readSessionArgsFromCalls();
		assert.equal(sessionArgs.length, 2);
		assert.equal(new Set(sessionArgs).size, 2);
		for (const childSessionFile of sessionArgs) {
			assert.notEqual(childSessionFile, path.join(tempDir, "parent-parallel.jsonl"));
			assert.equal(fs.existsSync(childSessionFile), true);
		}
	});

	it("expands top-level parallel task counts before fork session allocation", async () => {
		const { manager, openedPaths, branchedLeafIds } = makeForkingSessionManagerRecorder({
			sessionFile: path.join(tempDir, "parent-count.jsonl"),
			leafId: "leaf-count",
		});
		const executor = makeExecutor();

		const result = await executor.execute(
			"id",
			{
				tasks: [{ agent: "echo", task: "task one", count: 3 }],
				context: "fork",
			},
			new AbortController().signal,
			undefined,
			makeCtx(manager),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(openedPaths, [
			path.join(tempDir, "parent-count.jsonl"),
			path.join(tempDir, "parent-count.jsonl"),
			path.join(tempDir, "parent-count.jsonl"),
		]);
		assert.deepEqual(branchedLeafIds, ["leaf-count", "leaf-count", "leaf-count"]);
		const sessionArgs = readSessionArgsFromCalls();
		assert.equal(sessionArgs.length, 3);
		assert.equal(new Set(sessionArgs).size, 3);
	});

});
