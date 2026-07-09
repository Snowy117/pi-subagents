import type { NestedRunSummary, NestedRunState, NestedStepSummary, TurnBudgetState } from "../../../shared/types.ts";
import { MAX_CHILDREN, MAX_DEPTH, MAX_STEPS, clampNumber, stringValue } from "./core.ts";
import { isSafeNestedId } from "./validation.ts";
import { sanitizeNestedPath } from "../nested-path.ts";

function sanitizeTokenUsage(value: unknown): NestedRunSummary["totalTokens"] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const input = clampNumber(raw.input);
	const output = clampNumber(raw.output);
	const total = clampNumber(raw.total);
	return input !== undefined && output !== undefined && total !== undefined
		? { input, output, total }
		: undefined;
}

function sanitizeCost(value: unknown): NestedRunSummary["totalCost"] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const inputTokens = clampNumber(raw.inputTokens);
	const outputTokens = clampNumber(raw.outputTokens);
	const costUsd = clampNumber(raw.costUsd);
	return inputTokens !== undefined && outputTokens !== undefined && costUsd !== undefined
		? { inputTokens, outputTokens, costUsd }
		: undefined;
}

function sanitizeTurnBudget(value: unknown): TurnBudgetState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const maxTurns = clampNumber(raw.maxTurns);
	const graceTurns = clampNumber(raw.graceTurns);
	const turnCount = clampNumber(raw.turnCount);
	const outcome = raw.outcome === "within-budget" || raw.outcome === "wrap-up-requested" || raw.outcome === "exceeded" ? raw.outcome : undefined;
	if (maxTurns === undefined || graceTurns === undefined || turnCount === undefined || !outcome) return undefined;
	return {
		maxTurns,
		graceTurns,
		turnCount,
		outcome,
		...(clampNumber(raw.wrapUpRequestedAtTurn) !== undefined ? { wrapUpRequestedAtTurn: clampNumber(raw.wrapUpRequestedAtTurn) } : {}),
		...(clampNumber(raw.exceededAtTurn) !== undefined ? { exceededAtTurn: clampNumber(raw.exceededAtTurn) } : {}),
	};
}

function sanitizeState(value: unknown, fallback: NestedRunState): NestedRunState {
	return value === "queued" || value === "running" || value === "complete" || value === "failed" || value === "paused"
		? value
		: fallback;
}

function sanitizeStep(input: unknown, depth: number): NestedStepSummary | undefined {
	if (!input || typeof input !== "object") return undefined;
	const raw = input as Record<string, unknown>;
	const agent = stringValue(raw.agent, 128);
	if (!agent) return undefined;
	const status = raw.status === "pending" || raw.status === "running" || raw.status === "complete" || raw.status === "completed" || raw.status === "failed" || raw.status === "paused"
		? raw.status
		: "pending";
	return {
		agent,
		status,
		...(stringValue(raw.sessionFile, 2048) ? { sessionFile: stringValue(raw.sessionFile, 2048) } : {}),
		...(raw.activityState === "active_long_running" || raw.activityState === "needs_attention" ? { activityState: raw.activityState } : {}),
		...(clampNumber(raw.lastActivityAt) !== undefined ? { lastActivityAt: clampNumber(raw.lastActivityAt) } : {}),
		...(stringValue(raw.currentTool, 128) ? { currentTool: stringValue(raw.currentTool, 128) } : {}),
		...(clampNumber(raw.currentToolStartedAt) !== undefined ? { currentToolStartedAt: clampNumber(raw.currentToolStartedAt) } : {}),
		...(stringValue(raw.currentPath, 2048) ? { currentPath: stringValue(raw.currentPath, 2048) } : {}),
		...(clampNumber(raw.turnCount) !== undefined ? { turnCount: clampNumber(raw.turnCount) } : {}),
		...(clampNumber(raw.toolCount) !== undefined ? { toolCount: clampNumber(raw.toolCount) } : {}),
		...(clampNumber(raw.startedAt) !== undefined ? { startedAt: clampNumber(raw.startedAt) } : {}),
		...(clampNumber(raw.endedAt) !== undefined ? { endedAt: clampNumber(raw.endedAt) } : {}),
		...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
		...(raw.timedOut === true ? { timedOut: true } : {}),
		...(sanitizeTurnBudget(raw.turnBudget) ? { turnBudget: sanitizeTurnBudget(raw.turnBudget) } : {}),
		...(raw.turnBudgetExceeded === true ? { turnBudgetExceeded: true } : {}),
		...(raw.wrapUpRequested === true ? { wrapUpRequested: true } : {}),
		...(depth < MAX_DEPTH && Array.isArray(raw.children) ? { children: raw.children.map((child) => sanitizeSummary(child, depth + 1)).filter((child): child is NestedRunSummary => Boolean(child)).slice(0, MAX_CHILDREN) } : {}),
	};
}

