/** foreground-state (split from subagent-executor.ts; internal-only). */

import { resolveSubagentResultStatus } from "../../../intercom/result-intercom.ts";
import { getStepAgents, isDynamicParallelStep } from "../../../shared/settings.ts";
import { type Details, type ExtensionConfig, type SingleResult, type SubagentState, resolveMaxSubagentSpawnsPerSession } from "../../../shared/types.ts";
import { type NestedRunResolutionScope, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, updateForegroundNestedProjection } from "../../shared/nested-events.ts";
import { formatNestedRunStatusLines } from "../../shared/nested-render.ts";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ExecutorDeps, type SubagentParamsLike } from "./types.ts";
import * as path from "node:path";


export function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}


export function getForegroundControl(state: SubagentState, runId: string | undefined) {
	if (runId) return state.foregroundControls.get(runId);
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest) return latest;
	}
	let newest: (SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never) | undefined;
	for (const control of state.foregroundControls.values()) {
		if (!newest || control.updatedAt > newest.updatedAt) newest = control;
	}
	return newest;
}


export function formatForegroundActivity(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): string | undefined {
	const facts: string[] = [];
	if (control.currentTool && control.currentToolStartedAt) facts.push(`tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`);
	else if (control.currentTool) facts.push(`tool ${control.currentTool}`);
	if (control.currentPath) facts.push(`path ${control.currentPath}`);
	if (control.turnCount !== undefined) facts.push(`${control.turnCount} turns`);
	if (control.tokens !== undefined) facts.push(`${control.tokens} tokens`);
	if (control.toolCount !== undefined) facts.push(`${control.toolCount} tools`);
	if (!control.lastActivityAt) {
		if (control.currentActivityState === "needs_attention") return ["needs attention", ...facts].join(" | ");
		if (control.currentActivityState === "active_long_running") return ["active but long-running", ...facts].join(" | ");
		return facts.length ? facts.join(" | ") : undefined;
	}
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	if (control.currentActivityState === "needs_attention") return [`no activity for ${seconds}s`, ...facts].join(" | ");
	if (control.currentActivityState === "active_long_running") return [`active but long-running; last activity ${seconds}s ago`, ...facts].join(" | ");
	return [`active ${seconds}s ago`, ...facts].join(" | ");
}


export function nestedResolutionScopeForExecutor(deps: ExecutorDeps): NestedRunResolutionScope | undefined {
	if (deps.allowMutatingManagementActions !== false) return undefined;
	const route = resolveInheritedNestedRouteFromEnv();
	const address = route ? resolveNestedParentAddressFromEnv() : undefined;
	return {
		routes: route ? [route] : [],
		...(address ? { descendantOf: { parentRunId: address.parentRunId, ...(address.parentStepIndex !== undefined ? { parentStepIndex: address.parentStepIndex } : {}) } } : {}),
	};
}


export function trustedSessionRootsForStatus(ctx: ExtensionContext, deps: ExecutorDeps): string[] {
	const roots = deps.config.defaultSessionDir ? [path.resolve(deps.expandTilde(deps.config.defaultSessionDir))] : [];
	const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
	if (parentSessionFile) roots.push(deps.getSubagentSessionRoot(parentSessionFile));
	return [...new Set(roots)];
}


export function reserveSubagentSpawns(input: { state: SubagentState; config: ExtensionConfig; sessionId: string | null; requested: number; mode: "single" | "parallel" | "chain" }): AgentToolResult<Details> | undefined {
	if (input.requested <= 0) return undefined;
	if (input.state.subagentSpawns?.sessionId !== input.sessionId) {
		input.state.subagentSpawns = { sessionId: input.sessionId, count: 0 };
	}
	const maxSpawns = resolveMaxSubagentSpawnsPerSession(input.config.maxSubagentSpawnsPerSession);
	const used = input.state.subagentSpawns.count;
	if (used + input.requested > maxSpawns) {
		return {
			content: [{ type: "text", text: `Subagent spawn limit reached for this session (${used}/${maxSpawns} used, ${input.requested} requested). Complete the work directly or start a new session.` }],
			isError: true,
			details: { mode: input.mode, results: [] },
		};
	}
	input.state.subagentSpawns.count = used + input.requested;
	return undefined;
}


export function countRequestedSubagentSpawns(params: SubagentParamsLike, config: ExtensionConfig): number {
	if (params.tasks) return params.tasks.length;
	if (params.chain) {
		return params.chain.reduce((total, step) => {
			if (isDynamicParallelStep(step)) return total + (step.expand.maxItems ?? config.chain?.dynamicFanout?.maxItems ?? 0);
			return total + getStepAgents(step).length;
		}, 0);
	}
	return params.agent ? 1 : 0;
}


