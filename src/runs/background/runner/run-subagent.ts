import * as fs from "node:fs";
import { writeAtomicJson } from "../../../shared/atomic-json.ts";
import { watchAsyncControlInbox } from "../control-channel.ts";
import { SUBAGENT_LIFECYCLE_ARTIFACT_VERSION } from "../../../shared/types.ts";
import { isDynamicRunnerGroup, isParallelGroup, type RunnerStep, type RunnerSubagentStep } from "../../shared/parallel-utils.ts";
import { appendJsonl } from "./event-logging.ts";
import { createRunnerState, type StepOutcome } from "./runner-state.ts";
import { createRunnerOps } from "./runner-ops.ts";
import { runDynamicStep } from "./runner-step-dynamic.ts";
import { runParallelGroupStep } from "./runner-step-parallel.ts";
import { runSequentialStep } from "./runner-step-sequential.ts";
import { finalizeRun } from "./runner-finalize.ts";
import type { SubagentRunConfig } from "./types.ts";

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

export async function runSubagent(config: SubagentRunConfig): Promise<void> {
	const state = createRunnerState(config);
	const ops = createRunnerOps(state);

	fs.mkdirSync(state.asyncDir, { recursive: true });
	writeAtomicJson(state.statusPath, state.statusPayload);

	if (state.controlConfig.enabled) {
		state.activityTimer = setInterval(() => {
			if (state.statusPayload.state !== "running") return;
			const now = Date.now();
			ops.updateRunnerActivityState(now);
		}, 1000);
		state.activityTimer.unref?.();
	}

	const disposeControlInbox = watchAsyncControlInbox(state.asyncDir, {
		onInterrupt: () => ops.interruptRunner(),
		onTimeout: () => ops.timeoutRunner(),
		onSteer: (request) => {
			const targetStep = request.targetIndex !== undefined ? state.statusPayload.steps[request.targetIndex] : undefined;
			if (targetStep?.status === "pending") state.pendingStepSteers.push(request);
			else if (request.targetIndex !== undefined || state.statusPayload.steps.some((step) => step.status === "running")) ops.deliverSteerRequest(request);
			else state.pendingStepSteers.push(request);
		},
	});
	if (config.deadlineAt !== undefined) {
		const remainingMs = Math.max(0, config.deadlineAt - Date.now());
		state.timeoutTimer = setTimeout(() => ops.timeoutRunner(), remainingMs);
		state.timeoutTimer.unref?.();
	}
	process.on(ASYNC_INTERRUPT_SIGNAL, () => ops.interruptRunner());

	appendJsonl(
		state.eventsPath,
		JSON.stringify({
			type: "subagent.run.started",
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			ts: state.overallStartTime,
			runId: state.id,
			mode: state.statusPayload.mode,
			cwd: state.cwd,
			pid: process.pid,
		}),
	);

	const steps: RunnerStep[] = config.steps;
	let flatIndex = 0;
	let stepCursor = 0;

	while (true) {
		if (state.interrupted || state.timedOut || state.turnBudgetExceeded) break;
		ops.consumePendingAppendRequests();
		if (stepCursor >= steps.length) break;
		const stepIndex = stepCursor++;
		const step = steps[stepIndex]!;

		let outcome: StepOutcome;
		if (isDynamicRunnerGroup(step)) {
			outcome = await runDynamicStep(state, ops, step, stepIndex, flatIndex);
		} else if (isParallelGroup(step)) {
			outcome = await runParallelGroupStep(state, ops, step, stepIndex, flatIndex);
		} else {
			outcome = await runSequentialStep(state, ops, step as RunnerSubagentStep, stepIndex, flatIndex);
		}
		flatIndex = outcome.nextFlatIndex;
		if (outcome.breakLoop) break;
	}

	await finalizeRun(state, ops, disposeControlInbox);
}
