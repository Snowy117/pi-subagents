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
	it("uses --append-system-prompt by default", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "You are a worker",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--append-system-prompt"));
		assert.ok(!args.includes("--system-prompt"));
	});

	it("uses --system-prompt when systemPromptMode=replace", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "You are a worker",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--system-prompt"));
		assert.ok(!args.includes("--append-system-prompt"));
	});

	it("injects the subagent prompt runtime extension and env flags", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: true,
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.equal(env.PI_SUBAGENT_CHILD, "1");
		assert.equal(env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT, "0");
		assert.equal(env.PI_SUBAGENT_INHERIT_SKILLS, "1");
	});

	it("passes tool budget through env", () => {
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			toolBudget: { soft: 2, hard: 3, block: ["read"] },
		});

		assert.deepEqual(JSON.parse(env[TOOL_BUDGET_ENV] ?? "{}"), { soft: 2, hard: 3, block: ["read"] });
	});

	it("passes child intercom and orchestrator metadata through env", () => {
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
			intercomSessionName: "subagent-worker-78f659a3",
			orchestratorIntercomTarget: "subagent-chat-parent",
			parentSessionId: "session-parent-123",
			runId: "78f659a3",
			childAgentName: "worker",
			childIndex: 2,
		});

		assert.equal(env.PI_SUBAGENT_INTERCOM_SESSION_NAME, "subagent-worker-78f659a3");
		assert.equal(env.PI_SUBAGENT_ORCHESTRATOR_TARGET, "subagent-chat-parent");
		assert.equal(env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV], "session-parent-123");
		assert.equal(env.PI_SUBAGENT_RUN_ID, "78f659a3");
		assert.equal(env.PI_SUBAGENT_CHILD_AGENT, "worker");
		assert.equal(env.PI_SUBAGENT_CHILD_INDEX, "2");
		assert.equal(typeof env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV], "string");
		assert.match(env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] ?? "", /supervisor-channels/);
	});

	it("does not create a supervisor channel without an exact parent session id", () => {
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
			orchestratorIntercomTarget: "subagent-chat-parent",
			runId: "78f659a3",
			childAgentName: "worker",
			childIndex: 2,
		});

		assert.equal(env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV], undefined);
		assert.equal(env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV], undefined);
	});

	it("emits explicit builtin tool allowlists", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
		});

		const toolsArg = args[args.indexOf("--tools") + 1];
		assert.equal(toolsArg, "read,grep,find,ls,bash,edit,write,contact_supervisor");
	});

	it("adds read to explicit tool allowlists when skills must be loaded lazily", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			requireReadTool: true,
			tools: ["bash"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
	});

	it("does not duplicate read in explicit tool allowlists for lazy skills", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			requireReadTool: true,
			tools: ["read", "bash"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
	});

	it("augments explicit builtin allowlists with selected direct MCP tool names", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture);

		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,bash,chrome_devtools_take_screenshot,chrome_devtools_click");
		assert.equal(env.MCP_DIRECT_TOOLS, "chrome-devtools");
	});

	it("preserves no --tools for MCP-only agents", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture);

		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			mcpDirectTools: ["chrome-devtools"],
		});

		assert.equal(args.includes("--tools"), false);
		assert.equal(env.MCP_DIRECT_TOOLS, "chrome-devtools");
	});

	it("supports direct MCP server/tool filters", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "github",
			definition: { command: "github-mcp" },
			tools: [{ name: "search_repositories" }, { name: "create_issue" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["github/search_repositories"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,github_search_repositories");
	});

	it("matches adapter prefix modes for direct MCP names", () => {
		for (const [prefix, expected] of [
			["server", "read,linear_mcp_list_issues"],
			["short", "read,linear_list_issues"],
			["none", "read,list_issues"],
		] as const) {
			const fixture = createMcpFixture();
			writeMcpFixture(fixture, {
				serverName: "linear-mcp",
				settings: { toolPrefix: prefix },
				tools: [{ name: "list_issues" }],
			});

			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				tools: ["read"],
				mcpDirectTools: ["linear-mcp"],
			});

			assert.equal(args[args.indexOf("--tools") + 1], expected);
		}
	});

	it("includes resource tools and respects excludeTools", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "browser-mcp",
			definition: { excludeTools: ["browser_click"] },
			tools: [{ name: "click" }, { name: "navigate" }],
			resources: [{ name: "Console Logs", uri: "resource://console" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["browser-mcp"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,browser_mcp_navigate,browser_mcp_get_console_logs");
	});

	it("falls back to explicit builtins when direct MCP cache or config is missing or invalid", () => {
		const missingFixture = createMcpFixture();
		writeJson(path.join(missingFixture.agentDir, "mcp.json"), {
			mcpServers: { "chrome-devtools": { command: "npx", args: ["chrome-devtools-mcp"] } },
		});
		const missingCache = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});
		assert.equal(missingCache.args[missingCache.args.indexOf("--tools") + 1], "read,bash");

		const invalidFixture = createMcpFixture();
		writeMcpFixture(invalidFixture, { cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });
		const staleCache = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});
		assert.equal(staleCache.args[staleCache.args.indexOf("--tools") + 1], "read,bash");
	});

	it("resolves project MCP config from the child cwd and expands PI_CODING_AGENT_DIR", () => {
		const fixture = createMcpFixture();
		process.env.PI_CODING_AGENT_DIR = "~/.pi/agent";
		process.chdir(fixture.root);
		writeMcpFixture(fixture, {
			serverName: "project-mcp",
			configPath: path.join(fixture.projectDir, ".mcp.json"),
			tools: [{ name: "inspect" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["project-mcp"],
			cwd: fixture.projectDir,
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,project_mcp_inspect");
	});

	it("keeps tool extension paths when explicit extensions are allowlisted", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, { tools: [{ name: "take_screenshot" }] });

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
			mcpDirectTools: ["chrome-devtools"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.equal(args[args.indexOf("--tools") + 1], "read,chrome_devtools_take_screenshot");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.includes("./custom-tool.ts"));
		assert.ok(extensionArgs.includes("./allowed-ext.ts"));
	});

});
