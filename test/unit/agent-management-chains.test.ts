import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleCreate, handleManagementAction, handleUpdate } from "../../src/agents/agent-management.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";

let tempDir = "";
let oldAgentDir: string | undefined;

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.ok(first);
	assert.equal(first.type, "text");
	assert.equal(typeof first.text, "string");
	return first.text;
}

describe("agent management config parsing", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-management-"));
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-home");
		clearSkillCache();
	});

	afterEach(() => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		clearSkillCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("updates JSON chain descriptions without rewriting them as markdown", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const chainPath = path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json");
		fs.mkdirSync(path.dirname(chainPath), { recursive: true });
		fs.writeFileSync(chainPath, JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
				},
			],
		}), "utf-8");

		const updated = handleUpdate({ chainName: "dynamic-review", config: { description: "Updated dynamic review" } }, ctx);

		assert.equal(updated.isError, false);
		const content = fs.readFileSync(chainPath, "utf-8");
		assert.doesNotMatch(content, /^---/);
		const parsed = JSON.parse(content) as { description?: string; chain?: Array<{ collect?: { as?: string } }> };
		assert.equal(parsed.description, "Updated dynamic review");
		assert.equal(parsed.chain?.[1]?.collect?.as, "reviews");
	});

	it("renames and repackages JSON chains while preserving JSON format and extension", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const chainPath = path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json");
		fs.mkdirSync(path.dirname(chainPath), { recursive: true });
		fs.writeFileSync(chainPath, JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [{ agent: "scout", task: "Return targets" }],
		}), "utf-8");

		const updated = handleUpdate({ chainName: "dynamic-review", config: { name: "Review Flow", package: "Code Analysis" } }, ctx);

		assert.equal(updated.isError, false);
		const updatedPath = path.join(tempDir, ".pi", "chains", "code-analysis.review-flow.chain.json");
		assert.equal(fs.existsSync(chainPath), false);
		const content = fs.readFileSync(updatedPath, "utf-8");
		assert.doesNotMatch(content, /^---/);
		const parsed = JSON.parse(content) as { name?: string; package?: string; chain?: Array<{ agent?: string }> };
		assert.equal(parsed.name, "review-flow");
		assert.equal(parsed.package, "code-analysis");
		assert.equal(parsed.chain?.[0]?.agent, "scout");
	});

	it("gets dynamic JSON chain details and lists invalid chain diagnostics", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		fs.mkdirSync(path.join(tempDir, ".pi", "chains"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json"), JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
				},
			],
		}), "utf-8");
		fs.writeFileSync(path.join(tempDir, ".pi", "chains", "broken.chain.json"), "{", "utf-8");

		const got = handleManagementAction("get", { chainName: "dynamic-review" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Dynamic fanout -> reviews/);
		assert.match(readText(got), /Expand: targets\/items/);
		assert.match(readText(got), /Agent: reviewer/);

		const listed = handleManagementAction("list", {}, ctx);
		assert.equal(listed.isError, false);
		assert.match(readText(listed), /Chain diagnostics:/);
		assert.match(readText(listed), /broken\.chain\.json/);
		assert.match(readText(listed), /Invalid JSON chain/);
	});

	it("reports builtin runtime-loaded model mappings from current session state", () => {
		const ctx = {
			cwd: tempDir,
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai", id: "gpt-5-mini" },
					{ provider: "anthropic", id: "claude-sonnet-4" },
				],
			},
			model: { provider: "openai", id: "gpt-5-mini" },
		};

		const result = handleManagementAction("models", {}, ctx);
		const text = readText(result);
		assert.equal(result.isError, false);
		assert.match(text, /^Builtin subagent models/m);
		assert.match(text, /Current session model:\n  openai\/gpt-5-mini/);
		assert.match(text, /(?:^|\n)scout\n  model:\n    openai\/gpt-5-mini\n  source: inherits current session model(?:\n|$)/);
	});

	it("reports override source and disabled builtin state in runtime model mappings", () => {
		const projectSettingsPath = path.join(tempDir, ".pi", "settings.json");
		fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
		fs.writeFileSync(projectSettingsPath, JSON.stringify({
			subagents: {
				agentOverrides: {
					reviewer: { model: "claude-sonnet-4", disabled: true },
				},
			},
		}, null, 2), "utf-8");

		const ctx = {
			cwd: tempDir,
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai", id: "gpt-5-mini" },
					{ provider: "anthropic", id: "claude-sonnet-4" },
				],
			},
			model: { provider: "openai", id: "gpt-5-mini" },
		};

		const result = handleManagementAction("models", { agent: "reviewer" }, ctx);
		const text = readText(result);
		assert.equal(result.isError, false);
		assert.match(text, /^Builtin subagent model/m);
		assert.match(text, /Agent: reviewer/);
		assert.match(text, /Effective model:\n  anthropic\/claude-sonnet-4/);
		assert.match(text, /Source: project override/);
		assert.match(text, /Requested model setting:\n  claude-sonnet-4/);
		assert.match(text, /Disabled: true/);
		assert.match(text.replaceAll("\\", "/"), /Override file:\n  .*\.pi\/settings\.json/);
	});

	it("rejects unknown builtin filters for runtime model mappings", () => {
		const result = handleManagementAction("models", { agent: "not-a-builtin" }, {
			cwd: tempDir,
			modelRegistry: { getAvailable: () => [] },
		});

		assert.equal(result.isError, true);
		assert.match(readText(result), /Builtin agent 'not-a-builtin' not found/);
	});

	it("creates delegate with its builtin prompt defaults", () => {
		const result = handleCreate(
			{ config: { name: "delegate", description: "Delegate helper", scope: "project" } },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "delegate.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /systemPromptMode: append/);
		assert.match(content, /inheritProjectContext: true/);
		assert.match(content, /inheritSkills: false/);
	});

	it("lists proactive skill subagent suggestions from repeated configured skill use", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, ".pi", "skills", "deslop"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "skills", "deslop", "SKILL.md"), `---
description: Cleanup review.
---

Review for cleanup.
`, "utf-8");
		for (const name of ["cleanup-a", "cleanup-b"]) {
			fs.writeFileSync(path.join(tempDir, ".pi", "agents", `${name}.md`), `---
name: ${name}
description: Cleanup ${name}
skills: deslop
---

Inspect cleanup.
`, "utf-8");
		}

		const listed = handleManagementAction("list", {}, ctx);
		const text = readText(listed);
		assert.match(text, /Proactive skill subagent suggestions:/);
		assert.match(text, /- deslop via reviewer/);
		assert.match(text, /Cleanup review\./);
	});

	it("can disable proactive skill subagent suggestions in config", () => {
		const ctx = {
			cwd: tempDir,
			modelRegistry: { getAvailable: () => [] },
			config: { proactiveSkillSubagents: false },
		};
		fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, ".pi", "skills", "deslop"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "skills", "deslop", "SKILL.md"), "Review for cleanup.\n", "utf-8");
		for (const name of ["cleanup-a", "cleanup-b"]) {
			fs.writeFileSync(path.join(tempDir, ".pi", "agents", `${name}.md`), `---
name: ${name}
description: Cleanup ${name}
skills: deslop
---

Inspect cleanup.
`, "utf-8");
		}

		const listed = handleManagementAction("list", {}, ctx);
		assert.doesNotMatch(readText(listed), /Proactive skill subagent suggestions:/);
	});

});
