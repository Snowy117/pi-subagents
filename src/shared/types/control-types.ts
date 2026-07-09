/**
 * Control / activity / completion-batching types.
 */

import type { NestedRunAddress } from "./nested-types.ts";

export type ActivityState = "active_long_running" | "needs_attention";
export type ControlEventType = "active_long_running" | "needs_attention";
export type ControlNotificationChannel = "event" | "async" | "intercom";

export interface ControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
	activeNoticeAfterMs?: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention?: number;
	notifyOn?: ControlEventType[];
	notifyChannels?: ControlNotificationChannel[];
}

export interface ResolvedControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	activeNoticeAfterMs: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention: number;
	notifyOn: ControlEventType[];
	notifyChannels: ControlNotificationChannel[];
}

/**
 * Smart completion batching for async-completion notifications. Successful
 * sibling completions are held briefly so they arrive as one grouped message;
 * failure and attention signals bypass grouping and always fire immediately.
 */
export interface CompletionBatchConfig {
	enabled?: boolean;
	/** Idle window after each arrival; resets on every new item. */
	debounceMs?: number;
	/** Hard cap measured from the first item in a group. */
	maxWaitMs?: number;
	/** Shorter idle window for straggler groups. */
	stragglerDebounceMs?: number;
	/** Shorter hard cap for straggler groups. */
	stragglerMaxWaitMs?: number;
	/** Arrivals within this window after an emit join a straggler group. */
	stragglerWindowMs?: number;
}

export interface WaitToolConfigObject {
	enabled?: boolean;
}

export type WaitToolConfig = boolean | WaitToolConfigObject;

export interface ControlEvent {
	type: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	ts: number;
	agent: string;
	index?: number;
	runId: string;
	nestedRunId?: string;
	nestingPath?: NestedRunAddress["path"];
	message: string;
	reason?: "idle" | "completion_guard" | "active_long_running" | "tool_failures" | "time_threshold" | "turn_threshold" | "token_threshold";
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
}
