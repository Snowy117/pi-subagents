/** action-dispatch (split from subagent-executor.ts; internal-only).
 *  Extracted from createSubagentExecutor's `if (action) {...}` block so the
 *  orchestrator stays concise. Pure move: returns the same AgentToolResult the
 *  inlined block returned, or undefined when no action. Async because some
 *  action handlers (resume / append-step / interrupt) are async. */

import { handleManagementAction } from "../../../agents/agent-management.ts";
import { buildDoctorReport } from "../../../extension/doctor.ts";
import { resolveIntercomSessionTarget } from "../../../intercom/intercom-bridge.ts";
import { type Details, ASYNC_DIR, RESULTS_DIR, SUBAGENT_ACTIONS } from "../../../shared/types.ts";
import { resolveAsyncRunLocation } from "../../background/async-resume.ts";
import { type ResolvedSubagentRunId, resolveSubagentRunId } from "../../background/run-id-resolver.ts";
import { inspectSubagentStatus } from "../../background/run-status.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { appendStepToAsyncChain } from "./chain-append.ts";
import { getForegroundControl, foregroundStatusResult, nestedResolutionScopeForExecutor, trustedSessionRootsForStatus } from "./foreground-state.ts";
import { interruptAsyncRun, steerAsyncRun } from "./interrupt-steer.ts";
import { interruptNestedRun, steerNestedRun } from "./nested-runs.ts";
import { resumeAsyncRun } from "./async-resume.ts";
import { type ExecutorDeps, type SubagentParamsLike, MUTATING_MANAGEMENT_ACTIONS } from "./types.ts";


