import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverPromptWorkflows } from "../../src/slash/prompt-workflow-discovery.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function writePrompt(dir: string, name: string, content: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.md`), content, "utf-8");
}

describe("prompt workflow discovery", () => {
	let tempDir = "";
	let agentDir = "";
	let cwd = "";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-workflows-"));
		agentDir = path.join(tempDir, "agent");
		cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers project workflows over user workflows", () => {
		writePrompt(path.join(agentDir, "prompts"), "native-test", `---
description: User version
subagent: user-specialist
---
User body
`);
		writePrompt(path.join(cwd, ".pi", "prompts"), "native-test", `---
description: Project version
subagent: project-specialist
model: openai/gpt-5-mini
---
Project body $1
`);

		const workflow = discoverPromptWorkflows(cwd).find((entry) => entry.name === "native-test");

		assert.equal(workflow?.description, "Project version");
		assert.equal(workflow?.agent, "project-specialist");
		assert.equal(workflow?.model, "openai/gpt-5-mini");
	});

	it("keeps user prompt discovery with neutral delegate defaults", () => {
		writePrompt(path.join(agentDir, "prompts"), "user-prompt", `---
description: User prompt
---
Inspect the target
`);

		const workflow = discoverPromptWorkflows(cwd).find((entry) => entry.name === "user-prompt");

		assert.equal(workflow?.description, "User prompt");
		assert.equal(workflow?.agent, "delegate");
		assert.equal(workflow?.body.trim(), "Inspect the target");
	});

	it("does not reserve names from removed package commands", () => {
		writePrompt(path.join(cwd, ".pi", "prompts"), "run", `---
description: Project-owned run prompt
---
Run the project workflow
`);

		const workflow = discoverPromptWorkflows(cwd).find((entry) => entry.name === "run");

		assert.equal(workflow?.description, "Project-owned run prompt");
		assert.equal(workflow?.agent, "delegate");
	});
});
