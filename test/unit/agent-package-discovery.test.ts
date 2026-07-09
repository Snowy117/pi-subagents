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

describe("chain discovery", () => {
	it("prefers same-scope .chain.json over .chain.md for the same runtime name", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-chain-format-precedence-"));
		tempDirs.push(dir);
		const chainsDir = path.join(dir, ".pi", "chains");
		fs.mkdirSync(chainsDir, { recursive: true });
		fs.writeFileSync(path.join(chainsDir, "dynamic-review.chain.md"), `---
name: dynamic-review
description: Markdown fallback
---

## scout

Run the markdown chain
`, "utf-8");
		fs.writeFileSync(path.join(chainsDir, "dynamic-review.chain.json"), JSON.stringify({
			name: "dynamic-review",
			description: "JSON dynamic chain",
			chain: [
				{
					agent: "scout",
					task: "Return targets",
					as: "targets",
					outputSchema: { type: "object" },
				},
				{
					expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {item.path}" },
					collect: { as: "reviews" },
				},
			],
		}), "utf-8");

		const result = discoverAgentsAll(dir);
		const chain = result.chains.find((candidate) => candidate.name === "dynamic-review");
		assert.equal(chain?.description, "JSON dynamic chain");
		assert.equal(chain?.filePath.endsWith(".chain.json"), true);
		assert.equal("expand" in (chain?.steps[1] ?? {}), true);
	});
});

