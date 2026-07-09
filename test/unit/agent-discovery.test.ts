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

describe("packaged agent and chain discovery", () => {
	it("recursively discovers nested project agents while keeping chain files separate", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-recursive-agent-discovery-"));
		tempDirs.push(dir);
		const nestedDir = path.join(dir, ".pi", "agents", "code-analysis", "deep");
		const nestedChainDir = path.join(dir, ".pi", "chains", "code-analysis", "deep");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.mkdirSync(nestedChainDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "scout.md"), `---
name: scout
description: Nested scout
---

Inspect code
`, "utf-8");
		fs.writeFileSync(path.join(nestedChainDir, "review.chain.md"), `---
name: review-flow
description: Review flow
---

## scout

Review
`, "utf-8");

		const result = discoverAgentsAll(dir);
		assert.ok(result.project.find((agent) => agent.name === "scout" && agent.filePath === path.join(nestedDir, "scout.md")));
		assert.ok(result.chains.find((chain) => chain.name === "review-flow" && chain.filePath === path.join(nestedChainDir, "review.chain.md")));
		assert.equal(result.project.some((agent) => agent.filePath.endsWith("review.chain.md")), false);
	});

	it("registers packaged agents by runtime name and serializes local name plus package", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-agent-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect code
`, "utf-8");

		const scout = discoverAgents(dir, "project").agents.find((agent) => agent.name === "code-analysis.scout");
		assert.ok(scout);
		assert.equal(scout.localName, "scout");
		assert.equal(scout.packageName, "code-analysis");
		const serialized = serializeAgent(scout);
		assert.match(serialized, /^name: scout$/m);
		assert.match(serialized, /^package: code-analysis$/m);
		assert.doesNotMatch(serialized, /^name: code-analysis\.scout$/m);
	});

	it("recursively discovers packaged chains by runtime name and preserves package on serialize", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-chain-"));
		tempDirs.push(dir);
		const nestedDir = path.join(dir, ".pi", "chains", "flows");
		fs.mkdirSync(nestedDir, { recursive: true });
		const content = `---
name: review-flow
package: code-analysis
description: Review flow
---

## code-analysis.scout

Inspect {task}
`;
		fs.writeFileSync(path.join(nestedDir, "review.chain.md"), content, "utf-8");

		const chain = discoverAgentsAll(dir).chains.find((candidate) => candidate.name === "code-analysis.review-flow");
		assert.ok(chain);
		assert.equal(chain.localName, "review-flow");
		assert.equal(chain.packageName, "code-analysis");
		assert.equal(chain.steps[0]?.agent, "code-analysis.scout");
		const serialized = serializeChain(chain);
		assert.match(serialized, /^name: review-flow$/m);
		assert.match(serialized, /^package: code-analysis$/m);
		assert.match(serialized, /^## code-analysis\.scout$/m);
		assert.doesNotMatch(serialized, /^name: code-analysis\.review-flow$/m);
	});

	it("keeps packaged and un-packaged runtime names distinct while preserving un-packaged precedence", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-collisions-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".agents", "scout.md"), `---
name: scout
description: Legacy scout
---

Legacy
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "scout.md"), `---
name: scout
description: Project scout
---

Project
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "packaged.md"), `---
name: scout
package: code-analysis
description: Packaged scout
---

Packaged
`, "utf-8");

		const agents = discoverAgents(dir, "project").agents;
		const unqualified = agents.find((agent) => agent.name === "scout");
		const packaged = agents.find((agent) => agent.name === "code-analysis.scout");
		assert.equal(unqualified?.description, "Project scout");
		assert.equal(unqualified?.filePath, path.join(dir, ".pi", "agents", "scout.md"));
		assert.equal(packaged?.description, "Packaged scout");
	});

	it("parses packaged chains directly from serializer helpers", () => {
		const parsed = parseChain(`---
name: review-flow
package: code-analysis
description: Review flow
---

## code-analysis.scout

