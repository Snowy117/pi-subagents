import { writeAtomicJson } from "../../../../shared/atomic-json.ts";
import { nestedSummaryFromAsyncStatus, writeNestedEvent } from "../../../shared/nested-events.ts";
import type { AcceptanceLedger } from "../../../../shared/types.ts";
import type { RunnerStatusStep } from "../types.ts";
import type { RunnerOps } from "../runner-ops.ts";
import type { RunnerState } from "../runner-state.ts";

export function attachStatusOps(ops: RunnerOps, state: RunnerState): void {
	ops.emitNestedSelfEvent = (type: "subagent.nested.updated" | "subagent.nested.completed"): void => {
		if (!state.config.nestedRoute || !state.config.nestedSelf) return;
		try {
			writeNestedEvent(state.config.nestedRoute, {
				type,
				ts: Date.now(),
				parentRunId: state.config.nestedSelf.parentRunId,
				parentStepIndex: state.config.nestedSelf.parentStepIndex,
				child: nestedSummaryFromAsyncStatus(state.statusPayload, state.asyncDir, {
					id: state.id,
					parentRunId: state.config.nestedSelf.parentRunId,
					parentStepIndex: state.config.nestedSelf.parentStepIndex,
					depth: state.config.nestedSelf.depth,
					path: state.config.nestedSelf.path,
					mode: state.statusPayload.mode,
					ts: Date.now(),
				}),
			});
		} catch (error) {
			console.error("Failed to emit nested async status event:", error);
		}
	};
	ops.refreshWorkflowGraph = (): void => {
		if (!state.config.workflowGraph) return;
		const graph = structuredClone(state.statusPayload.workflowGraph ?? state.config.workflowGraph);
		const normalize = (status: RunnerStatusStep["status"]): "pending" | "running" | "completed" | "failed" | "paused" | "detached" => {
			if (status === "complete" || status === "completed") return "completed";
			if (status === "running" || status === "failed" || status === "paused" || status === "pending") return status;
			return "pending";
		};
		const updateNode = (node: NonNullable<typeof graph.nodes>[number]): void => {
			if (node.flatIndex !== undefined) {
				const step = state.statusPayload.steps[node.flatIndex];
				if (step) {
					node.status = normalize(step.status);
					node.error = step.error;
					node.acceptanceStatus = step.acceptance?.status;
				}
				if (state.statusPayload.currentStep === node.flatIndex) graph.currentNodeId = node.id;
			}
			for (const child of node.children ?? []) updateNode(child);
			if (node.children?.length) {
				if (node.children.every((child) => child.status === "completed")) node.status = "completed";
				else if (node.children.some((child) => child.status === "running")) node.status = "running";
				else if (node.children.some((child) => child.status === "failed")) node.status = "failed";
				else if (node.children.some((child) => child.status === "paused")) node.status = "paused";
			}
			if (node.error) node.status = "failed";
		};
		for (const node of graph.nodes) updateNode(node);
		state.statusPayload.workflowGraph = graph;
	};
	ops.writeStatusPayload = (): void => {
		ops.refreshWorkflowGraph();
		writeAtomicJson(state.statusPath, state.statusPayload);
		ops.emitNestedSelfEvent(state.statusPayload.state === "running" || state.statusPayload.state === "queued" ? "subagent.nested.updated" : "subagent.nested.completed");
	};
	ops.markDynamicGraphGroup = (stepIndex: number, status: "completed" | "failed" | "running", error?: string, acceptance?: AcceptanceLedger): void => {
		const groupNode = state.statusPayload.workflowGraph?.nodes.find((node) => node.id === `step-${stepIndex}`);
		if (!groupNode) return;
		groupNode.status = status;
		groupNode.error = error;
		groupNode.acceptanceStatus = acceptance?.status ?? groupNode.acceptanceStatus;
	};
	ops.syncTopLevelCurrentTool = (): void => {
		const activeStep = state.statusPayload.steps
			.filter((step) => step.status === "running" && typeof step.currentTool === "string" && step.currentTool.length > 0)
			.sort((left, right) => (right.currentToolStartedAt ?? 0) - (left.currentToolStartedAt ?? 0))[0];
		state.statusPayload.currentTool = activeStep?.currentTool;
		state.statusPayload.currentToolStartedAt = activeStep?.currentToolStartedAt;
		state.statusPayload.currentPath = activeStep?.currentPath;
	};
}
