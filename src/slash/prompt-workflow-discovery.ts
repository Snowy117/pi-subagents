import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../agents/frontmatter.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

export interface PromptWorkflow {
	name: string;
	description: string;
	body: string;
	filePath: string;
	agent: string;
	context?: "fresh" | "fork";
	model?: string;
	skill?: string | string[] | false;
	cwd?: string;
	worktree?: boolean;
	chain?: string;
}

const RESERVED_COMMAND_NAMES = new Set([
	"chain-prompts",
	"prompt-workflow",
	"run",
	"chain",
	"parallel",
	"run-chain",
	"subagents-doctor",
	"subagents-models",
]);

function packagePromptsDir(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");
}

function promptDirs(cwd: string): string[] {
	return [
		packagePromptsDir(),
		path.join(getAgentDir(), "prompts"),
		path.join(getProjectConfigDir(cwd), "prompts"),
	];
}

function readPromptFiles(cwd: string): string[] {
	const files: string[] = [];
	for (const dir of promptDirs(cwd)) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".md")) files.push(path.join(dir, entry.name));
		}
	}
	return files;
}

function firstNonEmptyLine(value: string): string {
	return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Prompt workflow";
}

function stringField(frontmatter: Record<string, string>, key: string): string | undefined {
	const value = frontmatter[key]?.trim();
	return value ? value : undefined;
}

function booleanField(frontmatter: Record<string, string>, key: string): boolean | undefined {
	const value = frontmatter[key]?.trim().toLowerCase();
	if (value === "true" || value === "yes" || value === "1") return true;
	if (value === "false" || value === "no" || value === "0") return false;
	return undefined;
}

function parseSkill(value: string | undefined): string | string[] | false | undefined {
	if (!value) return undefined;
	if (value === "false") return false;
	const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
	return parts.length > 1 ? parts : parts[0];
}

function parseAgent(frontmatter: Record<string, string>): string {
	const subagent = stringField(frontmatter, "subagent");
	if (!subagent || subagent === "true") return "delegate";
	return subagent;
}

function loadPromptWorkflow(filePath: string): PromptWorkflow | undefined {
	const content = fs.readFileSync(filePath, "utf-8");
	const { frontmatter, body } = parseFrontmatter(content);
	const name = path.basename(filePath, ".md");
	if (!name || RESERVED_COMMAND_NAMES.has(name)) return undefined;
	const model = stringField(frontmatter, "model");
	const skill = parseSkill(stringField(frontmatter, "skill"));
	const cwd = stringField(frontmatter, "cwd");
	const chain = stringField(frontmatter, "chain");
	return {
		name,
		description: stringField(frontmatter, "description") ?? firstNonEmptyLine(body),
		body,
		filePath,
		agent: parseAgent(frontmatter),
		...(booleanField(frontmatter, "inheritContext") === true || booleanField(frontmatter, "fork") === true ? { context: "fork" as const } : {}),
		...(booleanField(frontmatter, "fresh") === true ? { context: "fresh" as const } : {}),
		...(model ? { model } : {}),
		...(skill !== undefined ? { skill } : {}),
		...(cwd ? { cwd } : {}),
		...(booleanField(frontmatter, "worktree") === true ? { worktree: true } : {}),
		...(chain ? { chain } : {}),
	};
}

export function discoverPromptWorkflows(cwd: string): PromptWorkflow[] {
	const workflows = new Map<string, PromptWorkflow>();
	for (const file of readPromptFiles(cwd)) {
		const workflow = loadPromptWorkflow(file);
		if (workflow) workflows.set(workflow.name, workflow);
	}
	return [...workflows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findWorkflow(workflows: PromptWorkflow[], name: string): PromptWorkflow | undefined {
	return workflows.find((workflow) => workflow.name === name);
}

export function formatWorkflowList(workflows: PromptWorkflow[]): string {
	if (workflows.length === 0) return "No prompt workflows found in package, user, or project prompts.";
	return [
		"Prompt workflows:",
		...workflows.map((workflow) => `- ${workflow.name}: ${workflow.description} (${workflow.filePath})`),
	].join("\n");
}