Inspect
`, "project", "/tmp/review.chain.md");

		assert.equal(parsed.name, "code-analysis.review-flow");
		assert.equal(parsed.localName, "review-flow");
		assert.equal(parsed.packageName, "code-analysis");
		assert.match(serializeChain(parsed), /^name: review-flow$/m);
	});

	it("normalizes package frontmatter consistently for agents and chains", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-normalize-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		const chainsDir = path.join(dir, ".pi", "chains");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.mkdirSync(chainsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
package: Code Analysis!
description: Fast recon
---

Inspect
`, "utf-8");
		fs.writeFileSync(path.join(chainsDir, "review.chain.md"), `---
name: review-flow
package: Code Analysis!
description: Review flow
---

## code-analysis.scout

Review
`, "utf-8");

		const result = discoverAgentsAll(dir);
		assert.ok(result.project.find((agent) => agent.name === "code-analysis.scout"));
		assert.ok(result.chains.find((chain) => chain.name === "code-analysis.review-flow"));
	});

	it("skips invalid package frontmatter that cannot be normalized", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-invalid-package-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		const chainsDir = path.join(dir, ".pi", "chains");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.mkdirSync(chainsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
package: !!!
description: Fast recon
---

Inspect
`, "utf-8");
		fs.writeFileSync(path.join(chainsDir, "review.chain.md"), `---
name: review-flow
package: !!!
description: Review flow
---

## scout

Review
`, "utf-8");

		const result = discoverAgentsAll(dir);
		assert.equal(result.project.some((agent) => agent.filePath.endsWith("scout.md")), false);
		assert.equal(result.chains.some((chain) => chain.filePath.endsWith("review.chain.md")), false);
	});
});

describe("project agent directory discovery", () => {
	it("discovers project agents from both .agents and .pi/agents", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-dirs-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".agents", "skills"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".agents", "legacy.md"), `---
name: legacy
description: Legacy
---

Legacy prompt
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "canonical.md"), `---
name: canonical
description: Canonical
---

Canonical prompt
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "SKILL.md"), `---
name: skill-named-agent
description: Skill-named agent
---

Skill-named agent prompt
`, "utf-8");

		const result = discoverAgents(dir, "project");
		assert.ok(result.agents.find((agent) => agent.name === "legacy" && agent.filePath === path.join(dir, ".agents", "legacy.md")));
		assert.ok(result.agents.find((agent) => agent.name === "canonical" && agent.filePath === path.join(dir, ".pi", "agents", "canonical.md")));
		assert.ok(result.agents.find((agent) => agent.name === "skill-named-agent" && agent.filePath === path.join(dir, ".pi", "agents", "SKILL.md")));
		assert.equal(result.projectAgentsDir, path.join(dir, ".pi", "agents"));
	});

	it("does not register legacy project skill files as agents", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-skills-not-agents-"));
		tempDirs.push(dir);
		writeAgent(path.join(dir, ".agents", "legacy.md"), `---
name: legacy
description: Legacy
---

Legacy prompt
`);
		writeAgent(path.join(dir, ".agents", "skills", "directory-skill", "SKILL.md"), `---
name: directory-skill
description: Directory skill
---

Skill prompt
`);
		writeAgent(path.join(dir, ".agents", "skills", "file-skill.md"), `---
name: file-skill
description: File skill
---

Skill prompt
`);

		const agents = discoverAgents(dir, "project").agents;
		assert.ok(agents.find((agent) => agent.name === "legacy"));
		assert.equal(agents.some((agent) => agent.filePath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)), false);
		assert.equal(agents.some((agent) => agent.name === "directory-skill"), false);
		assert.equal(agents.some((agent) => agent.name === "file-skill"), false);
	});

	it("does not register user SKILL.md files as agents", () => withTempHome((home) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-user-skills-not-agents-"));
		tempDirs.push(dir);
		writeAgent(path.join(home, ".agents", "user-agent.md"), `---
name: user-agent
description: User agent
---

User prompt
`);
		writeAgent(path.join(home, ".agents", "skills", "user-skill", "SKILL.md"), `---
name: user-skill
description: User skill
---

Skill prompt
`);

		const agents = discoverAgents(dir, "user").agents;
		assert.ok(agents.find((agent) => agent.name === "user-agent"));
		assert.equal(agents.some((agent) => agent.filePath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)), false);
		assert.equal(agents.some((agent) => agent.name === "user-skill"), false);
	}));

	it("prefers .pi/agents over .agents on project agent name collisions", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-collision-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".agents", "shared.md"), `---
name: shared
description: Legacy shared
---

Legacy prompt
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "shared.md"), `---
name: shared
description: Canonical shared
---

Canonical prompt
`, "utf-8");

		const shared = discoverAgents(dir, "project").agents.find((agent) => agent.name === "shared");
		assert.ok(shared);
		assert.equal(shared.filePath, path.join(dir, ".pi", "agents", "shared.md"));
		assert.equal(shared.description, "Canonical shared");
		assert.equal(shared.systemPrompt.trim(), "Canonical prompt");
	});

	it("uses the project root for the canonical project agent dir even when only .agents exists", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-root-"));
		tempDirs.push(dir);
		const nested = path.join(dir, "packages", "app");
		fs.mkdirSync(path.join(dir, ".agents", "skills"), { recursive: true });
		fs.mkdirSync(nested, { recursive: true });

		const result = discoverAgentsAll(nested);
		assert.equal(result.projectDir, path.join(dir, ".pi", "agents"));
	});

	it("discovers project chains from .pi/chains", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-chain-dirs-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi", "chains", "flows"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".pi", "agents", "ignored.chain.md"), `---
name: ignored-chain
description: Ignored chain
---

## scout

Ignore
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "chains", "flows", "canonical.chain.md"), `---
name: canonical-chain
description: Canonical chain
---

## worker

Inspect canonical
`, "utf-8");

		const result = discoverAgentsAll(dir);
		assert.equal(result.chains.some((chain) => chain.name === "ignored-chain"), false);
		assert.ok(result.chains.find((chain) => chain.name === "canonical-chain" && chain.filePath === path.join(dir, ".pi", "chains", "flows", "canonical.chain.md")));
		assert.equal(result.projectDir, path.join(dir, ".pi", "agents"));
		assert.equal(result.projectChainDir, path.join(dir, ".pi", "chains"));
	});

	it("prefers project .pi/chains over user chains on name collisions", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-chain-collision-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-user-chain-home-"));
		tempDirs.push(dir, home);
		const oldHome = process.env.HOME;
		const oldUserProfile = process.env.USERPROFILE;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		try {
			const userChainsDir = path.join(home, ".pi", "agent", "chains");
			fs.mkdirSync(userChainsDir, { recursive: true });
			fs.mkdirSync(path.join(dir, ".pi", "chains"), { recursive: true });
			fs.writeFileSync(path.join(userChainsDir, "shared.chain.md"), `---
name: shared-chain
description: User chain
---

## scout

Inspect user
`, "utf-8");
			fs.writeFileSync(path.join(dir, ".pi", "chains", "shared.chain.md"), `---
name: shared-chain
description: Project chain
---

## worker

Inspect project
`, "utf-8");

			const sharedChains = discoverAgentsAll(dir).chains.filter((chain) => chain.name === "shared-chain");
			assert.equal(sharedChains.length, 2);
			assert.deepEqual(sharedChains.map((chain) => chain.source), ["user", "project"]);
			const savedChainLookup = new Map(sharedChains.map((chain) => [chain.name, chain]));
			const shared = savedChainLookup.get("shared-chain");
			assert.ok(shared);
			assert.equal(shared.filePath, path.join(dir, ".pi", "chains", "shared.chain.md"));
			assert.equal(shared.description, "Project chain");
			assert.equal(shared.steps[0]?.agent, "worker");
			assert.equal(shared.steps[0]?.task, "Inspect project");
		} finally {
			if (oldHome === undefined) delete process.env.HOME;
			else process.env.HOME = oldHome;
			if (oldUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = oldUserProfile;
		}
	});
});
