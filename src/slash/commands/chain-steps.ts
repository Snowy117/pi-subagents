import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../../agents/agents.ts";
import { type ChainStep } from "../../shared/settings.ts";
import { assertJsonSchemaObject } from "../../runs/shared/structured-output.ts";
import { validateAcceptanceInput } from "../../runs/shared/acceptance.ts";
import type { JsonSchemaObject, SubagentState } from "../../shared/types.ts";
import { hasGroupSyntax, parseChainExpression, parseSingleTaskToken, SlashParseError, type ParsedGroupStep, type ParsedStep } from "./chain-expression.ts";

type ChainStepObject = {
	agent: string;
	task?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	model?: string;
	skill?: string[] | false;
	progress?: boolean;
	as?: string;
	label?: string;
	phase?: string;
	cwd?: string;
	count?: number;
	outputSchema?: JsonSchemaObject;
	acceptance?: string;
};

const INLINE_ACCEPTANCE_LEVELS = new Set(["auto", "attested", "checked"]);

function validateInlineAcceptanceInput(value: string, agent: string): void {
	const errors = validateAcceptanceInput(value, `acceptance for step '${agent}'`);
	if (errors.length > 0) throw new SlashParseError(errors[0]!);
	if (!INLINE_ACCEPTANCE_LEVELS.has(value)) {
		throw new SlashParseError(`Inline acceptance for step '${agent}' supports auto, attested, or checked. Use the subagent tool API or a saved .chain.json file for none, verified, or reviewed acceptance contracts.`);
	}
}

