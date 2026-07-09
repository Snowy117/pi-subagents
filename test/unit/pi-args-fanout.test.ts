import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";
import { TOOL_BUDGET_ENV } from "../../src/runs/shared/tool-budget.ts";
import {
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_SESSION_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
	SUBAGENT_RUN_ID_ENV,
	applyThinkingSuffix,
	buildPiArgs,
} from "../../src/runs/shared/pi-args.ts";

const originalEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_SUBAGENT_FANOUT_CHILD: process.env.PI_SUBAGENT_FANOUT_CHILD,
	PI_SUBAGENT_PARENT_EVENT_SINK: process.env.PI_SUBAGENT_PARENT_EVENT_SINK,
	PI_SUBAGENT_PARENT_CONTROL_INBOX: process.env.PI_SUBAGENT_PARENT_CONTROL_INBOX,
	PI_SUBAGENT_PARENT_ROOT_RUN_ID: process.env.PI_SUBAGENT_PARENT_ROOT_RUN_ID,
	PI_SUBAGENT_PARENT_RUN_ID: process.env.PI_SUBAGENT_PARENT_RUN_ID,
	PI_SUBAGENT_PARENT_CHILD_INDEX: process.env.PI_SUBAGENT_PARENT_CHILD_INDEX,
	PI_SUBAGENT_PARENT_DEPTH: process.env.PI_SUBAGENT_PARENT_DEPTH,
	PI_SUBAGENT_PARENT_PATH: process.env.PI_SUBAGENT_PARENT_PATH,
	PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: process.env.PI_SUBAGENT_PARENT_CAPABILITY_TOKEN,
	PI_SUBAGENT_PARENT_SESSION: process.env.PI_SUBAGENT_PARENT_SESSION,
	PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID,
};
const originalCwd = process.cwd();
const tempRoots: string[] = [];

interface McpFixture {
	root: string;
	agentDir: string;
	projectDir: string;
}

function createMcpFixture(): McpFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-mcp-"));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(projectDir);
	return { root, agentDir, projectDir };
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeMcpFixture(
	fixture: McpFixture,
	options: {
		serverName?: string;
		definition?: Record<string, unknown>;
		settings?: Record<string, unknown>;
		tools?: Array<{ name: string; description?: string }>;
		resources?: Array<{ name: string; uri: string; description?: string }>;
		configPath?: string;
		cachedAt?: number;
	} = {},
): void {
	const serverName = options.serverName ?? "chrome-devtools";
	const definition = { command: "npx", args: ["chrome-devtools-mcp"], ...(options.definition ?? {}) };
	writeJson(options.configPath ?? path.join(fixture.agentDir, "mcp.json"), {
		...(options.settings ? { settings: options.settings } : {}),
		mcpServers: {
			[serverName]: definition,
		},
	});
	writeJson(path.join(fixture.agentDir, "mcp-cache.json"), {
		version: 1,
		servers: {
			[serverName]: {
				configHash: computeMcpServerHash(definition),
				cachedAt: options.cachedAt ?? Date.now(),
				tools: options.tools ?? [
					{ name: "take_screenshot" },
					{ name: "click" },
				],
				resources: options.resources ?? [],
			},
		},
	});
}

