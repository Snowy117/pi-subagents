import { trySignalChild } from "../../../shared/post-exit-stdio-guard.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT } from "../../../shared/types.ts";
import type { SingleAttemptState } from "./single-attempt-state.ts";
import { stripAcceptanceReport } from "../../shared/acceptance.ts";
import { cleanupTempDir } from "../../shared/pi-args.ts";
import { formatSavedOutputReference, resolveSingleOutput } from "../../shared/single-output.ts";
import { getFinalOutput } from "../../../shared/utils.ts";
import { snapshotProgress, snapshotResult } from "./attempt-helpers.ts";
import { writeArtifact } from "../../../shared/artifacts.ts";

export function registerIntercomDetach(state: SingleAttemptState): (() => void) | undefined {
	return state.options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
		if (!state.options.allowIntercomDetach || state.detached || state.processClosed) return;
		if (!payload || typeof payload !== "object") return;
		const event = payload as { requestId?: unknown; runId?: unknown; agent?: unknown; childIndex?: unknown };
		const requestId = event.requestId;
		if (typeof requestId !== "string" || requestId.length === 0) return;
		const hasRoute = event.runId !== undefined || event.agent !== undefined || event.childIndex !== undefined;
		if (hasRoute) {
			if (typeof event.runId === "string" && event.runId !== state.options.runId) return;
			if (typeof event.agent === "string" && event.agent !== state.agent.name) return;
			if (typeof event.childIndex === "number" && event.childIndex !== (state.options.index ?? 0)) return;
		} else if (!state.intercomStarted) return;
		state.options.intercomEvents?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true, runId: state.options.runId, agent: state.agent.name, childIndex: state.options.index ?? 0 });
		state.detachForIntercom();
	});
}

export function startActivityTimer(state: SingleAttemptState): void {
	state.activityTimer = setInterval(() => {
		if (state.processClosed || state.settled || state.detached) return;
		const now = Date.now();
		if (state.updateActivityState(now)) {
			state.progress.durationMs = now - state.startTime;
			state.fireUpdate();
		}
	}, 1000);
	state.activityTimer.unref?.();
}

export function startTimeoutTimer(state: SingleAttemptState): void {
	const attemptTimeout = state.attemptTimeout;
	if (!attemptTimeout) return;
	state.timeoutTimer = setTimeout(() => {
		if (state.processClosed || state.settled || state.detached || state.interruptedByControl) return;
		state.result.timedOut = true;
		state.result.error = attemptTimeout.message;
		state.result.finalOutput = attemptTimeout.message;
		state.progress.status = "failed";
		state.progress.error = attemptTimeout.message;
		state.progress.durationMs = Date.now() - state.startTime;
		state.fireUpdate();
		trySignalChild(state.proc, "SIGINT");
		state.timeoutTerminationTimer = setTimeout(() => {
			if (state.processClosed || state.settled || state.detached) return;
			trySignalChild(state.proc, "SIGTERM");
		}, 1000);
		state.timeoutTerminationTimer.unref?.();
		state.timeoutHardKillTimer = setTimeout(() => {
			if (state.processClosed || state.settled || state.detached) return;
			trySignalChild(state.proc, "SIGKILL");
		}, 4000);
		state.timeoutHardKillTimer.unref?.();
	}, attemptTimeout.remainingMs);
	state.timeoutTimer.unref?.();
}

