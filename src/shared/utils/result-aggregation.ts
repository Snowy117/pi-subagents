/**
 * Result aggregation: sum token/cost usage across single results and their
 * nested child runs.
 */

import type { Usage, Details, SingleResult, NestedRunSummary } from "../types.ts";

export function sumResultsUsage(results: SingleResult[]): Usage {
	const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const result of results) {
		usage.input += result.usage.input;
		usage.output += result.usage.output;
		usage.cacheRead += result.usage.cacheRead;
		usage.cacheWrite += result.usage.cacheWrite;
		usage.cost += result.usage.cost;
		usage.turns += result.usage.turns;
	}
	return usage;
}

function addNestedCost(total: NonNullable<Details["totalCost"]>, children: NestedRunSummary[] | undefined): void {
	for (const child of children ?? []) {
		if (child.totalCost) {
			total.inputTokens += child.totalCost.inputTokens;
			total.outputTokens += child.totalCost.outputTokens;
			total.costUsd += child.totalCost.costUsd;
			continue;
		}
		addNestedCost(total, child.children);
		for (const step of child.steps ?? []) addNestedCost(total, step.children);
	}
}

/** Sum input tokens, output tokens, and cost across a set of SingleResults. */
export function sumResultsCost(results: SingleResult[]): NonNullable<Details["totalCost"]> {
	const total = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
	for (const result of results) {
		total.inputTokens += result.usage.input;
		total.outputTokens += result.usage.output;
		total.costUsd += result.usage.cost;
		addNestedCost(total, result.children);
	}
	return total;
}
