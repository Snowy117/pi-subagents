import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { writeSteerRequestToDir } from "../../src/runs/background/control-channel.ts";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_TARGET_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_STEER_INBOX_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "../../src/runs/shared/structured-output.ts";
import { TOOL_BUDGET_ENV } from "../../src/runs/shared/tool-budget.ts";
import registerSubagentPromptRuntime, {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	SUBAGENT_INTERCOM_SESSION_NAME_ENV,
	rewriteSubagentPrompt,
	stripInheritedSkills,
	stripParentOnlySubagentMessages,
	stripProjectContext,
	stripSubagentOrchestrationSkill,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";

const envSnapshot = {
	PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT,
	PI_SUBAGENT_INHERIT_SKILLS: process.env.PI_SUBAGENT_INHERIT_SKILLS,
	PI_SUBAGENT_INTERCOM_SESSION_NAME: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
	PI_SUBAGENT_FANOUT_CHILD: process.env.PI_SUBAGENT_FANOUT_CHILD,
	PI_SUBAGENT_STEER_INBOX: process.env.PI_SUBAGENT_STEER_INBOX,
	PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE,
	PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA,
	PI_SUBAGENT_TOOL_BUDGET: process.env.PI_SUBAGENT_TOOL_BUDGET,
	PI_SUBAGENT_ORCHESTRATOR_TARGET: process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET,
	PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID,
	PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR: process.env.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR,
	PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID,
	PI_SUBAGENT_CHILD_AGENT: process.env.PI_SUBAGENT_CHILD_AGENT,
	PI_SUBAGENT_CHILD_INDEX: process.env.PI_SUBAGENT_CHILD_INDEX,
};

const SKILLS_SECTION = "\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>safe-bash</name>\n    <description>desc</description>\n    <location>/tmp/SKILL.md</location>\n  </skill>\n  <skill>\n    <name>pi-subagents</name>\n    <description>delegate to subagents</description>\n    <location>/tmp/pi-subagents/SKILL.md</location>\n  </skill>\n</available_skills>";

const BASE_PROMPT = [
	"You are a subagent.",
	"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
	SKILLS_SECTION,
	"\nCurrent date: 2026-04-16",
	"\nCurrent working directory: /repo",
].join("");

const PROMPT_WITH_EXPLICIT_SKILL = [
	"You are a subagent.\n\n<skill name=\"explicit\">\nKeep this section\n</skill>",
	"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
	SKILLS_SECTION,
	"\nCurrent date: 2026-04-16",
].join("");

const CONFIGURED_SKILLS_SECTION = "\n\nThe following configured skills are available to this subagent.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>configured-skill</name>\n    <description>explicit agent skill</description>\n    <location>/tmp/configured-skill/SKILL.md</location>\n  </skill>\n</available_skills>";

afterEach(() => {
	if (envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT === undefined) delete process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	else process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	if (envSnapshot.PI_SUBAGENT_INHERIT_SKILLS === undefined) delete process.env.PI_SUBAGENT_INHERIT_SKILLS;
	else process.env.PI_SUBAGENT_INHERIT_SKILLS = envSnapshot.PI_SUBAGENT_INHERIT_SKILLS;
	if (envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME === undefined) delete process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME;
	else process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME;
	if (envSnapshot.PI_SUBAGENT_FANOUT_CHILD === undefined) delete process.env.PI_SUBAGENT_FANOUT_CHILD;
	else process.env.PI_SUBAGENT_FANOUT_CHILD = envSnapshot.PI_SUBAGENT_FANOUT_CHILD;
	if (envSnapshot.PI_SUBAGENT_STEER_INBOX === undefined) delete process.env[SUBAGENT_STEER_INBOX_ENV];
	else process.env[SUBAGENT_STEER_INBOX_ENV] = envSnapshot.PI_SUBAGENT_STEER_INBOX;
	if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE === undefined) delete process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	else process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
	if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA === undefined) delete process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	else process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
	if (envSnapshot.PI_SUBAGENT_TOOL_BUDGET === undefined) delete process.env[TOOL_BUDGET_ENV];
	else process.env[TOOL_BUDGET_ENV] = envSnapshot.PI_SUBAGENT_TOOL_BUDGET;
	if (envSnapshot.PI_SUBAGENT_ORCHESTRATOR_TARGET === undefined) delete process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV];
	else process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = envSnapshot.PI_SUBAGENT_ORCHESTRATOR_TARGET;
	if (envSnapshot.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID === undefined) delete process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV];
	else process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = envSnapshot.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
	if (envSnapshot.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR === undefined) delete process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV];
	else process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = envSnapshot.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR;
	if (envSnapshot.PI_SUBAGENT_RUN_ID === undefined) delete process.env[SUBAGENT_RUN_ID_ENV];
	else process.env[SUBAGENT_RUN_ID_ENV] = envSnapshot.PI_SUBAGENT_RUN_ID;
	if (envSnapshot.PI_SUBAGENT_CHILD_AGENT === undefined) delete process.env[SUBAGENT_CHILD_AGENT_ENV];
	else process.env[SUBAGENT_CHILD_AGENT_ENV] = envSnapshot.PI_SUBAGENT_CHILD_AGENT;
	if (envSnapshot.PI_SUBAGENT_CHILD_INDEX === undefined) delete process.env[SUBAGENT_CHILD_INDEX_ENV];
	else process.env[SUBAGENT_CHILD_INDEX_ENV] = envSnapshot.PI_SUBAGENT_CHILD_INDEX;
});

function setSupervisorEnv(): void {
	process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = "subagent-chat-parent";
	process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = "session-parent";
	process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = path.join(os.tmpdir(), "subagent-supervisor-runtime-test");
	process.env[SUBAGENT_RUN_ID_ENV] = "run-123";
	process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";
	process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
}

