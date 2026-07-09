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

describe("buildPiArgs session wiring", () => {
	it("uses --session when sessionFile is provided", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-session-"));
		try {
			const sessionFile = path.join(tempDir, "nested", "session.jsonl");
			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: true,
				sessionFile,
				sessionDir: "/tmp/should-not-be-used",
				inheritProjectContext: false,
				inheritSkills: false,
			});

			assert.ok(args.includes("--session"));
			assert.ok(args.includes(sessionFile));
			assert.ok(fs.existsSync(path.dirname(sessionFile)));
			assert.ok(!args.includes("--session-dir"), "--session-dir should not be emitted with --session");
			assert.ok(!args.includes("--no-session"), "--no-session should not be emitted with --session");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps fresh mode behavior (sessionDir + no session file)", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: true,
			sessionDir: "/tmp/subagent-sessions",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--session-dir"));
		assert.ok(args.includes("/tmp/subagent-sessions"));
		assert.ok(!args.includes("--session"));
	});

	it("emits explicit parent session env for permission forwarding", () => {
		process.env.PI_SUBAGENT_PARENT_SESSION = "inherited-parent";
		const { env } = buildPiArgs({
			parentSessionId: "direct-parent",
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(env[SUBAGENT_PARENT_SESSION_ENV], "direct-parent");
	});

	it("falls back to inherited parent session env for permission forwarding", () => {
		process.env.PI_SUBAGENT_PARENT_SESSION = "inherited-parent";
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(env[SUBAGENT_PARENT_SESSION_ENV], "inherited-parent");
	});
});

describe("buildPiArgs model wiring", () => {
	it("uses --model for provider-qualified model ids", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "openai-codex/gpt-5.4-mini",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes("openai-codex/gpt-5.4-mini"));
		assert.ok(!args.includes("--models"));
	});

	it("uses --model for bare model ids too", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "kimi-k2.5",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes("kimi-k2.5"));
		assert.ok(!args.includes("--models"));
	});


	it("preserves thinking suffixes on model args", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "openai-codex/gpt-5.4-mini",
			thinking: "high",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(applyThinkingSuffix("openai-codex/gpt-5.4-mini", "high"), "openai-codex/gpt-5.4-mini:high");
		assert.ok(args.includes("--model"));
		assert.ok(args.includes("openai-codex/gpt-5.4-mini:high"));
	});

	it("passes explicit thinking off through to the model arg", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "anthropic/claude-haiku-4-5",
			thinking: "off",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(applyThinkingSuffix("anthropic/claude-haiku-4-5", "off"), "anthropic/claude-haiku-4-5:off");
		assert.equal(applyThinkingSuffix("anthropic/claude-haiku-4-5:high", "off", true), "anthropic/claude-haiku-4-5:off");
		assert.ok(args.includes("--model"));
		assert.ok(args.includes("anthropic/claude-haiku-4-5:off"));
	});

	it("does not append a thinking suffix for boolean false", () => {
		const model = "glm-5.2-short-fast";
		const once = applyThinkingSuffix(model, false);
		assert.equal(once, model);
		assert.equal(applyThinkingSuffix(once, false), model);

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model,
			thinking: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes(model));
		assert.ok(!args.some((arg) => arg.includes(":false")));
	});

	it("leaves provider-specific model suffixes untouched when thinking is disabled", () => {
		const model = "openai-compatible/qwen2.5-coder:7b";
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes(model));
		assert.ok(!args.includes(`${model}:high`));
	});
});