describe("package-provided agents and chains", () => {
	it("discovers package agents and chains from installed package manifests", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-discovery-"));
		tempDirs.push(dir);
		const workflowRoot = path.join(dir, ".pi", "npm", "node_modules", "my-pi-workflow");
		const chainsRoot = path.join(dir, ".pi", "npm", "node_modules", "@scope", "chain-workflow");
		writeJson(path.join(workflowRoot, "package.json"), {
			name: "my-pi-workflow",
			"pi-subagents": {
				agents: ["./agents"],
			},
		});
		writeAgent(path.join(workflowRoot, "agents", "reviewer.md"), `---
name: reviewer
package: my-workflow
description: Review changes for this workflow.
---

Review the workflow.
`);
		writeJson(path.join(chainsRoot, "package.json"), {
			name: "@scope/chain-workflow",
			pi: {
				subagents: {
					chains: ["./chains"],
				},
			},
		});
		writeAgent(path.join(chainsRoot, "chains", "review.chain.md"), `---
name: review
package: my-workflow
description: Run workflow review.
---

## my-workflow.reviewer

Review the task.
`);

		const all = discoverAgentsAll(dir);
		const packagedAgent = all.package.find((agent) => agent.name === "my-workflow.reviewer");
		assert.ok(packagedAgent);
		assert.equal(packagedAgent.source, "package");
		assert.equal(packagedAgent.filePath, path.join(workflowRoot, "agents", "reviewer.md"));
		assert.equal(discoverAgents(dir, "both").agents.find((agent) => agent.name === "my-workflow.reviewer")?.source, "package");

		const packagedChain = all.chains.find((chain) => chain.name === "my-workflow.review");
		assert.ok(packagedChain);
		assert.equal(packagedChain.source, "package");
		assert.equal(packagedChain.steps[0]?.agent, "my-workflow.reviewer");
	}));

	it("loads packages referenced from Pi settings", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-settings-package-"));
		tempDirs.push(dir);
		const packageRoot = path.join(dir, ".pi", "vendor", "workflow");
		writeJson(path.join(dir, ".pi", "settings.json"), {
			packages: [{ source: "file:./vendor/workflow" }],
		});
		writeJson(path.join(packageRoot, "package.json"), {
			name: "settings-workflow",
			pi: {
				subagents: {
					agents: ["./agents"],
				},
			},
		});
		writeAgent(path.join(packageRoot, "agents", "planner.md"), `---
name: planner
package: settings-workflow
description: Plan from a settings-installed package.
---

Plan the work.
`);

		const agent = discoverAgents(dir, "both").agents.find((candidate) => candidate.name === "settings-workflow.planner");
		assert.ok(agent);
		assert.equal(agent.source, "package");
	}));

	it("discovers project package agents when cwd is nested below the project root", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-nested-package-discovery-"));
		tempDirs.push(dir);
		const nested = path.join(dir, "packages", "app", "src");
		const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "nested-workflow");
		fs.mkdirSync(nested, { recursive: true });
		writeJson(path.join(packageRoot, "package.json"), {
			name: "nested-workflow",
			"pi-subagents": {
				agents: ["./agents"],
			},
		});
		writeAgent(path.join(packageRoot, "agents", "reviewer.md"), `---
name: reviewer
package: nested-workflow
description: Review from a project package.
---

Review nested project work.
`);

		const agent = discoverAgents(nested, "both").agents.find((candidate) => candidate.name === "nested-workflow.reviewer");
		assert.ok(agent);
		assert.equal(agent.source, "package");
		assert.equal(agent.filePath, path.join(packageRoot, "agents", "reviewer.md"));
	}));

	it("does not register legacy skill files from broad package agent roots", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-broad-package-skills-"));
		tempDirs.push(dir);
		const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "broad-workflow");
		writeJson(path.join(packageRoot, "package.json"), {
			name: "broad-workflow",
			"pi-subagents": {
				agents: ["."],
			},
		});
		writeAgent(path.join(packageRoot, "agent.md"), `---
name: package-agent
description: Package agent
---

Package prompt
`);
		writeAgent(path.join(packageRoot, ".agents", "skills", "package-skill", "SKILL.md"), `---
name: package-skill
description: Package skill
---

Skill prompt
`);
		writeAgent(path.join(packageRoot, "agents", "SKILL.md"), `---
name: skill-named-package-agent
description: Skill-named package agent
---

Agent prompt
`);

		const packageAgents = discoverAgentsAll(dir).package;
		assert.ok(packageAgents.find((agent) => agent.name === "package-agent" && agent.filePath === path.join(packageRoot, "agent.md")));
		assert.ok(packageAgents.find((agent) => agent.name === "skill-named-package-agent" && agent.filePath === path.join(packageRoot, "agents", "SKILL.md")));
		assert.equal(packageAgents.some((agent) => agent.filePath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)), false);
		assert.equal(packageAgents.some((agent) => agent.name === "package-skill"), false);
	}));

	it("keeps package definitions below user and project overrides", () => withTempHome((home) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-precedence-"));
		tempDirs.push(dir);
		const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "override-workflow");
		writeJson(path.join(packageRoot, "package.json"), {
			name: "override-workflow",
			"pi-subagents": {
				agents: ["./agents"],
				chains: ["./chains"],
			},
		});
		writeAgent(path.join(packageRoot, "agents", "scout.md"), `---
name: scout
description: Package scout
---

Package scout.
`);
		writeAgent(path.join(packageRoot, "chains", "shared.chain.md"), `---
name: shared
description: Package chain
---

## scout

Package chain.
`);
		writeAgent(path.join(home, ".pi", "agent", "agents", "scout.md"), `---
name: scout
description: User scout
---

User scout.
`);
		writeAgent(path.join(dir, ".pi", "agents", "scout.md"), `---
name: scout
description: Project scout
---

Project scout.
`);
		writeAgent(path.join(home, ".pi", "agent", "chains", "shared.chain.md"), `---
name: shared
description: User chain
---

## scout

User chain.
`);
		writeAgent(path.join(dir, ".pi", "chains", "shared.chain.md"), `---
name: shared
description: Project chain
---

## scout

Project chain.
`);

		assert.equal(discoverAgents(dir, "user").agents.find((agent) => agent.name === "scout")?.source, "user");
		assert.equal(discoverAgents(dir, "project").agents.find((agent) => agent.name === "scout")?.source, "project");
		const chainByName = new Map(discoverAgentsAll(dir).chains.map((chain) => [chain.name, chain]));
		assert.equal(chainByName.get("shared")?.source, "project");
	}));

	it("does not allow management updates to package agents", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-readonly-"));
		tempDirs.push(dir);
		const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "readonly-workflow");
		writeJson(path.join(packageRoot, "package.json"), {
			name: "readonly-workflow",
			"pi-subagents": {
				agents: ["./agents"],
			},
		});
		writeAgent(path.join(packageRoot, "agents", "reviewer.md"), `---
name: reviewer
package: readonly-workflow
description: Read-only package reviewer.
---

Review only.
`);

		const result = handleManagementAction("update", {
			agent: "readonly-workflow.reviewer",
			config: { description: "Changed" },
		}, {
			cwd: dir,
			modelRegistry: { getAvailable: () => [] },
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /read-only/);
	}));
});