describe("subagent prompt runtime", () => {
	it("strips parent-only subagent custom messages from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const slashTextResult = { role: "custom", customType: "subagent-slash-text-result", content: "Subagent profiles" };
		const notify = { role: "custom", customType: "subagent-notify", content: "Background task completed" };
		const control = { role: "custom", customType: "subagent_control_notice", content: "needs attention" };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(stripParentOnlySubagentMessages([user, instruction, slashResult, slashTextResult, notify, control, otherCustom]), [user, otherCustom]);
	});

	it("strips prior parent subagent tool calls and results from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "subagent results" };
		const readResult = { role: "toolResult", toolName: "read", content: "file contents" };
		const mixedAssistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect the repo." },
				{ type: "toolCall", name: "subagent", input: { agent: "worker" } },
				{ type: "toolCall", name: "read", input: { path: "README.md" } },
			],
		};
		const pureSubagentCall = {
			role: "assistant",
			content: [{ type: "toolCall", name: "subagent", input: { agent: "reviewer" } }],
		};

		assert.deepEqual(
			stripParentOnlySubagentMessages([user, subagentResult, readResult, mixedAssistant, pureSubagentCall]),
			[
				user,
				readResult,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the repo." },
						{ type: "toolCall", name: "read", input: { path: "README.md" } },
					],
				},
			],
		);
	});

	it("preserves live nested subagent calls and results in fanout child context", () => {
		const user = { role: "user", content: "Task" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "OK" };
		const subagentCall = { role: "assistant", content: [{ type: "toolCall", name: "subagent", input: { agent: "delegate" } }] };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

		assert.deepEqual(stripParentOnlySubagentMessages([user, subagentCall, subagentResult, instruction]), [user, subagentCall, subagentResult]);
	});

	it("defers native supervisor registration until runtime events and respects installed pi-intercom tools", async () => {
		setSupervisorEnv();
		const handlers = new Map<string, (payload?: unknown) => unknown>();
		const registered: string[] = [];

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload?: unknown) => unknown) {
				handlers.set(event, handler);
			},
			getAllTools: () => [{ name: "intercom" }, { name: "contact_supervisor" }],
			registerTool(tool: { name: string }) {
				registered.push(tool.name);
			},
		} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(tool: { name: string }): void });

		assert.deepEqual(registered, []);
		handlers.get("session_start")?.({});
		await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });
		assert.deepEqual(registered, []);
	});

	it("keeps installed pi-intercom while filling only a missing child contact_supervisor tool", async () => {
		setSupervisorEnv();
		const handlers = new Map<string, (payload?: unknown) => unknown>();
		const registered: string[] = [];

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload?: unknown) => unknown) {
				handlers.set(event, handler);
			},
			getAllTools: () => [{ name: "intercom" }, ...registered.map((name) => ({ name }))],
			registerTool(tool: { name: string }) {
				registered.push(tool.name);
			},
		} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(tool: { name: string }): void });

		handlers.get("session_start")?.({});
		await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });

		assert.deepEqual(registered, ["contact_supervisor"]);
	});

	it("registers native supervisor tools at runtime when pi-intercom is absent", async () => {
		setSupervisorEnv();
		const handlers = new Map<string, (payload?: unknown) => unknown>();
		const registered: string[] = [];

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload?: unknown) => unknown) {
				handlers.set(event, handler);
			},
			getAllTools: () => registered.map((name) => ({ name })),
			registerTool(tool: { name: string }) {
				registered.push(tool.name);
			},
		} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(tool: { name: string }): void });

		handlers.get("session_start")?.({});
		assert.deepEqual(registered, ["contact_supervisor"]);

		await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });
		assert.deepEqual(registered, ["contact_supervisor", "intercom"]);
	});

	it("sets the child intercom session name from env during agent startup", async () => {
		let sessionName: string | undefined;
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = "subagent-worker-78f659a3";

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			setSessionName(name: string) {
				sessionName = name;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; setSessionName(name: string): void });

		await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });

		assert.equal(sessionName, "subagent-worker-78f659a3");
	});

	it("rewrites the final child-visible prompt through before_agent_start", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void });

		assert.ok(beforeAgentStart, "expected before_agent_start handler");
		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "0";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "0";

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(!rewritten.systemPrompt.includes("# Project Context"));
		assert.ok(!rewritten.systemPrompt.includes("<available_skills>"));
		assert.ok(rewritten.systemPrompt.includes("Current date: 2026-04-16"));
	});

	it("uses the fanout boundary through before_agent_start when fanout env is set", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void });

		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "1";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(rewritten.systemPrompt.startsWith(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS));
	});

	it("filters parent-only artifacts from polluted fork context while preserving ordinary history", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		const priorParentTurn = { role: "user", content: "Earlier we said planner → worker → reviewers → worker." };
		const currentTask = { role: "user", content: "Now implement only the assigned fix." };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "subagent results" };
		const subagentCall = { role: "assistant", content: [{ type: "toolCall", name: "subagent", input: { agent: "worker" } }] };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(contextHandler?.({ messages: [priorParentTurn, instruction, slashResult, subagentCall, subagentResult, otherCustom, currentTask] }), {
			messages: [priorParentTurn, otherCustom, currentTask],
		});
	});

	it("does not rewrite child context when no parent-only artifacts are present", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		const messages = [
			{ role: "user", content: "Task" },
			{ role: "toolResult", toolName: "read", content: "file" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", input: { path: "README.md" } }] },
		];

		assert.equal(contextHandler?.({ messages }), undefined);
	});
});
