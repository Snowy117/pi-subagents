import { acceptanceFailureMessage, aggregateAcceptanceReport, evaluateAcceptance } from "../../shared/acceptance.ts";
import { DynamicFanoutError, collectDynamicResults, materializeDynamicParallelStep, validateDynamicCollection } from "../../shared/dynamic-fanout.ts";
import { aggregateParallelOutputs, type DynamicRunnerGroup, type RunnerSubagentStep } from "../../shared/parallel-utils.ts";
import { resolveSubagentIntercomTarget } from "../../../intercom/intercom-bridge.ts";
import { createMutatingFailureState } from "../../shared/long-running-guard.ts";
import { appendJsonl } from "./event-logging.ts";
import type { RunnerStatusStep } from "./types.ts";
import type { SingleStepResult } from "./run-single-step.ts";
import type { RunnerOps } from "./runner-ops.ts";
import type { RunnerState, StepOutcome } from "./runner-state.ts";

export function applyDynamicMaterialization(
	state: RunnerState,
	ops: RunnerOps,
	step: DynamicRunnerGroup,
	stepIndex: number,
	groupStartFlatIndex: number,
	materialized: ReturnType<typeof materializeDynamicParallelStep>,
	dynamicSteps: RunnerSubagentStep[],
	dynamicStatusSteps: RunnerStatusStep[],
): void {
	state.statusPayload.steps.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps);
	if (state.config.childIntercomTargets) {
		state.config.childIntercomTargets = state.statusPayload.steps.map((statusStep, index) => resolveSubagentIntercomTarget(state.id, statusStep.agent, index));
	}
	state.mutatingFailureStates.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => createMutatingFailureState()));
	state.pendingToolResults.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => undefined));
	const materializedDelta = dynamicStatusSteps.length - 1;
	for (const group of state.statusPayload.parallelGroups) {
		if (group.stepIndex === stepIndex) {
			group.start = groupStartFlatIndex;
			group.count = dynamicStatusSteps.length;
		} else if (group.start > groupStartFlatIndex) {
			group.start += materializedDelta;
		}
	}
	if (state.statusPayload.workflowGraph) {
		const shiftFlatIndexes = (nodes: NonNullable<typeof state.statusPayload.workflowGraph>["nodes"]): void => {
			for (const node of nodes) {
				if (node.stepIndex !== undefined && node.stepIndex > stepIndex && node.flatIndex !== undefined && node.flatIndex >= groupStartFlatIndex) {
					node.flatIndex += dynamicStatusSteps.length;
				}
				if (node.children) shiftFlatIndexes(node.children);
			}
		};
		shiftFlatIndexes(state.statusPayload.workflowGraph.nodes);
		const groupNode = state.statusPayload.workflowGraph.nodes.find((node) => node.id === `step-${stepIndex}`);
		if (groupNode) {
			groupNode.children = materialized.items.map((item, itemIndex) => ({
				id: `step-${stepIndex}-item-${item.idKey}`,
				kind: "agent",
				agent: step.parallel.agent,
				phase: dynamicSteps[itemIndex]?.phase ?? step.phase,
				label: dynamicSteps[itemIndex]?.label?.trim() || `${step.parallel.agent} ${item.key}`,
				status: "pending",
				flatIndex: groupStartFlatIndex + itemIndex,
				stepIndex,
				itemKey: item.key,
				structured: Boolean(dynamicSteps[itemIndex]?.structuredOutputSchema),
			}));
		}
	}
	ops.writeStatusPayload();
}

export async function collectDynamicFanoutResults(
	state: RunnerState,
	ops: RunnerOps,
	step: DynamicRunnerGroup,
	stepIndex: number,
	materialized: ReturnType<typeof materializeDynamicParallelStep>,
	parallelResults: SingleStepResult[],
	nextFlatIndex: number,
): Promise<StepOutcome> {
	const collection = collectDynamicResults(step as Parameters<typeof collectDynamicResults>[0], materialized.items, parallelResults);
	const failures = parallelResults.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
	if (failures.length === 0) {
		try {
			validateDynamicCollection(step.collect.outputSchema, collection);
			state.outputs[step.collect.as] = {
				text: JSON.stringify(collection),
				structured: collection,
				agent: step.parallel.agent,
				stepIndex,
			};
			state.statusPayload.outputs = state.outputs;
			const groupAcceptance = step.effectiveAcceptance && !state.timedOut
				? await evaluateAcceptance({
					acceptance: step.effectiveAcceptance,
					output: "",
					report: aggregateAcceptanceReport({
						results: parallelResults,
						notes: `Dynamic fanout collected ${collection.length} result(s) into ${step.collect.as}.`,
					}),
					cwd: state.cwd,
					signal: state.timeoutAbortController.signal,
					abortMessage: state.timeoutMessage ?? "Subagent timed out.",
				})
				: undefined;
			const groupTimedOut = state.timedOut || state.timeoutAbortController.signal.aborted;
			const effectiveGroupAcceptance = groupTimedOut ? undefined : groupAcceptance;
			const groupAcceptanceFailure = effectiveGroupAcceptance ? acceptanceFailureMessage(effectiveGroupAcceptance) : undefined;
			const groupError = groupTimedOut ? state.timeoutMessage ?? "Subagent timed out." : groupAcceptanceFailure;
			ops.markDynamicGraphGroup(stepIndex, groupError ? "failed" : "completed", groupError, effectiveGroupAcceptance);
			if (groupError) {
				state.results.push({
					agent: step.parallel.agent,
					output: groupError,
					error: groupError,
					success: false,
					exitCode: 1,
					timedOut: groupTimedOut ? true : undefined,
					structuredOutput: collection,
					acceptance: effectiveGroupAcceptance,
				});
				state.statusPayload.error = groupError;
			}
		} catch (error) {
			const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
			state.results.push({ agent: step.parallel.agent, output: message, error: message, success: false, exitCode: 1, structuredOutput: collection });
			state.statusPayload.error = message;
			ops.markDynamicGraphGroup(stepIndex, "failed", message);
		}
	}
	state.previousOutput = aggregateParallelOutputs(
		parallelResults.map((r, i) => ({
			agent: r.agent,
			taskIndex: i,
			output: r.output,
			exitCode: r.exitCode,
			error: r.error,
		})),
		(i, agent) => `=== Dynamic Item ${i + 1} (${agent}, key ${materialized.items[i]?.key ?? i}) ===`,
	);
	appendJsonl(state.eventsPath, JSON.stringify({
		type: "subagent.dynamic.completed",
		ts: Date.now(),
		runId: state.id,
		stepIndex,
		success: failures.length === 0,
	}));
	if (failures.length > 0) ops.markDynamicGraphGroup(stepIndex, "failed", failures[0]?.error ?? "Dynamic fanout child failed.");
	state.statusPayload.lastUpdate = Date.now();
	ops.writeStatusPayload();
	if (failures.length > 0 || state.statusPayload.error) return { nextFlatIndex, breakLoop: true };
	return { nextFlatIndex, breakLoop: false };
}