export function sanitizeSummary(input: unknown, depth = 0): NestedRunSummary | undefined {
	if (!input || typeof input !== "object") return undefined;
	const raw = input as Record<string, unknown>;
	if (!isSafeNestedId(raw.id) || !isSafeNestedId(raw.parentRunId)) return undefined;
	const pathParts = sanitizeNestedPath(raw.path);
	const steps = Array.isArray(raw.steps)
		? raw.steps.map((step) => sanitizeStep(step, depth + 1)).filter((step): step is NestedStepSummary => Boolean(step)).slice(0, MAX_STEPS)
		: undefined;
	const totalTokens = sanitizeTokenUsage(raw.totalTokens);
	const totalCost = sanitizeCost(raw.totalCost);
	return {
		id: raw.id,
		parentRunId: raw.parentRunId,
		...(clampNumber(raw.parentStepIndex) !== undefined ? { parentStepIndex: clampNumber(raw.parentStepIndex) } : {}),
		...(stringValue(raw.parentAgent, 128) ? { parentAgent: stringValue(raw.parentAgent, 128) } : {}),
		depth: Math.min(Math.max(0, clampNumber(raw.depth) ?? 0), MAX_DEPTH),
		path: pathParts,
		state: sanitizeState(raw.state, "running"),
		...(stringValue(raw.asyncDir, 2048) ? { asyncDir: stringValue(raw.asyncDir, 2048) } : {}),
		...(clampNumber(raw.pid) !== undefined && clampNumber(raw.pid)! > 0 && Number.isInteger(clampNumber(raw.pid)) ? { pid: clampNumber(raw.pid) } : {}),
		...(stringValue(raw.sessionId, 256) ? { sessionId: stringValue(raw.sessionId, 256) } : {}),
		...(stringValue(raw.sessionFile, 2048) ? { sessionFile: stringValue(raw.sessionFile, 2048) } : {}),
		...(stringValue(raw.intercomTarget, 256) ? { intercomTarget: stringValue(raw.intercomTarget, 256) } : {}),
		...(stringValue(raw.ownerIntercomTarget, 256) ? { ownerIntercomTarget: stringValue(raw.ownerIntercomTarget, 256) } : {}),
		...(stringValue(raw.leafIntercomTarget, 256) ? { leafIntercomTarget: stringValue(raw.leafIntercomTarget, 256) } : {}),
		...(raw.ownerState === "live" || raw.ownerState === "gone" || raw.ownerState === "unknown" ? { ownerState: raw.ownerState } : {}),
		...(stringValue(raw.controlInbox, 2048) ? { controlInbox: stringValue(raw.controlInbox, 2048) } : {}),
		...(stringValue(raw.capabilityToken, 128) ? { capabilityToken: stringValue(raw.capabilityToken, 128) } : {}),
		...(raw.mode === "single" || raw.mode === "parallel" || raw.mode === "chain" ? { mode: raw.mode } : {}),
		...(stringValue(raw.agent, 128) ? { agent: stringValue(raw.agent, 128) } : {}),
		...(Array.isArray(raw.agents) ? { agents: raw.agents.map((agent) => stringValue(agent, 128)).filter((agent): agent is string => Boolean(agent)).slice(0, MAX_STEPS) } : {}),
		...(clampNumber(raw.currentStep) !== undefined ? { currentStep: clampNumber(raw.currentStep) } : {}),
		...(clampNumber(raw.chainStepCount) !== undefined ? { chainStepCount: clampNumber(raw.chainStepCount) } : {}),
		...(raw.activityState === "active_long_running" || raw.activityState === "needs_attention" ? { activityState: raw.activityState } : {}),
		...(clampNumber(raw.lastActivityAt) !== undefined ? { lastActivityAt: clampNumber(raw.lastActivityAt) } : {}),
		...(stringValue(raw.currentTool, 128) ? { currentTool: stringValue(raw.currentTool, 128) } : {}),
		...(clampNumber(raw.currentToolStartedAt) !== undefined ? { currentToolStartedAt: clampNumber(raw.currentToolStartedAt) } : {}),
		...(stringValue(raw.currentPath, 2048) ? { currentPath: stringValue(raw.currentPath, 2048) } : {}),
		...(clampNumber(raw.turnCount) !== undefined ? { turnCount: clampNumber(raw.turnCount) } : {}),
		...(clampNumber(raw.toolCount) !== undefined ? { toolCount: clampNumber(raw.toolCount) } : {}),
		...(totalTokens ? { totalTokens } : {}),
		...(totalCost ? { totalCost } : {}),
		...(clampNumber(raw.startedAt) !== undefined ? { startedAt: clampNumber(raw.startedAt) } : {}),
		...(clampNumber(raw.endedAt) !== undefined ? { endedAt: clampNumber(raw.endedAt) } : {}),
		...(clampNumber(raw.lastUpdate) !== undefined ? { lastUpdate: clampNumber(raw.lastUpdate) } : {}),
		...(clampNumber(raw.timeoutMs) !== undefined ? { timeoutMs: clampNumber(raw.timeoutMs) } : {}),
		...(clampNumber(raw.deadlineAt) !== undefined ? { deadlineAt: clampNumber(raw.deadlineAt) } : {}),
		...(raw.timedOut === true ? { timedOut: true } : {}),
		...(sanitizeTurnBudget(raw.turnBudget) ? { turnBudget: sanitizeTurnBudget(raw.turnBudget) } : {}),
		...(raw.turnBudgetExceeded === true ? { turnBudgetExceeded: true } : {}),
		...(raw.wrapUpRequested === true ? { wrapUpRequested: true } : {}),
		...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
		...(steps && steps.length > 0 ? { steps } : {}),
		...(depth < MAX_DEPTH && Array.isArray(raw.children) ? { children: raw.children.map((child) => sanitizeSummary(child, depth + 1)).filter((child): child is NestedRunSummary => Boolean(child)).slice(0, MAX_CHILDREN) } : {}),
	};
}
