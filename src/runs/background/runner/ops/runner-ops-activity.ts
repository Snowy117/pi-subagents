import * as fs from "node:fs";
import * as path from "node:path";
import { enqueueStepSteer } from "../../control-channel.ts";
import type { SteerRequest } from "../../control-channel.ts";
import {
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
} from "../../../shared/subagent-control.ts";
import { nextLongRunningTrigger } from "../../../shared/long-running-guard.ts";
import { appendJsonl } from "../event-logging.ts";
import type { RunnerOps } from "../runner-ops.ts";
import type { RunnerState } from "../runner-state.ts";

export function attachActivityOps(ops: RunnerOps, state: RunnerState): void {
	ops.stepOutputActivityAt = (index: number): number => {
		const step = state.statusPayload.steps[index];
		let lastActivityAt = step?.lastActivityAt ?? step?.startedAt ?? state.overallStartTime;
		const outputPath = path.join(state.asyncDir, `output-${index}.log`);
		try {
			lastActivityAt = Math.max(lastActivityAt, fs.statSync(outputPath).mtimeMs);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(`Failed to inspect async output file '${outputPath}':`, error);
			}
		}
		return lastActivityAt;
	};
	ops.appendControlEvent = (event: ReturnType<typeof buildControlEvent>) => {
		if (!state.controlConfig.enabled) return;
		const childIntercomTarget = state.config.childIntercomTargets?.[event.index ?? state.statusPayload.currentStep];
		const channels = event.type === "active_long_running"
			? state.controlConfig.notifyChannels.filter((channel) => channel !== "intercom")
			: state.controlConfig.notifyChannels;
		if (channels.length === 0 || !claimControlNotification(state.controlConfig, event, state.emittedControlEventKeys, childIntercomTarget)) return;
		appendJsonl(state.eventsPath, JSON.stringify({
			type: "subagent.control",
			event,
			channels,
			childIntercomTarget,
			noticeText: formatControlNoticeMessage(event, childIntercomTarget),
			...(state.config.controlIntercomTarget && channels.includes("intercom") ? {
				intercom: {
					to: state.config.controlIntercomTarget,
					message: formatControlIntercomMessage(event, childIntercomTarget),
				},
			} : {}),
		}));
	};
	ops.maybeEmitActiveLongRunning = (flatIndex: number, now: number): boolean => {
		if (!state.controlConfig.enabled || state.activeLongRunningSteps.has(flatIndex)) return false;
		const step = state.statusPayload.steps[flatIndex];
		if (!step || step.status !== "running" || step.activityState === "needs_attention") return false;
		const reason = nextLongRunningTrigger(state.controlConfig, {
			startedAt: step.startedAt ?? state.overallStartTime,
			now,
			turns: step.turnCount ?? 0,
			tokens: step.tokens?.total ?? 0,
		});
		if (!reason) return false;
		state.activeLongRunningSteps.add(flatIndex);
		const previous = step.activityState;
		step.activityState = "active_long_running";
		state.statusPayload.activityState = state.statusPayload.activityState === "needs_attention" ? "needs_attention" : "active_long_running";
		const event = buildControlEvent({
			type: "active_long_running",
			from: previous,
			to: "active_long_running",
			runId: state.id,
			agent: step.agent,
			index: flatIndex,
			ts: now,
			message: `${step.agent} is still active but long-running`,
			reason,
			turns: step.turnCount,
			tokens: step.tokens?.total,
			toolCount: step.toolCount,
			currentTool: step.currentTool,
			currentToolDurationMs: step.currentToolStartedAt ? Math.max(0, now - step.currentToolStartedAt) : undefined,
			currentPath: step.currentPath,
			elapsedMs: now - (step.startedAt ?? state.overallStartTime),
		});
		ops.appendControlEvent(event);
		return true;
	};
	ops.deliverSteerRequest = (request: SteerRequest): void => {
		if (state.statusPayload.state !== "running") return;
		const runningIndexes = state.statusPayload.steps
			.map((step, index) => ({ step, index }))
			.filter(({ step }) => step.status === "running")
			.map(({ index }) => index);
		const targets = request.targetIndex !== undefined ? [request.targetIndex] : runningIndexes;
		const now = Date.now();
		const accepted: number[] = [];
		const rejected: Array<{ index: number; reason: string }> = [];
		for (const index of targets) {
			const step = state.statusPayload.steps[index];
			if (!step) {
				rejected.push({ index, reason: "child index out of range" });
				continue;
			}
			if (step.status !== "running") {
				rejected.push({ index, reason: `child is ${step.status}` });
				continue;
			}
			enqueueStepSteer(state.asyncDir, index, request);
			step.steerCount = (step.steerCount ?? 0) + 1;
			step.lastSteerAt = now;
			accepted.push(index);
		}
		if (accepted.length > 0) {
			state.statusPayload.steerCount = (state.statusPayload.steerCount ?? 0) + accepted.length;
			state.statusPayload.lastSteerAt = now;
			state.statusPayload.lastUpdate = now;
			ops.writeStatusPayload();
		}
		appendJsonl(state.eventsPath, JSON.stringify({
			type: "subagent.steer.requested",
			ts: now,
			runId: state.id,
			requestId: request.id,
			message: request.message,
			...(request.source ? { source: request.source } : {}),
			...(request.targetIndex !== undefined ? { targetIndex: request.targetIndex } : {}),
			acceptedIndexes: accepted,
			...(rejected.length ? { rejected } : {}),
		}));
	};
	ops.flushPendingStepSteers = (flatIndex: number): void => {
		const remaining: SteerRequest[] = [];
		for (const request of state.pendingStepSteers.splice(0)) {
			if (request.targetIndex === undefined) ops.deliverSteerRequest({ ...request, targetIndex: flatIndex });
			else if (request.targetIndex === flatIndex) ops.deliverSteerRequest(request);
			else remaining.push(request);
		}
		state.pendingStepSteers.push(...remaining);
	};
	ops.updateRunnerActivityState = (now: number): boolean => {
		if (!state.controlConfig.enabled) return false;
		let changed = false;
		let runLastActivityAt = state.statusPayload.lastActivityAt ?? state.overallStartTime;
		for (let index = 0; index < state.statusPayload.steps.length; index++) {
			const step = state.statusPayload.steps[index]!;
			if (step.status !== "running") continue;
			const lastActivityAt = ops.stepOutputActivityAt(index);
			runLastActivityAt = Math.max(runLastActivityAt, lastActivityAt);
			if (step.lastActivityAt !== lastActivityAt) {
				step.lastActivityAt = lastActivityAt;
				changed = true;
			}
			const idleState = deriveActivityState({
				config: state.controlConfig,
				startedAt: step.startedAt ?? state.overallStartTime,
				lastActivityAt,
				now,
			});
			if (idleState === "needs_attention") {
				const previous = step.activityState;
				step.activityState = "needs_attention";
				if (previous !== "needs_attention") {
					ops.appendControlEvent(buildControlEvent({
						from: previous,
						to: "needs_attention",
						runId: state.id,
						agent: step.agent,
						index,
						ts: now,
						lastActivityAt,
					}));
					changed = true;
				}
			} else if (ops.maybeEmitActiveLongRunning(index, now)) {
				changed = true;
			}
		}
		if (state.statusPayload.lastActivityAt !== runLastActivityAt) {
			state.statusPayload.lastActivityAt = runLastActivityAt;
			changed = true;
		}
		const nextRunState = state.statusPayload.steps.some((step) => step.activityState === "needs_attention")
			? "needs_attention"
			: state.statusPayload.steps.some((step) => step.activityState === "active_long_running")
				? "active_long_running"
				: undefined;
		if (nextRunState !== state.currentActivityState) {
			state.currentActivityState = nextRunState;
			state.statusPayload.activityState = nextRunState;
			changed = true;
		}
		state.statusPayload.lastUpdate = now;
		if (changed) ops.writeStatusPayload();
		return changed;
	};
}
