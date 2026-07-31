import { randomUUID } from "node:crypto";
import { requestAsyncSteer, steerDeliveryMarker, writeSteerRequestToDir } from "../../runs/background/control-channel.ts";
import { reconcileAsyncRun } from "../../runs/background/stale-run-reconciler.ts";
import { consumeControlActionResponse, requestControlAction } from "../../runs/shared/control-actions/channel.ts";
import type { ChildControlActionRequest, ChildControlActionResponse } from "../../runs/shared/control-actions/actions.ts";
import type { SteerViewTarget } from "./target-model.ts";

export interface QueuedSteer {
	message: string;
	deliveryMarker: string;
	ts: number;
}

function assertAsyncTargetSteerable(target: SteerViewTarget): void {
	if (!target.asyncDir) throw new Error("This child has no live async run directory.");
	const status = reconcileAsyncRun(target.asyncDir).status;
	if (!status || (status.state !== "running" && status.state !== "queued")) {
		throw new Error("This async run is no longer running or queued.");
	}
	const step = status.steps?.[target.index];
	if (!step) throw new Error(`Async child index ${target.index} is out of range.`);
	if (step.status !== "running" && step.status !== "pending") {
		throw new Error(`Async child ${target.index} is ${step.status} and cannot be steered.`);
	}
}

export function sendTargetSteer(target: SteerViewTarget, message: string, deps: { now?: () => number; id?: () => string } = {}): QueuedSteer {
	const normalized = message.trim();
	if (!normalized) throw new Error("Steer message must not be empty.");
	if (!target.active) throw new Error("This child is no longer active.");
	const ts = deps.now?.() ?? Date.now();
	const id = deps.id?.() ?? randomUUID();
	if (target.kind === "async" && target.asyncDir) {
		assertAsyncTargetSteerable(target);
		requestAsyncSteer(target.asyncDir, { message: normalized, targetIndex: target.index, source: "tui", id, ts });
	} else if (target.kind === "foreground" && target.steerInboxDir) {
		writeSteerRequestToDir(target.steerInboxDir, {
			type: "steer", id, ts, message: normalized, targetIndex: target.index, source: "tui",
		});
	} else {
		throw new Error("This child has no live steer route.");
	}
	return { message: normalized, deliveryMarker: steerDeliveryMarker(id), ts };
}

export function requestTargetThinkingCycle(target: SteerViewTarget): ChildControlActionRequest {
	if (!target.active || !target.actionControlDir) throw new Error("This child has no live action route.");
	if (target.kind === "async") assertAsyncTargetSteerable(target);
	return requestControlAction(target.actionControlDir, "cycleThinking", { source: "tui" });
}

export function consumeTargetActionResponse(target: SteerViewTarget, requestId: string): ChildControlActionResponse | undefined {
	return target.actionControlDir ? consumeControlActionResponse(target.actionControlDir, requestId) : undefined;
}