export function foregroundStatusResult(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): AgentToolResult<Details> {
	let nestedWarning: string | undefined;
	try {
		updateForegroundNestedProjection(control);
	} catch (error) {
		nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
	const activity = formatForegroundActivity(control);
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent ? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}` : undefined,
		activity ? `Activity: ${activity}` : undefined,
	].filter((line): line is string => Boolean(line));
	lines.push(...formatNestedRunStatusLines(control.nestedChildren, { indent: "", commandHints: true, maxLines: 20 }));
	if (nestedWarning) lines.push(`Warning: ${nestedWarning}`);
	return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}


export function trimRememberedForegroundRuns(state: SubagentState): void {
	if (!state.foregroundRuns) return;
	while (state.foregroundRuns.size > 50) {
		const oldest = [...state.foregroundRuns.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0];
		if (!oldest) break;
		state.foregroundRuns.delete(oldest.runId);
	}
}


export function rememberForegroundRun(state: SubagentState, input: { runId: string; mode: "single" | "parallel" | "chain"; cwd: string; results: SingleResult[] }): void {
	state.foregroundRuns ??= new Map();
	const previous = state.foregroundRuns.get(input.runId);
	const updatedAt = Date.now();
	state.foregroundRuns.set(input.runId, {
		runId: input.runId,
		mode: input.mode,
		cwd: input.cwd,
		updatedAt,
		children: input.results.map((result, index) => {
			const child = {
				agent: result.agent,
				index,
				status: resolveSubagentResultStatus({ exitCode: result.exitCode, interrupted: result.interrupted, detached: result.detached }),
				updatedAt,
				...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
				...(result.finalOutput ? { finalOutput: result.finalOutput } : {}),
				...(result.outputMode ? { outputMode: result.outputMode } : {}),
				...(result.savedOutputPath ? { savedOutputPath: result.savedOutputPath } : {}),
				...(result.outputSaveError ? { outputSaveError: result.outputSaveError } : {}),
				...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
				...(result.artifactPaths ? { artifactPaths: result.artifactPaths } : {}),
				...(result.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
				...(result.transcriptError ? { transcriptError: result.transcriptError } : {}),
				...(result.detachedReason ? { detachedReason: result.detachedReason } : {}),
			};
			const recovered = previous?.children[index];
			return child.status === "detached" && recovered && recovered.status !== "detached" ? recovered : child;
		}),
	});
	trimRememberedForegroundRuns(state);
}


export function updateRememberedForegroundChild(state: SubagentState, input: { runId: string; mode: "single" | "parallel" | "chain"; cwd: string; index: number; result: SingleResult }): void {
	state.foregroundRuns ??= new Map();
	const updatedAt = Date.now();
	let run = state.foregroundRuns.get(input.runId);
	if (!run) {
		run = { runId: input.runId, mode: input.mode, cwd: input.cwd, updatedAt, children: [] };
		state.foregroundRuns.set(input.runId, run);
	}
	run.updatedAt = updatedAt;
	const child = run.children[input.index] ?? { agent: input.result.agent, index: input.index, status: "detached" as const };
	run.children[input.index] = {
		...child,
		agent: input.result.agent,
		index: input.index,
		status: resolveSubagentResultStatus({ exitCode: input.result.exitCode, interrupted: input.result.interrupted, detached: false }),
		updatedAt,
		...(input.result.exitCode !== undefined ? { exitCode: input.result.exitCode } : {}),
		...(input.result.finalOutput ? { finalOutput: input.result.finalOutput } : {}),
		outputMode: input.result.outputMode,
		savedOutputPath: input.result.savedOutputPath,
		outputSaveError: input.result.outputSaveError,
		...(input.result.sessionFile ? { sessionFile: input.result.sessionFile } : {}),
		...(input.result.artifactPaths ? { artifactPaths: input.result.artifactPaths } : {}),
		...(input.result.transcriptPath ? { transcriptPath: input.result.transcriptPath } : {}),
		...(input.result.transcriptError ? { transcriptError: input.result.transcriptError } : {}),
		...(input.result.detachedReason ? { detachedReason: input.result.detachedReason } : {}),
	};
	trimRememberedForegroundRuns(state);
}

/**
 * Foreground-detached children are tracked only in memory, so the
 * result-watcher (which drives async completion notifications) never sees
 * them. Emit its completion event here so the parent is notified, and
 * deliver a best-effort intercom result receipt mirroring the async path.
 */
