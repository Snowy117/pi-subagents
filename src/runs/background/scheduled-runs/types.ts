import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TEMP_ROOT_DIR, type Details, type ExtensionConfig } from "../../../shared/types.ts";
import type { SubagentParamsLike } from "../../foreground/subagent-executor.ts";

export const SCHEDULED_RUNS_DIR = path.join(TEMP_ROOT_DIR, "scheduled-subagent-runs");
export const SCHEDULED_RUN_ACTIONS = ["schedule", "schedule-list", "schedule-status", "schedule-cancel"] as const;

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const DEFAULT_MAX_LATENESS_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_PENDING = 20;

export type ScheduledRunAction = typeof SCHEDULED_RUN_ACTIONS[number];
export type ScheduledRunState = "scheduled" | "running" | "fired" | "canceled" | "missed" | "failed";

export type ScheduledRunJob = {
	id: string;
	name: string;
	schedule: string;
	runAt: number;
	state: ScheduledRunState;
	createdAt: number;
	updatedAt: number;
	cwd: string;
	sessionId: string;
	params: SubagentParamsLike;
	lastRunId?: string;
	lastAsyncDir?: string;
	lastError?: string;
	firedAt?: number;
	canceledAt?: number;
};

export type ScheduledRunStoreData = {
	version: 1;
	cwd: string;
	sessionId: string;
	jobs: ScheduledRunJob[];
};

export type ScheduledRunTimers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;

export type ScheduledRunManagerDeps = {
	config: ExtensionConfig;
	launch(params: SubagentParamsLike, ctx: ExtensionContext, signal: AbortSignal): Promise<AgentToolResult<Details>>;
	storeRoot?: string;
	now?: () => number;
	randomId?: () => string;
	timers?: ScheduledRunTimers;
};
