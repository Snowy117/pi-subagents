/**
 * runSingleAttempt — run one subagent attempt (spawn child, stream events,
 * finalize result). Moved out of execution.ts as part of the foreground split.
 *
 * The body was one cohesive concurrent routine whose ~21 inline closures share
 * process-level mutable state. The closures were extracted into cohesive
 * sibling modules (`single-attempt-*`); this module is the orchestrator that
 * builds the shared `SingleAttemptState`, spawns the child, wires the
 * extracted handlers onto the state object (in the original registration
 * order), and awaits the exit code before delegating to `finalizeSingleAttempt`.
 *
 * R2 invariant: every extracted handler closes over the SAME `state` reference,
 * so all mutations propagate identically to the original inline closures. No
 * `await`, registration order, or mutation order changed.
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import type { AgentConfig } from "../../../agents/agents.ts";
import { createJsonlWriter } from "../../../shared/jsonl-writer.ts";
import { LIVE_TRANSCRIPTS_DIR, isRuntimeLiveTranscript, markLiveTranscriptTerminal } from "../../../shared/live-transcript.ts";
import { attachPostExitStdioGuard } from "../../../shared/post-exit-stdio-guard.ts";
import {
	type AgentProgress,
	type RunSyncOptions,
	type SingleResult,
	getSubagentDepthEnv,
} from "../../../shared/types.ts";
import { DEFAULT_CONTROL_CONFIG } from "../../shared/subagent-control.ts";
import { applyThinkingSuffix, buildPiArgs } from "../../shared/pi-args.ts";
import { actionTargetDir, foregroundControlRoot, foregroundSteerInboxDir } from "../../shared/control-actions/paths.ts";
import { appendTurnBudgetSystemPrompt, initialTurnBudgetState } from "../../shared/turn-budget.ts";
import { initialToolBudgetState } from "../../shared/tool-budget.ts";
import { getPiSpawnCommand } from "../../shared/pi-spawn.ts";
import { attachRpcProtocol } from "../../persistent/rpc-protocol.ts";
import { createRpcChildCloser, type PersistentRpcChild } from "../../persistent/rpc-child-registry.ts";
import {
	foregroundLiveChildKey,
	registerForegroundLiveChild,
	removeForegroundLiveChild,
} from "../foreground-live-registry.ts";
import {
	emptyUsage,
	resolveAttemptTimeout,
} from "./attempt-helpers.ts";
import {
	type SingleAttemptShared,
	createSingleAttemptState,
} from "./single-attempt-state.ts";
import { attachLifecycleHandlers } from "./single-attempt-lifecycle.ts";
import { attachControlHandlers } from "./single-attempt-control.ts";
import { attachBudgetHandlers } from "./single-attempt-budget.ts";
import { attachEventHandlers } from "./single-attempt-events.ts";
import {
	registerIntercomDetach,
	registerProcessHandlers,
	registerSignalHandlers,
	startActivityTimer,
	startTimeoutTimer,
} from "./single-attempt-process.ts";
import { finalizeSingleAttempt } from "./single-attempt-finalize.ts";

export async function runSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: SingleAttemptShared,
): Promise<SingleResult> {
	const effectiveThinking = options.thinkingOverride ?? agent.thinking;
	const modelArg = applyThinkingSuffix(model, effectiveThinking, options.thinkingOverride !== undefined);
	const index = options.index ?? 0;
	const hasRunId = typeof options.runId === "string" && options.runId.trim().length > 0;
	const controlRoot = hasRunId ? foregroundControlRoot(options.runId) : undefined;
	const steerInboxDir = hasRunId ? foregroundSteerInboxDir(options.runId, index) : undefined;
	const actionControlDir = controlRoot ? actionTargetDir(controlRoot, index) : undefined;
	const liveChildren = options.foregroundLiveChildren;
	const liveChildKey = hasRunId ? foregroundLiveChildKey(options.runId, index) : undefined;
	const removeLiveChild = (status: "completed" | "failed"): void => {
		if (hasRunId && liveChildren) {
			removeForegroundLiveChild(liveChildren, options.runId, index, status, { rmSync });
		}
	};
	const stateOptions: RunSyncOptions = {
		...options,
		onDetachedExit: (detachedResult) => {
			markLiveTranscriptTerminal(shared.transcriptWriter?.path);
			removeLiveChild(detachedResult.exitCode === 0 && !detachedResult.error ? "completed" : "failed");
			options.onDetachedExit?.(detachedResult);
		},
	};
	const { args, env: sharedEnv, tempDir } = buildPiArgs({
		baseArgs: ["--mode", "rpc"],
		mode: "rpc",
		task,
		sessionEnabled: shared.sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model: modelArg,
		thinking: effectiveThinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		requireReadTool: Boolean(shared.resolvedSkillNames?.length),
		tools: agent.tools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		systemPrompt: appendTurnBudgetSystemPrompt(shared.systemPrompt, options.turnBudget),
		mcpDirectTools: agent.mcpDirectTools,
		cwd: options.cwd ?? runtimeCwd,
		promptFileStem: agent.name,
		intercomSessionName: options.intercomSessionName,
		orchestratorIntercomTarget: options.orchestratorIntercomTarget,
		runId: options.runId,
		childAgentName: agent.name,
		childIndex: index,
		parentEventSink: options.nestedRoute?.eventSink,
		parentControlInbox: options.nestedRoute?.controlInbox,
		parentRootRunId: options.nestedRoute?.rootRunId,
		parentCapabilityToken: options.nestedRoute?.capabilityToken,
		parentSessionId: options.parentSessionId,
		structuredOutput: options.structuredOutput,
		toolBudget: options.toolBudget,
		steerInboxDir,
		actionControlDir,
	});

	const result: SingleResult = {
		agent: agent.name,
		task: shared.originalTask ?? task,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		artifactPaths: shared.artifactPaths,
		transcriptPath: shared.transcriptWriter?.path,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
		...(options.turnBudget ? { turnBudget: initialTurnBudgetState(options.turnBudget) } : {}),
		...(options.toolBudget ? { toolBudget: initialToolBudgetState(options.toolBudget) } : {}),
	};
	const startTime = Date.now();
	if (options.structuredOutput) {
		try {
			if (existsSync(options.structuredOutput.outputPath)) unlinkSync(options.structuredOutput.outputPath);
		} catch {
			// Missing/stale structured-output files are handled after the child exits.
		}
	}
	const controlConfig = options.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	const attemptTimeout = resolveAttemptTimeout(options);
	const progress: AgentProgress = {
		index: options.index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: startTime,
	};
	result.progress = progress;
	if (attemptTimeout?.remainingMs === 0) {
		result.exitCode = 1;
		result.timedOut = true;
		result.error = attemptTimeout.message;
		result.finalOutput = attemptTimeout.message;
		progress.status = "failed";
		progress.error = attemptTimeout.message;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		return result;
	}
	const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };
	if (liveChildren && liveChildKey && controlRoot && steerInboxDir && actionControlDir) {
		registerForegroundLiveChild(liveChildren, {
			runId: options.runId,
			index,
			agent: agent.name,
			status: "running",
			controlRoot,
			steerInboxDir,
			actionControlDir,
			...(shared.transcriptWriter ? { transcriptPath: shared.transcriptWriter.path } : {}),
			...(shared.transcriptWriter ? {
				transcriptRoot: isRuntimeLiveTranscript(shared.transcriptWriter.path)
					? LIVE_TRANSCRIPTS_DIR
					: options.artifactsDir,
			} : {}),
			...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
			updatedAt: Date.now(),
		});
	}

	const state = createSingleAttemptState({
		options: stateOptions,
		agent,
		shared,
		runtimeCwd,
		task,
		modelArg,
		startTime,
		controlConfig,
		attemptTimeout,
		args,
		tempDir,
		spawnEnv,
	});
	state.result = result;
	state.progress = progress;

	const registry = options.persistentChildRegistry;
	const childKey = `${options.runId}/${index}`;
	let rpcChild: PersistentRpcChild | undefined;

	let exitCode: number;
	try {
		exitCode = await new Promise<number>((resolve) => {
			const spawnSpec = getPiSpawnCommand(args);
			const proc = spawn(spawnSpec.command, spawnSpec.args, {
				cwd: options.cwd ?? runtimeCwd,
				env: spawnEnv,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			state.proc = proc;
			state.jsonlWriter = createJsonlWriter(shared.jsonlPath, proc.stdout);
			state.resolve = resolve;
			// Wire extracted handlers onto the shared state object before any event
			// can fire (the executor runs to completion synchronously first).
			attachLifecycleHandlers(state);
			attachControlHandlers(state);
			attachBudgetHandlers(state);
			attachEventHandlers(state);

			// Registrations in the original order.
			state.unsubscribeIntercomDetach = registerIntercomDetach(state);
			if (controlConfig.enabled) startActivityTimer(state);
			if (attemptTimeout) startTimeoutTimer(state);
			state.clearStdioGuard = attachPostExitStdioGuard(proc, { idleMs: 2000, hardMs: 8000 });
			registerProcessHandlers(state);
			registerSignalHandlers(state);

			const rpcWrite = attachRpcProtocol(proc).write;
			state.rpcWrite = rpcWrite;
			const closed = new Promise<void>((closedResolve) => {
				proc.once("close", () => closedResolve());
				proc.once("error", () => closedResolve());
			});
			const child: PersistentRpcChild = {
				key: childKey,
				sessionFile: options.sessionFile,
				proc,
				write: rpcWrite,
				settled: false,
				lastActivityAt: Date.now(),
				pendingDialogs: new Map<string, { resolve: (value: unknown) => void }>(),
				pendingRequestIds: new Set<string>(),
				closed,
				close: async () => {},
			};
			child.close = createRpcChildCloser(child, {});
			rpcChild = child;
			registry?.register(child);
			rpcWrite.write({ type: "prompt", message: task });
			state.fireUpdate();
		});
	} catch (error) {
		removeLiveChild("failed");
		throw error;
	}

	try {
		const finalized = await finalizeSingleAttempt(state, exitCode);
		if (finalized.detached) {
			// Decided 2026-07-31: a detached child's RPC process is terminated
			// (abort + graceful shutdown), not handed off; continued conversation
			// with a detached child is deferred. The registry entry must not leak.
			const detached = registry?.get(childKey) ?? rpcChild;
			if (detached) {
				registry?.unregister(childKey);
				detached.write.write({ type: "abort" });
				if (registry) void detached.close("graceful");
				else await detached.close("graceful");
			}
			return finalized;
		}
		// A successfully settled resident child stays in the registry for later
		// viewer turns. Every other outcome (failed, timed out, interrupted, or
		// crashed before settle) has no conversational future: unregister and
		// release the process so the viewer can never route into a dead child
		// and the eviction timer never has to find a lingering entry.
		if (registry) {
			const resident = registry.get(childKey);
			if (resident) {
				if (state.settled && finalized.exitCode === 0 && !finalized.error) {
					resident.settled = true;
					finalized.residentChild = true;
				} else {
					registry.unregister(childKey);
					void resident.close("graceful");
				}
			}
		} else if (rpcChild) {
			await rpcChild.close("graceful");
		}
		removeLiveChild(finalized.exitCode === 0 && !finalized.error ? "completed" : "failed");
		return finalized;
	} catch (error) {
		if (!registry && rpcChild) await rpcChild.close("graceful");
		removeLiveChild("failed");
		throw error;
	}
}