export async function dispatchAction(input: {
	deps: ExecutorDeps;
	ctx: ExtensionContext;
	params: SubagentParamsLike;
	requestCwd: string;
}): Promise<(AgentToolResult<Details> & { isError?: boolean }) | undefined> {
	const action = input.params.action;
	if (!action) return undefined;
	const { deps, ctx, params, requestCwd } = input;
	if (action === "doctor") {
		let currentSessionFile: string | null = null;
		let currentSessionId = deps.state.currentSessionId;
		let sessionError: string | undefined;
		try {
			currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
			currentSessionId = ctx.sessionManager.getSessionId();
		} catch (error) {
			sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		}
		let orchestratorTarget: string | undefined;
		try {
			orchestratorTarget = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
		} catch (error) {
			if (!sessionError) sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		}
		return {
			content: [{
				type: "text",
				text: buildDoctorReport({
					cwd: requestCwd,
					config: deps.config,
					state: deps.state,
					context: params.context,
					requestedSessionDir: params.sessionDir,
					currentSessionFile,
					currentSessionId,
					orchestratorTarget,
					sessionError,
					expandTilde: deps.expandTilde,
				}),
			}],
			details: { mode: "management", results: [] },
		};
	}
	if (action === "status") {
		const targetRunId = params.id ?? params.runId;
		const nestedScope = nestedResolutionScopeForExecutor(deps);
		const sessionRoots = trustedSessionRootsForStatus(ctx, deps);
		if (params.view === "fleet") {
			return inspectSubagentStatus(params, { state: deps.state, nested: nestedScope, sessionRoots });
		}
		if (targetRunId) {
			try {
				const resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedScope });
				if (resolved?.kind === "foreground") {
					const foreground = getForegroundControl(deps.state, resolved.id);
					if (foreground) {
						if (params.view === "transcript") {
							return {
								content: [{ type: "text", text: "Live foreground transcript is already visible in the expanded running subagent result. Persisted session transcript becomes inspectable after the foreground run completes when sessions are enabled." }],
								details: { mode: "management", results: [] },
							};
						}
						return foregroundStatusResult(foreground);
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
			}
		} else {
			const foreground = getForegroundControl(deps.state, undefined);
			if (foreground && params.view !== "transcript") return foregroundStatusResult(foreground);
			if (foreground && params.view === "transcript") {
				return {
					content: [{ type: "text", text: "Live foreground transcript is already visible in the expanded running subagent result. Pass an async run id to inspect a background transcript." }],
					details: { mode: "management", results: [] },
				};
			}
		}
		return inspectSubagentStatus(params, { state: deps.state, nested: nestedScope, sessionRoots });
	}
	if (action === "resume") {
		return resumeAsyncRun({ params: params, requestCwd, ctx, deps });
	}
	if (action === "steer") {
		const message = (params.message ?? params.task ?? "").trim();
		if (!message) return { content: [{ type: "text", text: "action='steer' requires message." }], isError: true, details: { mode: "management", results: [] } };
		const targetRunId = params.runId ?? params.id;
		if (params.dir) {
			try {
				const location = resolveAsyncRunLocation(params, ASYNC_DIR, RESULTS_DIR);
				const runId = location.resolvedId ?? targetRunId ?? path.basename(location.asyncDir ?? params.dir);
				return steerAsyncRun({ state: deps.state, runId, message, index: params.index, kill: deps.kill, location });
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
			}
		}
		if (!targetRunId) return { content: [{ type: "text", text: "action='steer' requires id or dir." }], isError: true, details: { mode: "management", results: [] } };
		let resolved: ResolvedSubagentRunId | undefined;
		try {
			resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
		}
		if (resolved?.kind === "nested") return steerNestedRun({ target: resolved, message, index: params.index });
		if (resolved?.kind === "foreground") return { content: [{ type: "text", text: "action='steer' currently supports live async Pi child sessions only; use action='interrupt' or action='resume' for foreground runs." }], isError: true, details: { mode: "management", results: [] } };
		if (resolved?.kind !== "async") return { content: [{ type: "text", text: `No async run found for '${targetRunId}'.` }], isError: true, details: { mode: "management", results: [] } };
		return steerAsyncRun({ state: deps.state, runId: resolved.id, message, index: params.index, kill: deps.kill, location: resolved.location });
	}
	if (action === "append-step") {
		return appendStepToAsyncChain({ params: params, requestCwd, ctx, deps });
	}
	if (action === "schedule" || action === "schedule-list" || action === "schedule-status" || action === "schedule-cancel") {
		if (!deps.handleScheduledRunAction) {
			return {
				content: [{ type: "text", text: `Action '${action}' is not available in this subagent context.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		return deps.handleScheduledRunAction(params, ctx);
	}
	if (action === "interrupt") {
		const targetRunId = params.runId ?? params.id;
		let resolved: ResolvedSubagentRunId | undefined;
		if (targetRunId) {
			try {
				resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
			}
		}
		if (resolved?.kind === "nested") return interruptNestedRun(resolved);
		const foreground = getForegroundControl(deps.state, resolved?.kind === "foreground" ? resolved.id : targetRunId);
		if (foreground?.interrupt) {
			const interrupted = foreground.interrupt();
			if (interrupted) {
				foreground.updatedAt = Date.now();
				foreground.currentActivityState = undefined;
				return {
					content: [{ type: "text", text: `Interrupt requested for foreground run ${foreground.runId}.` }],
					details: { mode: "management", results: [] },
				};
			}
			return {
				content: [{ type: "text", text: `Foreground run ${foreground.runId} has no active child step to interrupt.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		const asyncInterruptResult = interruptAsyncRun(
			deps.state,
			resolved?.kind === "async" ? resolved.id : targetRunId,
			deps.kill,
			resolved?.kind === "async" ? resolved.location : undefined,
		);
		if (asyncInterruptResult) return asyncInterruptResult;
		return {
			content: [{ type: "text", text: "No interrupt-capable run found in this session." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!(SUBAGENT_ACTIONS as readonly string[]).includes(action)) {
		return {
			content: [{ type: "text", text: `Unknown action: ${action}. Valid: ${SUBAGENT_ACTIONS.join(", ")}` }],
			isError: true,
			details: { mode: "management" as const, results: [] },
		};
	}
	if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
		return {
			content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
			isError: true,
			details: { mode: "management" as const, results: [] },
		};
	}
	return handleManagementAction(action, params, {
		...ctx,
		cwd: requestCwd,
		config: deps.config,
	});
}