// Load an inline `outputSchema=<path>` JSON file, resolved against the session cwd.
// Throws (SlashParseError / fs / JSON) on a missing or malformed schema.
function loadInlineOutputSchema(baseCwd: string, agent: string, value: string): JsonSchemaObject {
	const schemaPath = path.isAbsolute(value) ? value : path.join(baseCwd, value);
	const label = `outputSchema for step '${agent}' (${schemaPath})`;
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
	} catch (error) {
		throw new SlashParseError(`Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
	assertJsonSchemaObject(parsed, label);
	return parsed;
}

// Build a ChainStep object from a parsed token. `inGroup` enables `count` (parallel-only).
// May throw SlashParseError for an invalid acceptance level or outputSchema path.
const mapParsedTaskToStepObject = (
	step: ParsedStep,
	fallbackTask: string | undefined,
	isFirst: boolean,
	opts: { baseCwd: string; inGroup: boolean },
): ChainStepObject => {
	const { name, config, task: stepTask } = step;
	if (config.acceptance !== undefined) validateInlineAcceptanceInput(config.acceptance, name);
	return {
		agent: name,
		...(stepTask ? { task: stepTask } : isFirst && fallbackTask ? { task: fallbackTask } : {}),
		...(config.output !== undefined ? { output: config.output } : {}),
		...(config.outputMode !== undefined ? { outputMode: config.outputMode } : {}),
		...(config.reads !== undefined ? { reads: config.reads } : {}),
		...(config.model ? { model: config.model } : {}),
		...(config.skill !== undefined ? { skill: config.skill } : {}),
		...(config.progress !== undefined ? { progress: config.progress } : {}),
		...(config.as ? { as: config.as } : {}),
		...(config.label ? { label: config.label } : {}),
		...(config.phase ? { phase: config.phase } : {}),
		...(config.cwd ? { cwd: config.cwd } : {}),
		...(opts.inGroup && config.count !== undefined ? { count: config.count } : {}),
		...(config.outputSchema ? { outputSchema: loadInlineOutputSchema(opts.baseCwd, name, config.outputSchema) } : {}),
		...(config.acceptance ? { acceptance: config.acceptance } : {}),
	};
};

export const parseAgentArgs = (
	state: SubagentState,
	args: string,
	command: string,
	ctx: ExtensionContext,
): { steps: ParsedStep[]; task: string } | null => {
	const input = args.trim();
	const usage = `Usage: /${command} agent1 "task1" -> agent2 "task2"`;
	let steps: ParsedStep[];
	let sharedTask: string;
	let perStep = false;

	if (input.includes(" -> ")) {
		perStep = true;
		const segments = input.split(" -> ");
		steps = [];
		for (const seg of segments) {
			const trimmed = seg.trim();
			if (!trimmed) continue;
			steps.push(parseSingleTaskToken(trimmed));
		}
		sharedTask = steps.find((s) => s.task)?.task ?? "";
	} else {
		const delimiterIndex = input.indexOf(" -- ");
		if (delimiterIndex === -1) {
			ctx.ui.notify(usage, "error");
			return null;
		}
		const agentsPart = input.slice(0, delimiterIndex).trim();
		sharedTask = input.slice(delimiterIndex + 4).trim();
		if (!agentsPart || !sharedTask) {
			ctx.ui.notify(usage, "error");
			return null;
		}
		steps = agentsPart.split(/\s+/).filter(Boolean).map((t) => parseSingleTaskToken(t));
	}

	if (steps.length === 0) {
		ctx.ui.notify(usage, "error");
		return null;
	}
	if (!state.baseCwd) {
		ctx.ui.notify("Subagent session cwd is not initialized yet", "error");
		return null;
	}
	const agents = discoverAgents(state.baseCwd, "both").agents;
	for (const step of steps) {
		if (!agents.find((a) => a.name === step.name)) {
			ctx.ui.notify(`Unknown agent: ${step.name}`, "error");
			return null;
		}
	}
	if (command === "chain" && !steps[0]?.task && (perStep || !sharedTask)) {
		ctx.ui.notify(`First step must have a task: /chain agent "task" -> agent2`, "error");
		return null;
	}
	if (command === "parallel" && !steps.some((s) => s.task) && !sharedTask) {
		ctx.ui.notify("At least one step must have a task", "error");
		return null;
	}
	return { steps, task: sharedTask };
};

export function buildChainExpressionSteps(
	state: SubagentState,
	input: string,
	ctx: ExtensionContext,
): { chain: ChainStep[]; task: string } | null {
	const notify = (message: string) => ctx.ui.notify(message, "error");
	if (!hasGroupSyntax(input)) {
		const parsed = parseAgentArgs(state, input, "chain", ctx);
		if (!parsed) return null;
		const baseCwd = state.baseCwd!; // parseAgentArgs already verified baseCwd is set
		try {
			const chain: ChainStep[] = parsed.steps.map((step, i) =>
				mapParsedTaskToStepObject(step, parsed.task || undefined, i === 0, { baseCwd, inGroup: false }),
			);
			return { chain, task: parsed.task };
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error));
			return null;
		}
	}

	let expression: { steps: ParsedGroupStep[] };
	try {
		expression = parseChainExpression(input);
	} catch (error) {
		notify(error instanceof Error ? error.message : String(error));
		return null;
	}
	if (!state.baseCwd) {
		notify("Subagent session cwd is not initialized yet");
		return null;
	}
	const agents = discoverAgents(state.baseCwd, "both").agents;
	const stepAgentNames = expression.steps.flatMap((step) =>
		step.kind === "group" ? step.tasks.map((t) => t.name) : [step.name],
	);
	for (const name of stepAgentNames) {
		if (!agents.find((a) => a.name === name)) {
			notify(`Unknown agent: ${name}`);
			return null;
		}
	}
	// Every task inside a parallel group needs its own task; there is no shared-task fallback.
	for (const step of expression.steps) {
		if (step.kind === "group" && step.tasks.some((t) => !t.task)) {
			notify('Each task in a parallel group needs a task: (agent "a" | agent "b")');
			return null;
		}
	}
	const firstStep = expression.steps[0]!;
	const firstHasTask =
		firstStep.kind === "group"
			? firstStep.tasks.some((t) => Boolean(t.task))
			: Boolean(firstStep.task);
	if (!firstHasTask) {
		notify('First step must have a task: /chain agent "task" -> agent2');
		return null;
	}
	const sharedTask =
		firstStep.kind === "group"
			? (firstStep.tasks.find((t) => t.task)?.task ?? "")
			: (firstStep.task ?? "");
	const baseCwd = state.baseCwd;
	let chain: ChainStep[];
	try {
		chain = expression.steps.map((step) => {
			if (step.kind === "group") {
				const parallel = step.tasks.map((t) => mapParsedTaskToStepObject(t, undefined, false, { baseCwd, inGroup: true }));
				return {
					parallel,
					...(step.config.concurrency !== undefined ? { concurrency: step.config.concurrency } : {}),
					...(step.config.failFast !== undefined ? { failFast: step.config.failFast } : {}),
					...(step.config.worktree !== undefined ? { worktree: step.config.worktree } : {}),
				};
			}
			return mapParsedTaskToStepObject(step, sharedTask || undefined, false, { baseCwd, inGroup: false });
		});
	} catch (error) {
		notify(error instanceof Error ? error.message : String(error));
		return null;
	}
	return { chain, task: sharedTask };
}