afterEach(() => {
	process.chdir(originalCwd);
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("buildPiArgs system prompt mode wiring", () => {
	it("loads subagent-only extension paths only through child process extension args", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			extensions: ["./main-allowed-ext.ts"],
			subagentOnlyExtensions: ["./child-tool.ts"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(args.includes("--no-extensions"));
		assert.equal(args[args.indexOf("--tools") + 1], "read");
		assert.ok(extensionArgs.includes("./main-allowed-ext.ts"));
		assert.ok(extensionArgs.includes("./child-tool.ts"));
	});

	it("authorizes child fanout only from exact declared builtin subagent", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "subagent"],
			runId: "parent-run",
			childIndex: 1,
			parentEventSink: "/tmp/root/events",
			parentControlInbox: "/tmp/root/control",
			parentRootRunId: "root-run",
			parentCapabilityToken: "token-1",
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.equal(args[args.indexOf("--tools") + 1], "read,subagent");
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "1");
		assert.equal(env[SUBAGENT_PARENT_EVENT_SINK_ENV], "/tmp/root/events");
		assert.equal(env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "/tmp/root/control");
		assert.equal(env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "root-run");
		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], "parent-run");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "1");
		assert.equal(env[SUBAGENT_PARENT_DEPTH_ENV], "1");
		assert.deepEqual(JSON.parse(env[SUBAGENT_PARENT_PATH_ENV] ?? "[]"), [{ runId: "parent-run", stepIndex: 1 }]);
		assert.equal(env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "token-1");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "extension", "fanout-child.ts"))));
	});

	it("clears all fanout routing env values for non-fanout children", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "mcp:server/subagent"],
			parentEventSink: "/tmp/should-not-leak/events",
			parentControlInbox: "/tmp/should-not-leak/control",
			parentRootRunId: "root-should-not-leak",
			parentRunId: "should-not-leak",
			parentChildIndex: 9,
			parentCapabilityToken: "token-should-not-leak",
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "0");
		assert.equal(env[SUBAGENT_PARENT_EVENT_SINK_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_DEPTH_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_PATH_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "");
		assert.ok(!extensionArgs.some((arg) => arg.endsWith(path.join("src", "extension", "fanout-child.ts"))));
	});

	it("inherits routing env only for authorized fanout children", () => {
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = "/tmp/inherited/events";
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = "/tmp/inherited/control";
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = "inherited-root";
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "inherited-run";
		process.env[SUBAGENT_RUN_ID_ENV] = "owner-run";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "4";
		process.env[SUBAGENT_PARENT_DEPTH_ENV] = "2";
		process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([{ runId: "root-run", stepIndex: 0 }, { runId: "../unsafe", stepIndex: 1 }, { runId: "owner-run", stepIndex: 1 }]);
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "inherited-token";

		const fanout = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["subagent"],
		});
		assert.equal(fanout.env[SUBAGENT_PARENT_EVENT_SINK_ENV], "/tmp/inherited/events");
		assert.equal(fanout.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "/tmp/inherited/control");
		assert.equal(fanout.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "inherited-root");
		assert.equal(fanout.env[SUBAGENT_PARENT_RUN_ID_ENV], "owner-run");
		assert.equal(fanout.env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "4");
		assert.equal(fanout.env[SUBAGENT_PARENT_DEPTH_ENV], "3");
		assert.deepEqual(JSON.parse(fanout.env[SUBAGENT_PARENT_PATH_ENV] ?? "[]"), [{ runId: "root-run", stepIndex: 0 }, { runId: "owner-run", stepIndex: 1 }, { runId: "owner-run", stepIndex: 4 }]);
		assert.equal(fanout.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "inherited-token");

		const nonFanout = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
		});
		assert.equal(nonFanout.env[SUBAGENT_FANOUT_CHILD_ENV], "0");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_EVENT_SINK_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_RUN_ID_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_DEPTH_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_PATH_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "");
	});

	it("prefers the current subagent run id over inherited ancestor ids for nested fanout routing", () => {
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = "/tmp/inherited/events";
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = "/tmp/inherited/control";
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = "root-run";
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "older-parent";
		process.env[SUBAGENT_RUN_ID_ENV] = "ancestor-run";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "4";
		process.env[SUBAGENT_PARENT_DEPTH_ENV] = "1";
		process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([{ runId: "root-run", stepIndex: 0 }]);
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "inherited-token";

		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["subagent"],
			runId: "current-nested-run",
			childIndex: 2,
		});

		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], "current-nested-run");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "2");
		assert.equal(env[SUBAGENT_PARENT_DEPTH_ENV], "2");
		assert.deepEqual(JSON.parse(env[SUBAGENT_PARENT_PATH_ENV] ?? "[]"), [{ runId: "root-run", stepIndex: 0 }, { runId: "current-nested-run", stepIndex: 2 }]);
	});

	it("does not let direct MCP tools authorize child fanout", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "delegator",
			definition: { command: "delegator-mcp" },
			tools: [{ name: "subagent" }],
		});

		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["delegator"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.equal(args[args.indexOf("--tools") + 1], "read,delegator_subagent");
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "0");
		assert.ok(!extensionArgs.some((arg) => arg.endsWith(path.join("src", "extension", "fanout-child.ts"))));
	});

	it("keeps child-safe fanout registration in explicit extensions mode", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["subagent"],
			extensions: ["./agent-allowed-ext.ts"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(args.includes("--no-extensions"));
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "1");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "extension", "fanout-child.ts"))));
		assert.ok(extensionArgs.includes("./agent-allowed-ext.ts"));
	});

	it("emits an empty prompt file when replace mode is used with an empty prompt", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--system-prompt"));
	});
});
