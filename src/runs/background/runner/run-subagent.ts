import * as fs from "node:fs";
import { writeAtomicJson } from "../../../shared/atomic-json.ts";
import { watchAsyncControlInbox } from "../control-channel.ts";
import { SUBAGENT_LIFECYCLE_ARTIFACT_VERSION } from "../../../shared/types.ts";
import { isParallelGroup, type RunnerStep, type RunnerSubagentStep } from "../../shared/parallel-utils.ts";
import { appendJsonl } from "./event-logging.ts";
import { createRunnerState, type StepOutcome } from "./runner-state.ts";
import { createRunnerOps } from "./runner-ops.ts";
import { runParallelGroupStep } from "./runner-step-parallel.ts";
import { runSequentialStep } from "./runner-step-sequential.ts";
import { finalizeRun } from "./runner-finalize.ts";
import { createRpcChildRegistry } from "../../persistent/rpc-child-registry.ts";
import { loadConfig, resolvePersistentChildConfig } from "../../../extension/config.ts";
import {
	CONVERSATION_EVICTION_INTERVAL_MS,
	createRunnerConversationBridge,
	lingerForConversations,
	type RunnerConversationBridge,
} from "./conversation-bridge.ts";
import type { SubagentRunConfig } from "./types.ts";

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

export async function runSubagent(config: SubagentRunConfig): Promise<void> {
	const state = createRunnerState(config);
	const ops = createRunnerOps(state);
	// Option B: the runner process owns the registry of its resident RPC
	// children; graceful close happens before the runner process exits.
	const persistentChildRegistry = config.persistentChildren === true ? createRpcChildRegistry() : undefined;
	if (persistentChildRegistry) {
		config.persistentChildRegistry = persistentChildRegistry;
	}
	const conversationBridge: RunnerConversationBridge | undefined = persistentChildRegistry
		? createRunnerConversationBridge({ asyncDir: state.asyncDir, registry: persistentChildRegistry })
		: undefined;
	state.conversationBridge = conversationBridge;
	if (conversationBridge) {
		// Best-effort shutdown hygiene: a dead runner must never leave stale
		// heartbeats that the parent would read as an alive conversation.
		process.once("exit", () => conversationBridge.clearHeartbeats());
	}

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
	if (conversationBridge && persistentChildRegistry) {
		// Runner-side eviction loop mirroring the parent extension: settled
		// children idle > idleEvictionMs or beyond the cap are evicted, never
		// a child with a fresh conversation heartbeat. Config is re-read each
		// tick so idle/cap changes apply without a restart.
		state.conversationEvictionTimer = setInterval(() => {
			const current = resolvePersistentChildConfig(loadConfig());
			if (!current.enabled) return;
			const exceptKeys = conversationBridge.conversingRegistryKeys();
			void persistentChildRegistry.evictIdle(current.idleEvictionMs, { except: exceptKeys });
			void persistentChildRegistry.evictOverflow(current.maxResidentChildren, { except: exceptKeys });
		}, CONVERSATION_EVICTION_INTERVAL_MS);
		state.conversationEvictionTimer.unref?.();
	}
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
		if (isParallelGroup(step)) {
			outcome = await runParallelGroupStep(state, ops, step, stepIndex, flatIndex);
		} else {
			outcome = await runSequentialStep(state, ops, step as RunnerSubagentStep, stepIndex, flatIndex);
		}
		flatIndex = outcome.nextFlatIndex;
		if (outcome.breakLoop) break;
	}

	await finalizeRun(state, ops, disposeControlInbox);
	if (persistentChildRegistry) {
		// Q3=A: after finalize the runner lingers while any conversing child
		// keeps a fresh heartbeat, so the user can keep talking to a settled
		// child with zero continuity gap. Interrupt/timeout paths close
		// promptly (the gate below), and the heartbeat TTL caps any dead-runner
		// wait at ~30s even if the parent dies mid-conversation.
		if (conversationBridge && !state.interrupted && !state.timedOut && !state.turnBudgetExceeded) {
			await lingerForConversations({ bridge: conversationBridge });
		}
		if (state.conversationEvictionTimer) {
			clearInterval(state.conversationEvictionTimer);
			state.conversationEvictionTimer = undefined;
		}
		conversationBridge?.stopAll();
		conversationBridge?.clearHeartbeats();
		await persistentChildRegistry.closeAll("graceful");
	}
}
