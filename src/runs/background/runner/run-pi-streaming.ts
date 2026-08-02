import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { ChildTranscriptWriter } from "../../../shared/child-transcript.ts";
import { getSubagentDepthEnv, type TurnBudgetState, type Usage } from "../../../shared/types.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../../shared/post-exit-stdio-guard.ts";
import { extractTextFromContent, extractToolArgsPreview, getFinalOutput } from "../../../shared/utils.ts";
import { getPiSpawnCommand } from "../../shared/pi-spawn.ts";
import { attachRpcProtocol } from "../../persistent/rpc-protocol.ts";
import { createRpcChildCloser } from "../../persistent/rpc-child-registry.ts";
import { isMutatingTool } from "../../shared/long-running-guard.ts";
import { appendDiagnosticJsonl, shouldPersistChildEvent } from "./event-logging.ts";
import { emptyUsage, isTerminalAssistantStop } from "./usage-helpers.ts";
import type { ConversationRelayHook } from "./conversation-bridge.ts";
import type { ChildEvent, ChildEventContext, RunPiStreamingResult } from "./types.ts";

export function runPiStreaming(
	args: string[],
	cwd: string,
	outputFile: string,
	env?: Record<string, string | undefined>,
	piPackageRoot?: string,
	piArgv1?: string,
	maxSubagentDepth?: number,
	childEventContext?: ChildEventContext,
	registerInterrupt?: (interrupt: (() => void) | undefined) => void,
	onChildEvent?: (event: ChildEvent) => void,
	transcriptWriter?: ChildTranscriptWriter,
	registerTimeout?: (interrupt: (() => void) | undefined) => void,
	timeoutMessage?: string,
	registerTurnBudgetAbort?: (abort: ((message: string, state?: TurnBudgetState) => void) | undefined) => void,
	registry?: import("../../persistent/rpc-child-registry.ts").RpcChildRegistry,
	task?: string,
	conversationRelay?: ConversationRelayHook,
): Promise<RunPiStreamingResult> {
	return new Promise((resolve) => {
		const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
		const spawnEnv = { ...process.env, ...(env ?? {}), ...getSubagentDepthEnv(maxSubagentDepth) };
		const spawnSpec = getPiSpawnCommand(args, {
			...(piPackageRoot ? { piPackageRoot } : {}),
			...(piArgv1 ? { argv1: piArgv1 } : {}),
		});
		const child = spawn(spawnSpec.command, spawnSpec.args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: spawnEnv,
			windowsHide: true,
		});
		let stderr = "";
		let stdoutBuf = "";
		let stderrBuf = "";
		const messages: Message[] = [];
		const usage = emptyUsage();
		let model: string | undefined;
		let error: string | undefined;
		let assistantError: string | undefined;
		let interrupted = false;
		let timedOut = false;
		let turnBudgetExceeded = false;
		let turnBudgetMessage: string | undefined;
		let turnBudget: TurnBudgetState | undefined;
		let observedMutationAttempt = false;
		const rawStdoutLines: string[] = [];

		const writeOutputLine = (line: string) => {
			if (!line.trim()) return;
			outputStream.write(`${line}\n`);
		};

		const writeOutputText = (text: string) => {
			for (const line of text.split("\n")) {
				writeOutputLine(line);
			}
		};

		const appendChildEvent = (event: Record<string, unknown>) => {
			if (!childEventContext) return;
			if (!shouldPersistChildEvent(event)) return;
			appendDiagnosticJsonl(childEventContext.eventsPath, JSON.stringify({
				...event,
				subagentSource: "child",
				subagentRunId: childEventContext.runId,
				subagentStepIndex: childEventContext.stepIndex,
				subagentAgent: childEventContext.agent,
				observedAt: Date.now(),
			}), typeof event.type === "string" ? event.type : undefined);
		};

		const appendChildLine = (type: "subagent.child.stdout" | "subagent.child.stderr", line: string) => {
			appendChildEvent({ type, line });
			if (type === "subagent.child.stdout") transcriptWriter?.writeStdoutLine(line);
			else transcriptWriter?.writeStderrLine(line);
		};

		const processStdoutLine = (line: string) => {
			if (!line.trim()) return;
			// Mirror the raw RPC stdout line into the conversation relay so the
			// parent viewer sees the identical stream (verbatim JSONL, LF framing).
			conversationRelay?.appendParsedLine(line);
			let event: ChildEvent;
			try {
				event = JSON.parse(line) as ChildEvent;
			} catch {
				rawStdoutLines.push(line);
				writeOutputLine(line);
				appendChildLine("subagent.child.stdout", line);
				return;
			}

			appendChildEvent(event);
			transcriptWriter?.writeChildEvent(event);
			onChildEvent?.(event);

			if (event.type === "agent_settled") {
				// RPC logical completion for the async runner: finalize the
				// step result here and keep the process resident for viewer turns.
				settled = true;
				clearDrainTimers();
				if (conversationRelay && residentKey) {
					conversationRelay.appendMarker({ type: "child_settled", key: residentKey });
				}
				const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
				const finalError = error ?? assistantError;
				const result: RunPiStreamingResult = {
					stderr,
					exitCode: finalError ? 1 : 0,
					residentChild: !finalError,
					messages,
					usage,
					model,
					error: finalError,
					finalOutput,
					observedMutationAttempt,
				};
				// A settled successful child stays resident for viewer turns; a
				// failed one has no conversational future and is evicted now,
				// awaiting close so the session file is never double-written.
				if (registry && residentKey) {
					const resident = registry.get(residentKey);
					if (resident) {
						resident.settled = !finalError;
						if (finalError) {
							registry.unregister(residentKey);
							void resident.close("graceful").catch(() => {}).then(() => finishResolve(result));
							return;
						}
					}
				}
				finishResolve(result);
				return;
			}

			if (event.type === "tool_execution_start" && event.toolName) {
				observedMutationAttempt = observedMutationAttempt || isMutatingTool(event.toolName, event.args);
				const toolArgs = extractToolArgsPreview(event.args ?? {});
				writeOutputLine(toolArgs ? `${event.toolName}: ${toolArgs}` : event.toolName);
				return;
			}

			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				messages.push(event.message);
				const text = extractTextFromContent(event.message.content);
				if (text) writeOutputText(text);

				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				if (event.message.model) model = event.message.model;
				if (event.message.errorMessage) assistantError = event.message.errorMessage;
				const eventUsage = event.message.usage;
				if (eventUsage) {
					usage.turns++;
					usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
					usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
					usage.cacheRead += eventUsage.cacheRead ?? 0;
					usage.cacheWrite += eventUsage.cacheWrite ?? 0;
					usage.cost += eventUsage.cost?.total ?? 0;
				}
				if (isTerminalAssistantStop(event.message)) {
					if (!event.message.errorMessage && extractTextFromContent(event.message.content).trim()) assistantError = undefined;
					cleanTerminalAssistantStopReceived ||= !event.message.errorMessage;
				}
			}
		};

		const processStderrText = (text: string) => {
			stderr += text;
			stderrBuf += text;
			outputStream.write(text);
			if (!childEventContext) return;
			const lines = stderrBuf.split("\n");
			stderrBuf = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				appendChildLine("subagent.child.stderr", line);
			}
		};

		// Guard the case that can leave the parent waiting on `close` forever:
		// a child that never exits.
		const TIMEOUT_HARD_KILL_MS = 3000;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let timeoutHardKillTimer: NodeJS.Timeout | undefined;
		let turnBudgetTerminationTimer: NodeJS.Timeout | undefined;
		let turnBudgetHardKillTimer: NodeJS.Timeout | undefined;
		let settled = false;
		// RPC mode: agent_settled resolves the run while the process stays
		// resident; the close handler must not double-resolve.
		let runResolved = false;
		let residentKey: string | undefined;
		const clearStdioGuard = attachPostExitStdioGuard(child, { idleMs: 2000, hardMs: 8000 });

		const finishResolve = (result: RunPiStreamingResult): void => {
			if (runResolved) return;
			runResolved = true;
			registerInterrupt?.(undefined);
			registerTimeout?.(undefined);
			registerTurnBudgetAbort?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			resolve(result);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdoutBuf += text;
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() || "";
			for (const line of lines) processStdoutLine(line);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			processStderrText(chunk.toString());
		});
		registerInterrupt?.(() => {
			if (settled || timedOut) return;
			interrupted = true;
			if (!error) error = "Interrupted. Waiting for explicit next action.";
			trySignalChild(child, "SIGINT");
			setTimeout(() => {
				if (!settled && !timedOut) trySignalChild(child, "SIGTERM");
			}, 1000).unref?.();
		});
		registerTimeout?.(() => {
			if (settled || timedOut) return;
			timedOut = true;
			interrupted = false;
			error = timeoutMessage ?? "Subagent timed out.";
			trySignalChild(child, "SIGTERM");
			timeoutHardKillTimer = setTimeout(() => {
				if (!settled) trySignalChild(child, "SIGKILL");
			}, TIMEOUT_HARD_KILL_MS);
			timeoutHardKillTimer.unref?.();
		});
		registerTurnBudgetAbort?.((message, state) => {
			if (settled || timedOut || turnBudgetExceeded) return;
			turnBudgetExceeded = true;
			turnBudgetMessage = message;
			turnBudget = state;
			interrupted = false;
			error = message;
			trySignalChild(child, "SIGINT");
			turnBudgetTerminationTimer = setTimeout(() => {
				if (!settled && !timedOut) trySignalChild(child, "SIGTERM");
			}, 1000);
			turnBudgetTerminationTimer.unref?.();
			turnBudgetHardKillTimer = setTimeout(() => {
				if (!settled && !timedOut) trySignalChild(child, "SIGKILL");
			}, 4000);
			turnBudgetHardKillTimer.unref?.();
		});
		const clearDrainTimers = () => {
			if (timeoutHardKillTimer) {
				clearTimeout(timeoutHardKillTimer);
				timeoutHardKillTimer = undefined;
			}
			if (turnBudgetTerminationTimer) {
				clearTimeout(turnBudgetTerminationTimer);
				turnBudgetTerminationTimer = undefined;
			}
			if (turnBudgetHardKillTimer) {
				clearTimeout(turnBudgetHardKillTimer);
				turnBudgetHardKillTimer = undefined;
			}
		};
		child.on("exit", () => {
			clearDrainTimers();
		});
		child.on("close", (exitCode, signal) => {
			settled = true;
			if (conversationRelay && residentKey) {
				conversationRelay.appendMarker({
					type: "child_closed",
					key: residentKey,
					reason: signal ? `signal:${signal}` : exitCode === null ? "closed" : `exit:${exitCode}`,
				});
			}
			registerInterrupt?.(undefined);
			registerTimeout?.(undefined);
			registerTurnBudgetAbort?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);
			if (stderrBuf.trim()) appendChildLine("subagent.child.stderr", stderrBuf);
			outputStream.end();
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const finalError = error ?? assistantError;
			const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !finalError;
			finishResolve({
				stderr,
				exitCode: timedOut ? 1 : turnBudgetExceeded ? 1 : interrupted || forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (exitCode ?? 1) : exitCode,
				messages,
				usage,
				model,
				error: timedOut ? (timeoutMessage ?? "Subagent timed out.") : turnBudgetExceeded ? turnBudgetMessage : interrupted || forcedDrainAfterFinalSuccess ? undefined : finalError,
				finalOutput: timedOut && !finalOutput.trim() ? (timeoutMessage ?? "Subagent timed out.") : finalOutput,
				interrupted,
				timedOut,
				turnBudget,
				turnBudgetExceeded,
				wrapUpRequested: turnBudget?.outcome === "wrap-up-requested" || turnBudgetExceeded || undefined,
				observedMutationAttempt,
			});
		});

		child.on("error", (spawnError) => {
			settled = true;
			if (conversationRelay && residentKey) {
				conversationRelay.appendMarker({ type: "child_closed", key: residentKey, reason: "spawn-error" });
			}
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const spawnErrorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
			finishResolve({ stderr, exitCode: 1, messages, usage, model, error: timedOut ? (timeoutMessage ?? "Subagent timed out.") : turnBudgetExceeded ? turnBudgetMessage : error ?? assistantError ?? spawnErrorMessage, finalOutput: timedOut && !finalOutput.trim() ? (timeoutMessage ?? "Subagent timed out.") : finalOutput, timedOut, turnBudget, turnBudgetExceeded, wrapUpRequested: turnBudget?.outcome === "wrap-up-requested" || turnBudgetExceeded || undefined, observedMutationAttempt });
		});

		if (registry) {
			// RPC async: deliver the task over stdin and park the resident child
			// for later viewer turns. Eviction is the registry's job. The task
			// text is passed explicitly (RPC mode never embeds it in argv).
			const rpcWrite = attachRpcProtocol(child).write;
			const closed = new Promise<void>((closedResolve) => {
				child.once("close", () => closedResolve());
				child.once("error", () => closedResolve());
			});
			const resident = {
				key: childEventContext ? `${childEventContext.runId}/${childEventContext.stepIndex}` : `async/${Date.now()}`,
				sessionFile: undefined,
				proc: child,
				write: rpcWrite,
				settled: false,
				lastActivityAt: Date.now(),
				pendingDialogs: new Map<string, { resolve: (value: unknown) => void }>(),
				pendingRequestIds: new Set<string>(),
				closed,
				close: async () => {},
			};
			resident.close = createRpcChildCloser(resident, {});
			registry.register(resident);
			residentKey = resident.key;
			conversationRelay?.appendMarker({ type: "child_ready", key: resident.key });
			rpcWrite.write({ type: "prompt", message: task ?? "" });
		}
	});
}