export function registerProcessHandlers(state: SingleAttemptState): void {
	const proc = state.proc;
	proc.stdout.on("data", (d) => {
		state.buf += d.toString();
		const lines = state.buf.split("\n");
		state.buf = lines.pop() || "";
		lines.forEach((line) => state.processLine(line));
	});
	proc.stderr.on("data", (d) => {
		state.stderrBuf += d.toString();
	});
	proc.on("exit", () => {
		state.childExited = true;
		state.clearFinalDrainTimers();
	});
	proc.on("close", (code, signal) => {
		state.clearFinalDrainTimers();
		state.clearStdioGuard();
		void state.jsonlWriter.close().catch(() => {
			// JSONL artifact flush is best effort.
		});
		cleanupTempDir(state.tempDir);
		if (state.buf.trim()) state.processLine(state.buf);
		if (state.stderrBuf.trim()) state.shared.transcriptWriter?.writeStderrText(state.stderrBuf);
		if (!state.result.error && state.assistantError) state.result.error = state.assistantError;
		const forcedDrainAfterFinalSuccess = state.forcedTerminationSignal && state.cleanTerminalAssistantStopReceived && !state.result.error;
		if (code !== 0 && state.stderrBuf.trim() && !state.result.error && !forcedDrainAfterFinalSuccess) {
			state.result.error = state.stderrBuf.trim();
		}
		const finalCode = forcedDrainAfterFinalSuccess ? 0 : state.forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0);
		if (state.detached) {
			state.result.exitCode = state.result.error && finalCode === 0 ? 1 : finalCode;
			state.progress.status = state.result.exitCode === 0 ? "completed" : "failed";
			state.progress.durationMs = Date.now() - state.startTime;
			if (state.result.error) state.progress.error = state.result.error;
			state.result.progressSummary = {
				toolCount: state.progress.toolCount,
				tokens: state.progress.tokens,
				durationMs: state.progress.durationMs,
			};
			let fullOutput = stripAcceptanceReport(getFinalOutput(state.result.messages ?? []));
			fullOutput = fullOutput.trim() || state.result.error || state.result.finalOutput || "Detached child exited without final output.";
			state.result.outputMode = state.options.outputMode ?? "inline";
			if (state.options.outputPath && state.result.exitCode === 0) {
				const resolvedOutput = resolveSingleOutput(state.options.outputPath, fullOutput, state.shared.outputSnapshot);
				fullOutput = stripAcceptanceReport(resolvedOutput.fullOutput);
				state.result.savedOutputPath = resolvedOutput.savedPath;
				state.result.outputSaveError = resolvedOutput.saveError;
				if (resolvedOutput.savedPath) {
					state.result.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
				} else {
					state.result.exitCode = 1;
					state.result.error = `Output file was not finalized after detached child exit: ${resolvedOutput.saveError ?? state.options.outputPath}`;
					state.progress.status = "failed";
					state.progress.error = state.result.error;
				}
			}
			state.result.finalOutput = state.options.outputMode === "file-only" && state.result.savedOutputPath && state.result.outputReference
				? state.result.outputReference.message
				: fullOutput;
			if (state.result.artifactPaths && state.options.artifactConfig?.enabled !== false && state.options.artifactConfig?.includeOutput !== false) {
				try {
					writeArtifact(state.result.artifactPaths.outputPath, fullOutput);
				} catch {
					// Detached children may outlive test/temp cleanup; recovered status is best-effort.
				}
			}
			state.options.onDetachedExit?.(snapshotResult(state.result, snapshotProgress(state.progress)));
			state.finish(-2);
			return;
		}
		state.processClosed = true;
		state.finish(finalCode);
	});
	proc.on("error", (error) => {
		state.clearFinalDrainTimers();
		state.clearStdioGuard();
		void state.jsonlWriter.close().catch(() => {
			// JSONL artifact flush is best effort.
		});
		cleanupTempDir(state.tempDir);
		if (state.stderrBuf.trim()) state.shared.transcriptWriter?.writeStderrText(state.stderrBuf);
		if (!state.result.error) {
			state.result.error = error instanceof Error ? error.message : String(error);
		}
		state.finish(1);
	});
}

export function registerSignalHandlers(state: SingleAttemptState): void {
	const proc = state.proc;
	if (state.options.signal) {
		const kill = () => {
			if (state.processClosed || state.detached) return;
			proc.kill("SIGTERM");
			setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
		};
		if (state.options.signal.aborted) kill();
		else {
			state.options.signal.addEventListener("abort", kill, { once: true });
			state.removeAbortListener = () => state.options.signal?.removeEventListener("abort", kill);
		}
	}

	if (state.options.interruptSignal) {
		const interrupt = () => {
			if (state.processClosed || state.detached || state.settled) return;
			if (state.result.timedOut) return;
			state.interruptedByControl = true;
			state.clearTimeoutTimers();
			state.progress.status = "running";
			state.progress.durationMs = Date.now() - state.startTime;
			state.result.interrupted = true;
			state.result.finalOutput = "Interrupted. Waiting for explicit next action.";
			state.progress.activityState = undefined;
			state.fireUpdate();
			trySignalChild(proc, "SIGINT");
			setTimeout(() => {
				if (state.settled || state.processClosed || state.detached) return;
				trySignalChild(proc, "SIGTERM");
			}, 1000).unref?.();
		};
		if (state.options.interruptSignal.aborted) interrupt();
		else {
			state.options.interruptSignal.addEventListener("abort", interrupt, { once: true });
			state.removeInterruptListener = () => state.options.interruptSignal?.removeEventListener("abort", interrupt);
		}
	}
}
