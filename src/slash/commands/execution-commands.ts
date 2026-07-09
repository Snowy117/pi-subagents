import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type ChainConfig } from "../../agents/agents.ts";
import type { SubagentParamsLike } from "../../runs/foreground/subagent-executor.ts";
import { isDynamicParallelStep, isParallelStep, type ChainStep } from "../../shared/settings.ts";
import { assertJsonSchemaObject } from "../../runs/shared/structured-output.ts";
import type { JsonSchemaObject, SubagentState } from "../../shared/types.ts";
import { extractExecutionFlags, parseAgentToken } from "./inline-config.ts";
import { buildChainExpressionSteps, parseAgentArgs } from "./chain-steps.ts";
import { discoverSavedChains, makeAgentCompletions, makeChainCompletions } from "./completions.ts";
import { runSlashSubagent } from "./slash-run.ts";

function loadSavedOutputSchema(chain: ChainConfig, stepAgent: string, outputSchema: unknown): JsonSchemaObject | undefined {
	if (outputSchema === undefined) return undefined;
	if (typeof outputSchema === "string") {
		const schemaPath = path.isAbsolute(outputSchema)
			? outputSchema
			: path.join(path.dirname(chain.filePath), outputSchema);
		const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as unknown;
		assertJsonSchemaObject(parsed, `outputSchema for chain '${chain.name}' step '${stepAgent}' (${schemaPath})`);
		return parsed;
	}
	assertJsonSchemaObject(outputSchema, `outputSchema for chain '${chain.name}' step '${stepAgent}'`);
	return outputSchema;
}

const mapSavedChainSteps = (chain: ChainConfig, worktree = false): ChainStep[] => {
	return (chain.steps as unknown as Array<ChainStep & { skills?: string[] | false }>).map((step) => {
		if (isParallelStep(step)) {
			const parallel = step.parallel.map((task) => {
				const { outputSchema: rawOutputSchema, ...rest } = task as typeof task & { outputSchema?: unknown };
				const outputSchema = loadSavedOutputSchema(chain, task.agent, rawOutputSchema);
				return { ...rest, ...(outputSchema ? { outputSchema } : {}) };
			});
			return { ...step, parallel, ...(worktree ? { worktree: true } : {}) };
		}
		if (isDynamicParallelStep(step)) {
			const { outputSchema: rawOutputSchema, ...parallelRest } = step.parallel as typeof step.parallel & { outputSchema?: unknown };
			const outputSchema = loadSavedOutputSchema(chain, step.parallel.agent, rawOutputSchema);
			const collectSchema = loadSavedOutputSchema(chain, `${step.collect.as} collection`, step.collect.outputSchema);
			return {
				...step,
				parallel: { ...parallelRest, ...(outputSchema ? { outputSchema } : {}) },
				collect: { ...step.collect, ...(collectSchema ? { outputSchema: collectSchema } : {}) },
			};
		}
		const outputSchema = loadSavedOutputSchema(chain, step.agent, (step as { outputSchema?: unknown }).outputSchema);
		return {
			agent: step.agent,
			task: step.task || undefined,
			...(step.phase ? { phase: step.phase } : {}),
			...(step.label ? { label: step.label } : {}),
			...(step.as ? { as: step.as } : {}),
			...(outputSchema ? { outputSchema } : {}),
			...((step as { acceptance?: unknown }).acceptance !== undefined ? { acceptance: (step as { acceptance?: unknown }).acceptance } : {}),
			output: step.output,
			outputMode: step.outputMode,
			reads: step.reads,
			progress: step.progress,
			skill: step.skill ?? step.skills,
			model: step.model,
		};
	});
};

export function registerExecutionCommands(
	pi: ExtensionAPI,
	state: SubagentState,
): void {
	pi.registerCommand("run", {
		description: "Run a subagent directly: /run agent[output=file] [task] [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, false),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const input = cleanedArgs.trim();
			const firstSpace = input.indexOf(" ");
			if (!input) { ctx.ui.notify("Usage: /run <agent> [task] [--bg] [--fork]", "error"); return; }
			const { name: agentName, config: inline } = parseAgentToken(firstSpace === -1 ? input : input.slice(0, firstSpace));
			const task = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();

			if (!state.baseCwd) { ctx.ui.notify("Subagent session cwd is not initialized yet", "error"); return; }
			const agents = discoverAgents(state.baseCwd, "both").agents;
			if (!agents.find((a) => a.name === agentName)) { ctx.ui.notify(`Unknown agent: ${agentName}`, "error"); return; }

			let finalTask = task;
			if (inline.reads && Array.isArray(inline.reads) && inline.reads.length > 0) {
				finalTask = `[Read from: ${inline.reads.join(", ")}]\n\n${finalTask}`;
			}
			const params: SubagentParamsLike = { agent: agentName, task: finalTask, clarify: false, agentScope: "both" };
			if (inline.output !== undefined) params.output = inline.output;
			if (inline.outputMode !== undefined) params.outputMode = inline.outputMode;
			if (inline.skill !== undefined) params.skill = inline.skill;
			if (inline.model) params.model = inline.model;
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashSubagent(pi, ctx, params);
		},
	});

	pi.registerCommand("chain", {
		description: "Run agents in sequence: /chain scout \"task\" -> planner [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const built = buildChainExpressionSteps(state, cleanedArgs, ctx);
			if (!built) return;
			const params: SubagentParamsLike = { chain: built.chain, task: built.task, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashSubagent(pi, ctx, params);
		},
	});

	pi.registerCommand("run-chain", {
		description: "Run a saved chain: /run-chain chainName -- task [--bg] [--fork]",
		getArgumentCompletions: makeChainCompletions(state),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const delimiterIndex = cleanedArgs.indexOf(" -- ");
			const usage = "Usage: /run-chain <chainName> -- <task> [--bg] [--fork]";
			if (delimiterIndex === -1) {
				ctx.ui.notify(usage, "error");
				return;
			}
			const chainName = cleanedArgs.slice(0, delimiterIndex).trim();
			const task = cleanedArgs.slice(delimiterIndex + 4).trim();
			if (!chainName || !task) {
				ctx.ui.notify(usage, "error");
				return;
			}
			if (!state.baseCwd) { ctx.ui.notify("Subagent session cwd is not initialized yet", "error"); return; }
			const chain = discoverSavedChains(state.baseCwd).find((candidate) => candidate.name === chainName);
			if (!chain) {
				ctx.ui.notify(`Unknown chain: ${chainName}`, "error");
				return;
			}
			const params: SubagentParamsLike = { chain: mapSavedChainSteps(chain), task, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashSubagent(pi, ctx, params);
		},
	});

	pi.registerCommand("parallel", {
		description: "Run agents in parallel: /parallel scout \"task1\" -> reviewer \"task2\" [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const parsed = parseAgentArgs(state, cleanedArgs, "parallel", ctx);
			if (!parsed) return;
			const tasks = parsed.steps.map(({ name, config, task: stepTask }) => ({
				agent: name,
				task: stepTask ?? parsed.task,
				...(config.output !== undefined ? { output: config.output } : {}),
				...(config.outputMode !== undefined ? { outputMode: config.outputMode } : {}),
				...(config.reads !== undefined ? { reads: config.reads } : {}),
				...(config.model ? { model: config.model } : {}),
				...(config.skill !== undefined ? { skill: config.skill } : {}),
				...(config.progress !== undefined ? { progress: config.progress } : {}),
			}));
			const params: SubagentParamsLike = { tasks, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashSubagent(pi, ctx, params);
		},
	});
}
