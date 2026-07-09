import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { handleManagementAction } from "../../src/agents/agent-management.ts";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import { parseChain, serializeChain } from "../../src/agents/chain-serializer.ts";
import { discoverAgents, discoverAgentsAll, type AgentConfig } from "../../src/agents/agents.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";
import { THINKING_LEVELS } from "../../src/shared/model-info.ts";

const tempDirs: string[] = [];

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeAgent(filePath: string, body: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

function withTempHome<T>(fn: (home: string) => T): T {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-home-"));
	tempDirs.push(home);
	const oldHome = process.env.HOME;
	const oldUserProfile = process.env.USERPROFILE;
	const oldPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	try {
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = oldUserProfile;
		if (oldPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldPiCodingAgentDir;
		if (oldExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = oldExtraAgentDirs;
	}
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("agent permission frontmatter", () => {
	it("preserves nested permission YAML blocks through discovery and serialization", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-permission-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
tools: bash,read,write
permission:
  "*": ask
  read: allow
  bash:
    "*": ask
    "git *": allow
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");
		assert.equal(worker?.extraFields?.permission, `"*": ask
read: allow
bash:
  "*": ask
  "git *": allow`);

		const serialized = serializeAgent(worker!);
		assert.match(serialized, /^permission:\n  "\*": ask\n  read: allow\n  bash:\n    "\*": ask\n    "git \*": allow$/m);
	});
});

describe("agent frontmatter defaultContext", () => {
	it("serializes defaultContext into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "worker",
			description: "Worker",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/worker.md",
			defaultContext: "fork",
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /defaultContext: fork/);
	});

	it("parses defaultContext from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-default-context-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
defaultContext: fork
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");
		assert.equal(worker?.defaultContext, "fork");
	});

	it("loads packaged planner, worker, and oracle with fork defaultContext", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-default-context-"));
		tempDirs.push(dir);
		const agents = discoverAgentsAll(dir).builtin;

		for (const name of ["planner", "worker", "oracle"]) {
			const agent = agents.find((candidate) => candidate.name === name);
			assert.equal(agent?.defaultContext, "fork", `${name} should default to fork context`);
		}
	});
});

describe("agent frontmatter completionGuard", () => {
	it("serializes disabled completion guard into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "test-runner",
			description: "Test runner",
			systemPrompt: "Validate changes",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/test-runner.md",
			completionGuard: false,
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /completionGuard: false/);
	});

	it("omits enabled completion guard from serialized frontmatter", () => {
		const agent: AgentConfig = {
			name: "test-runner",
			description: "Test runner",
			systemPrompt: "Validate changes",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/test-runner.md",
			completionGuard: true,
		};

		const serialized = serializeAgent(agent);
		assert.doesNotMatch(serialized, /completionGuard:/);
	});

	it("parses completionGuard from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-completion-guard-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "test-runner.md"), `---
name: test-runner
description: Test runner
completionGuard: false
---

Validate changes
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const runner = result.agents.find((agent) => agent.name === "test-runner");
		assert.equal(runner?.completionGuard, false);
		assert.equal(runner?.extraFields?.completionGuard, undefined);
	});
});

describe("agent frontmatter maxSubagentDepth", () => {
	it("serializes maxSubagentDepth into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "scout",
			description: "Scout",
			systemPrompt: "Inspect code",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/scout.md",
			maxSubagentDepth: 1,
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /maxSubagentDepth: 1/);
	});

	it("parses maxSubagentDepth from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
description: Scout
maxSubagentDepth: 1
---

Inspect code
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const scout = result.agents.find((agent) => agent.name === "scout");
		assert.equal(scout?.maxSubagentDepth, 1);
	});
});

describe("agent frontmatter thinking", () => {
	it("coerces frontmatter false strings to disabled thinking", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-thinking-false-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		for (const [name, value] of [["unquoted", "false"], ["quoted", "\"false\""]] as const) {
			fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---
name: ${name}
description: ${name}
model: glm-5.2-short-fast
thinking: ${value}
---

Do work
`, "utf-8");
		}

		const agents = discoverAgents(dir, "project").agents;
		for (const name of ["unquoted", "quoted"]) {
			const agent = agents.find((candidate) => candidate.name === name);
			assert.ok(agent);
			assert.equal(agent.thinking, false);

			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				model: agent.model,
				thinking: agent.thinking,
				inheritProjectContext: agent.inheritProjectContext,
				inheritSkills: agent.inheritSkills,
			});

			assert.ok(args.includes("--model"));
			assert.ok(args.includes("glm-5.2-short-fast"));
			assert.ok(!args.some((arg) => arg.includes(":false")));
		}
	});

	it("preserves supported frontmatter thinking strings", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-thinking-levels-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		for (const level of THINKING_LEVELS) {
			fs.writeFileSync(path.join(agentsDir, `${level}.md`), `---
name: thinker-${level}
description: Thinking ${level}
thinking: ${level}
---

Do work
`, "utf-8");
		}

		const agents = discoverAgents(dir, "project").agents;
		for (const level of THINKING_LEVELS) {
			const agent = agents.find((candidate) => candidate.name === `thinker-${level}`);
			assert.ok(agent);
			assert.equal(agent.thinking, level);
		}
	});
});

describe("agent frontmatter fallbackModels", () => {
	it("serializes fallbackModels into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "worker",
			description: "Worker",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/worker.md",
			fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /fallbackModels: openai\/gpt-5-mini, anthropic\/claude-sonnet-4/);
	});

	it("parses fallbackModels from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-fallback-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");
		assert.deepEqual(worker?.fallbackModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
	});
});

describe("agent frontmatter systemPromptMode", () => {
	it("serializes systemPromptMode into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "worker",
			description: "Worker",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/worker.md",
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /systemPromptMode: replace/);
	});

	it("parses systemPromptMode from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-prompt-mode-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
systemPromptMode: replace
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");
		assert.equal(worker?.systemPromptMode, "replace");
	});
});

describe("agent frontmatter prompt inheritance flags", () => {
	it("serializes inheritProjectContext and inheritSkills into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "worker",
			description: "Worker",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: true,
			source: "project",
			filePath: "/tmp/worker.md",
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /inheritProjectContext: true/);
		assert.match(serialized, /inheritSkills: true/);
	});

	it("parses inheritProjectContext and inheritSkills from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-prompt-inheritance-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
inheritProjectContext: true
inheritSkills: true
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");
		assert.equal(worker?.inheritProjectContext, true);
		assert.equal(worker?.inheritSkills, true);
	});
});

describe("agent frontmatter subagentOnlyExtensions", () => {
	it("serializes subagentOnlyExtensions into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "worker",
			description: "Worker",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/worker.md",
			subagentOnlyExtensions: ["./tools/child-search.ts", "/opt/pi/child-only.ts"],
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /subagentOnlyExtensions: \.\/tools\/child-search\.ts, \/opt\/pi\/child-only\.ts/);
	});

	it("parses subagentOnlyExtensions from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-child-ext-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
subagentOnlyExtensions: ./tools/child-search.ts, /opt/pi/child-only.ts
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");
		assert.deepEqual(worker?.subagentOnlyExtensions, ["./tools/child-search.ts", "/opt/pi/child-only.ts"]);
	});
});

