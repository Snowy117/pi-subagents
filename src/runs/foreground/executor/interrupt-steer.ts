/** interrupt-steer (split from subagent-executor.ts; internal-only). */

import { type IntercomBridgeState, resolveSubagentIntercomTarget } from "../../../intercom/intercom-bridge.ts";
import { type ControlEvent, type Details, type ResolvedControlConfig, type SubagentState, SUBAGENT_CONTROL_EVENT, SUBAGENT_CONTROL_INTERCOM_EVENT } from "../../../shared/types.ts";
import { deliverInterruptRequest, requestAsyncSteer } from "../../background/control-channel.ts";
import { reconcileAsyncRun } from "../../background/stale-run-reconciler.ts";
import { formatControlIntercomMessage, formatControlNoticeMessage, shouldNotifyControlEvent } from "../../shared/subagent-control.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAsyncInterruptTarget } from "./resume-targets.ts";


export function emitControlNotification(input: {
	pi: ExtensionAPI;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	event: ControlEvent;
}): void {
	if (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;
	const childIntercomTarget = input.intercomBridge.active
		? resolveSubagentIntercomTarget(input.event.runId, input.event.agent, input.event.index)
		: undefined;
	const payload = {
		event: input.event,
		source: "foreground" as const,
		childIntercomTarget,
		noticeText: formatControlNoticeMessage(input.event, childIntercomTarget),
	};
	if (input.controlConfig.notifyChannels.includes("event")) {
		input.pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
	}
	if (input.event.type !== "active_long_running" && input.controlConfig.notifyChannels.includes("intercom") && input.intercomBridge.active && input.intercomBridge.orchestratorTarget) {
		input.pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
			...payload,
			to: input.intercomBridge.orchestratorTarget,
			message: formatControlIntercomMessage(input.event, childIntercomTarget),
		});
	}
}


export function interruptAsyncRun(
	state: SubagentState,
	runId: string | undefined,
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean,
	location?: { asyncDir: string | null; resolvedId?: string },
): AgentToolResult<Details> | null {
	const target = getAsyncInterruptTarget(state, runId, location);
	if (!target) return null;
	const status = reconcileAsyncRun(target.asyncDir, { kill }).status;
	if (!status || status.state !== "running" || typeof status.pid !== "number") {
		return {
			content: [{ type: "text", text: `No running async run with an interrupt-capable pid was found for '${runId ?? "current"}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	try {
		deliverInterruptRequest({ asyncDir: target.asyncDir, pid: status.pid, kill, source: "interrupt-action" });
		const tracked = state.asyncJobs.get(target.asyncId);
		if (tracked) {
			tracked.activityState = undefined;
			tracked.updatedAt = Date.now();
		}
		return {
			content: [{ type: "text", text: `Interrupt requested for async run ${target.asyncId}.` }],
			details: { mode: "management", results: [] },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to interrupt async run ${target.asyncId}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}


export function steerAsyncRun(input: {
	state: SubagentState;
	runId: string;
	message: string;
	index?: number;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	location: { asyncDir: string | null; resolvedId?: string };
}): AgentToolResult<Details> {
	if (!input.location.asyncDir) {
		return {
			content: [{ type: "text", text: `Async run '${input.runId}' has no live run directory to steer.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const status = reconcileAsyncRun(input.location.asyncDir, { kill: input.kill }).status;
	if (!status || (status.state !== "running" && status.state !== "queued")) {
		return {
			content: [{ type: "text", text: `Async run '${input.runId}' is not running or queued and cannot be steered.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const steps = status.steps ?? [];
	if (input.index !== undefined) {
		if (input.index < 0 || input.index >= steps.length) {
			return {
				content: [{ type: "text", text: `Async run '${status.runId}' has ${steps.length} children. Index ${input.index} is out of range.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		const targetStep = steps[input.index];
		if (targetStep && targetStep.status !== "running" && targetStep.status !== "pending") {
			return {
				content: [{ type: "text", text: `Async run '${status.runId}' child ${input.index} is ${targetStep.status} and cannot be steered.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
	} else {
		const running = steps.filter((step) => step.status === "running");
		if (running.length === 0 && steps.length > 1) {
			return {
				content: [{ type: "text", text: `Async run '${status.runId}' has no running child yet. Provide index to steer a queued child.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
	}
	requestAsyncSteer(input.location.asyncDir, { message: input.message, targetIndex: input.index, source: "steer-action" });
	const tracked = input.state.asyncJobs.get(status.runId);
	if (tracked) tracked.updatedAt = Date.now();
	const childText = input.index !== undefined ? ` child ${input.index}` : " running child";
	return {
		content: [{ type: "text", text: `Steering queued for async run ${status.runId}${childText}. Delivery requires a live Pi child session that supports mid-run steering.` }],
		details: { mode: "management", results: [] },
	};
}
