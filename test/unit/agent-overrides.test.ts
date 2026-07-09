import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildBuiltinOverrideConfig, discoverAgents, discoverAgentsAll, removeBuiltinAgentOverride } from "../../src/agents/agents.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeProjectAgent(cwd: string, name: string, body: string): void {
	const filePath = path.join(cwd, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

function writeUserAgent(home: string, name: string, body: string): void {
	const filePath = path.join(home, ".pi", "agent", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

describe("builtin agent overrides", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		if (originalExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = originalExtraAgentDirs;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("bundled builtin agents inherit the default model", () => {
		const builtins = discoverAgentsAll(tempProject).builtin;
		assert.ok(builtins.length > 0);
		assert.deepEqual(
			builtins
				.filter((agent) => agent.model !== undefined || agent.fallbackModels !== undefined)
				.map((agent) => agent.name),
			[],
		);
	});

	it("applies subagents.defaultModel to builtin agents with explicit overrides winning", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultModel: "deepseek-v4-flash",
				agentOverrides: {
					oracle: { model: "deepseek-v4-pro" },
					reviewer: { model: false },
				},
			},
		});

		const builtins = discoverAgentsAll(tempProject).builtin;
		const scout = builtins.find((agent) => agent.name === "scout");
		assert.equal(scout?.model, "deepseek-v4-flash");
		assert.equal(scout?.modelSource?.type, "subagents.defaultModel");
		assert.equal(scout?.modelSource?.scope, "user");
		assert.equal(builtins.find((agent) => agent.name === "worker")?.model, "deepseek-v4-flash");
		assert.equal(builtins.find((agent) => agent.name === "oracle")?.model, "deepseek-v4-pro");
		assert.equal(builtins.find((agent) => agent.name === "reviewer")?.model, undefined);
	});

	it("prefers project subagents.defaultModel over user defaultModel", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultModel: "deepseek-v4-flash" },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { defaultModel: "deepseek-v4-pro" },
		});

		const worker = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "worker");
		assert.ok(worker);
		assert.equal(worker.model, "deepseek-v4-pro");
	});

	it("applies subagents.defaultModel to custom agents without a frontmatter model", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultModel: "deepseek-v4-flash",
				agentOverrides: {
					implementer: { model: "deepseek-v4-pro" },
				},
			},
		});
		writeProjectAgent(tempProject, "implementer", `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`);
		writeProjectAgent(tempProject, "auditor", `---\nname: auditor\ndescription: Audit code\nmodel: google/gemini-3-pro\n---\n\nAudit the code.\n`);
		writeProjectAgent(tempProject, "scout-copy", `---\nname: scout-copy\ndescription: Scout code\n---\n\nScout the code.\n`);

		const agents = discoverAgents(tempProject, "both").agents;
		assert.equal(agents.find((agent) => agent.name === "implementer")?.model, "deepseek-v4-pro");
		assert.equal(agents.find((agent) => agent.name === "auditor")?.model, "google/gemini-3-pro");
		assert.equal(agents.find((agent) => agent.name === "scout-copy")?.model, "deepseek-v4-flash");
	});

	it("applies user settings overrides to builtin agents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: {
						model: "openai/gpt-5.4",
						thinking: "xhigh",
						systemPromptMode: "replace",
						inheritProjectContext: true,
						inheritSkills: true,
						subagentOnlyExtensions: ["./tools/child-review.ts"],
						completionGuard: false,
					},
				},
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.source, "builtin");
		assert.equal(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.thinking, "xhigh");
		assert.equal(reviewer.systemPromptMode, "replace");
		assert.equal(reviewer.inheritProjectContext, true);
		assert.equal(reviewer.inheritSkills, true);
		assert.deepEqual(reviewer.subagentOnlyExtensions, ["./tools/child-review.ts"]);
		assert.equal(reviewer.completionGuard, false);
		assert.equal(reviewer.override?.scope, "user");
		assert.equal(reviewer.override?.path, path.join(tempHome, ".pi", "agent", "settings.json"));
	});

	it("globally disables builtin thinking suffix defaults from user settings", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				disableThinking: true,
			},
		});

		const builtins = discoverAgentsAll(tempProject).builtin;
		assert.ok(builtins.some((agent) => agent.name === "reviewer"));
		assert.deepEqual(
			builtins
				.filter((agent) => agent.thinking !== undefined)
				.map((agent) => agent.name),
			[],
		);
		assert.equal(
			builtins.find((agent) => agent.name === "reviewer")?.override?.path,
			path.join(tempHome, ".pi", "agent", "settings.json"),
		);
	});

	it("lets an explicit same-scope thinking override opt back in when global thinking is disabled", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				disableThinking: true,
				agentOverrides: {
					reviewer: {
						thinking: "high",
					},
				},
			},
		});

		const agents = discoverAgents(tempProject, "both").agents;
		const reviewer = agents.find((agent) => agent.name === "reviewer");
		const worker = agents.find((agent) => agent.name === "worker");
		assert.ok(reviewer);
		assert.ok(worker);
		assert.equal(reviewer.thinking, "high");
		assert.equal(worker.thinking, undefined);
	});

	it("lets project settings disable builtin thinking even when user overrides request it", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: {
						thinking: "xhigh",
					},
				},
			},
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				disableThinking: true,
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.thinking, undefined);
	});

	it("surfaces malformed subagent default model settings", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				defaultModel: "",
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("defaultModel"),
		);
	});

	it("surfaces malformed global thinking settings", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				disableThinking: "yes",
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("disableThinking"),
		);
	});

	it("prefers project settings overrides over user settings overrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini", thinking: "high" } } },
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai-codex/gpt-5.4-mini");
		assert.equal(reviewer.thinking, "high");
		assert.equal(reviewer.override?.scope, "project");
		assert.equal(reviewer.override?.path, path.join(tempProject, ".pi", "settings.json"));
	});

	it("does not apply project settings overrides when scope is user", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini" } } },
		});

		const reviewer = discoverAgents(tempProject, "user").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.override?.scope, "user");
	});

	it("does not apply user settings overrides when scope is project", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});

		const reviewer = discoverAgents(tempProject, "project").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.notEqual(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.override, undefined);
	});

	it("does not read malformed out-of-scope settings files", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		fs.mkdirSync(path.join(tempHome, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(tempHome, ".pi", "agent", "settings.json"), '{"subagents":', "utf-8");
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini" } } },
		});

		const reviewer = discoverAgents(tempProject, "project").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai-codex/gpt-5.4-mini");
		assert.equal(reviewer.override?.scope, "project");
	});

});
