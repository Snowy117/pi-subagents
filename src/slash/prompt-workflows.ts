import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { ChainStep } from "../shared/settings.ts";
import {
	discoverPromptWorkflows,
	findWorkflow,
	formatWorkflowList,
	type PromptWorkflow,
} from "./prompt-workflow-discovery.ts";

export { discoverPromptWorkflows } from "./prompt-workflow-discovery.ts";

type PromptWorkflowRunner = (params: SubagentParamsLike, ctx: ExtensionContext) => Promise<void>;

function shellWords(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const ch of input) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) words.push(current);
	return words;
}

function substituteArgs(template: string, args: string[]): string {
	const all = args.join(" ");
	return template
		.replace(/\$ARGUMENTS/g, all)
		.replace(/\$@/g, all)
		.replace(/\$\{(\d+):-([^}]*)\}/g, (_match, index: string, fallback: string) => args[Number(index) - 1] || fallback)
		.replace(/\$(\d+)/g, (_match, index: string) => args[Number(index) - 1] ?? "");
}

function parseRuntimeOptions(words: string[]): { args: string[]; agentOverride?: string; fork?: boolean; fresh?: boolean; worktree?: boolean; bg?: boolean } {
	const args: string[] = [];
	let agentOverride: string | undefined;
	let fork = false;
	let fresh = false;
	let worktree = false;
	let bg = false;
	for (let i = 0; i < words.length; i++) {
		const word = words[i]!;
		if (word === "--fork") {
			fork = true;
			continue;
		}
		if (word === "--fresh") {
			fresh = true;
			continue;
		}
		if (word === "--worktree") {
			worktree = true;
			continue;
		}
		if (word === "--bg" || word === "--async") {
			bg = true;
			continue;
		}
		if (word === "--subagent") {
			agentOverride = words[++i];
			continue;
		}
		const eq = word.match(/^--subagent(?:=|:)(.+)$/);
		if (eq) {
			agentOverride = eq[1];
			continue;
		}
		args.push(word);
	}
	return { args, agentOverride, fork, fresh, worktree, bg };
}

function splitChainDeclaration(input: string): { declaration: string; argsText: string } {
	const delimiter = input.indexOf(" -- ");
	if (delimiter === -1) return { declaration: input.trim(), argsText: "" };
	return { declaration: input.slice(0, delimiter).trim(), argsText: input.slice(delimiter + 4).trim() };
}

function splitPromptChain(input: string): string[] {
	return input.split(" -> ").map((part) => part.trim()).filter(Boolean);
}

function workflowParams(workflow: PromptWorkflow, args: string[], runtime: ReturnType<typeof parseRuntimeOptions>): SubagentParamsLike {
	const task = substituteArgs(workflow.body, args).trim();
	const context = runtime.fork ? "fork" : runtime.fresh ? "fresh" : workflow.context;
	return {
		agent: runtime.agentOverride ?? workflow.agent,
		task,
		clarify: false,
		agentScope: "both",
		...(context ? { context } : {}),
		...(workflow.model ? { model: workflow.model } : {}),
		...(workflow.skill !== undefined ? { skill: workflow.skill } : {}),
		...(workflow.cwd ? { cwd: workflow.cwd } : {}),
		...(runtime.worktree || workflow.worktree ? { worktree: true } : {}),
		...(runtime.bg ? { async: true } : {}),
	};
}

function workflowChainStep(workflow: PromptWorkflow, args: string[], runtime: ReturnType<typeof parseRuntimeOptions>): ChainStep {
	const params = workflowParams(workflow, args, runtime);
	return {
		agent: params.agent ?? "delegate",
		task: params.task,
		...(params.model ? { model: params.model } : {}),
		...(params.skill !== undefined ? { skill: params.skill } : {}),
		...(params.cwd ? { cwd: params.cwd } : {}),
	};
}

export function registerPromptWorkflowCommands(input: {
	pi: ExtensionAPI;
	run: PromptWorkflowRunner;
}): void {
	const { pi, run } = input;

	pi.registerCommand("prompt-workflow", {
		description: "Run a prompt template through native pi-subagents: /prompt-workflow <name> [args]",
		handler: async (rawArgs, ctx) => {
			const words = shellWords(rawArgs);
			const name = words.shift();
			const workflows = discoverPromptWorkflows(ctx.cwd);
			if (!name || name === "list") {
				pi.sendMessage({ content: formatWorkflowList(workflows), display: true });
				return;
			}
			const workflow = findWorkflow(workflows, name);
			if (!workflow) {
				ctx.ui.notify(`Unknown prompt workflow: ${name}`, "error");
				return;
			}
			const runtime = parseRuntimeOptions(words);
			try {
				if (workflow.chain) {
					const chainNames = splitPromptChain(workflow.chain);
					const chain = chainNames.map((stepName) => {
						const step = findWorkflow(workflows, stepName);
						if (!step) throw new Error(`Unknown prompt workflow in chain '${workflow.name}': ${stepName}`);
						return workflowChainStep(step, runtime.args, runtime);
					});
					await run({ chain, task: runtime.args.join(" "), clarify: false, agentScope: "both", ...(runtime.bg ? { async: true } : {}) }, ctx);
					return;
				}
				await run(workflowParams(workflow, runtime.args, runtime), ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("chain-prompts", {
		description: "Run prompt templates as a native subagent chain: /chain-prompts analyze -> fix -- args",
		handler: async (rawArgs, ctx) => {
			const { declaration, argsText } = splitChainDeclaration(rawArgs);
			const workflows = discoverPromptWorkflows(ctx.cwd);
			if (!declaration || declaration === "list") {
				pi.sendMessage({ content: formatWorkflowList(workflows), display: true });
				return;
			}
			const runtime = parseRuntimeOptions(shellWords(argsText));
			const names = splitPromptChain(declaration);
			if (names.length === 0) {
				ctx.ui.notify("Usage: /chain-prompts prompt-a -> prompt-b -- args", "error");
				return;
			}
			try {
				const chain = names.map((name) => {
					const workflow = findWorkflow(workflows, name);
					if (!workflow) throw new Error(`Unknown prompt workflow: ${name}`);
					return workflowChainStep(workflow, runtime.args, runtime);
				});
				await run({ chain, task: runtime.args.join(" "), clarify: false, agentScope: "both", ...(runtime.bg ? { async: true } : {}) }, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
