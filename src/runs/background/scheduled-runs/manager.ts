import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration, shortenPath } from "../../../shared/formatters.ts";
import { resolveCurrentSessionId } from "../../../shared/session-identity.ts";
import type { Details } from "../../../shared/types.ts";
import type { SubagentParamsLike } from "../../foreground/subagent-executor.ts";
import {
	describeScheduledTarget,
	jobMode,
	parseScheduledRunTime,
	resolveJobById,
	resolveMaxLatenessMs,
	resolveMaxPending,
	sanitizeScheduledParams,
	scheduledRunsEnabled,
	terminalState,
	textResult,
} from "./schedule-helpers.ts";
import { ScheduledRunStore, scheduledRunStorePath } from "./store.ts";
import { MAX_TIMER_DELAY_MS, SCHEDULED_RUNS_DIR, type ScheduledRunJob, type ScheduledRunManagerDeps, type ScheduledRunTimers } from "./types.ts";

export class ScheduledRunManager {
	private store: ScheduledRunStore | undefined;
	private ctx: ExtensionContext | undefined;
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly storeRoot: string;
	private readonly now: () => number;
	private readonly randomId: () => string;
	private readonly timersApi: ScheduledRunTimers;
	private readonly deps: ScheduledRunManagerDeps;

	constructor(deps: ScheduledRunManagerDeps) {
		this.deps = deps;
		this.storeRoot = deps.storeRoot ?? SCHEDULED_RUNS_DIR;
		this.now = deps.now ?? Date.now;
		this.randomId = deps.randomId ?? (() => randomUUID().slice(0, 8));
		this.timersApi = deps.timers ?? globalThis;
	}

	bindSession(ctx: ExtensionContext): void {
		this.stopTimers();
		this.ctx = ctx;
		if (!scheduledRunsEnabled(this.deps.config)) {
			this.store = undefined;
			return;
		}
		const sessionId = resolveCurrentSessionId(ctx.sessionManager);
		this.store = new ScheduledRunStore(scheduledRunStorePath(ctx.cwd, sessionId, this.storeRoot), ctx.cwd, sessionId);
		this.rearmScheduledJobs();
	}

	stop(): void {
		this.stopTimers();
		this.store = undefined;
		this.ctx = undefined;
	}

	async handleToolCall(params: SubagentParamsLike, ctx: ExtensionContext): Promise<AgentToolResult<Details>> {
		this.ctx = ctx;
		try {
			if (!scheduledRunsEnabled(this.deps.config)) {
				return textResult("Scheduled subagent runs are disabled. Set { \"scheduledRuns\": { \"enabled\": true } } in ~/.pi/agent/extensions/subagent/config.json, then reload Pi. Schedule only explicit delayed runs the user asked for.", true);
			}
			if (!this.store) this.bindSession(ctx);
			if (!this.store) return textResult("Scheduled subagent store is unavailable for this session.", true);
			switch (params.action) {
				case "schedule": return this.createJob(params, ctx);
				case "schedule-list": return this.listJobs();
				case "schedule-status": return this.statusJob(params);
				case "schedule-cancel": return this.cancelJob(params);
				default: return textResult(`Unknown scheduled-run action: ${params.action}`, true);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return textResult(message, true);
		}
	}

	private createJob(params: SubagentParamsLike, ctx: ExtensionContext): AgentToolResult<Details> {
		const store = this.requireStore();
		const sanitized = sanitizeScheduledParams(params);
		if (sanitized.error) return textResult(sanitized.error, true);
		const scheduleInput = params.schedule!.trim();
		const runAt = parseScheduledRunTime(scheduleInput, this.now());
		const pendingCount = store.list().filter((job) => job.state === "scheduled" || job.state === "running").length;
		const maxPending = resolveMaxPending(this.deps.config);
		if (pendingCount >= maxPending) return textResult(`Scheduled subagent limit reached (${pendingCount}/${maxPending} pending or running). Cancel an existing scheduled run before adding another.`, true);
		const id = this.randomId();
		const sessionId = resolveCurrentSessionId(ctx.sessionManager);
		const scheduleName = params.scheduleName?.trim();
		const executionParams = sanitized.params!;
		const now = this.now();
		const job: ScheduledRunJob = {
			id,
			name: scheduleName || describeScheduledTarget(executionParams),
			schedule: scheduleInput,
			runAt,
			state: "scheduled",
			createdAt: now,
			updatedAt: now,
			cwd: ctx.cwd,
			sessionId,
			params: executionParams,
		};
		store.mutate((data) => {
			data.jobs.push(job);
		});
		this.arm(job);
		return textResult([
			`Scheduled subagent run ${job.id}.`,
			`Name: ${job.name}`,
			`When: ${new Date(job.runAt).toISOString()}`,
			`Mode: ${jobMode(executionParams)}`,
			`Context: fresh (scheduled runs never fork parent-session context)`,
			`Status: subagent({ action: "schedule-status", id: "${job.id}" })`,
			`Cancel before it fires: subagent({ action: "schedule-cancel", id: "${job.id}" })`,
		].join("\n"));
	}

	private listJobs(): AgentToolResult<Details> {
		const jobs = this.requireStore().list().sort((left, right) => left.runAt - right.runAt);
		if (jobs.length === 0) return textResult("No scheduled subagent runs for this session.");
		const lines = [`Scheduled subagent runs: ${jobs.length}`, ""];
		for (const job of jobs) {
			const parts = [job.id, job.state, new Date(job.runAt).toISOString(), job.name];
			if (job.lastRunId) parts.push(`run ${job.lastRunId}`);
			if (job.lastError) parts.push(`error: ${job.lastError}`);
			lines.push(`- ${parts.join(" | ")}`);
		}
		return textResult(lines.join("\n"));
	}

	private statusJob(params: SubagentParamsLike): AgentToolResult<Details> {
		const requestedId = params.id ?? params.runId;
		if (!requestedId) return textResult("action='schedule-status' requires id.", true);
		const job = resolveJobById(this.requireStore().list(), requestedId);
		const lines = [
			`Scheduled run: ${job.id}`,
			`Name: ${job.name}`,
			`State: ${job.state}`,
			`Schedule: ${job.schedule}`,
			`Run at: ${new Date(job.runAt).toISOString()}`,
			`Mode: ${jobMode(job.params)}`,
			`CWD: ${shortenPath(job.cwd)}`,
			`Created: ${new Date(job.createdAt).toISOString()}`,
			`Updated: ${new Date(job.updatedAt).toISOString()}`,
			job.lastRunId ? `Launched async run: ${job.lastRunId}` : undefined,
			job.lastAsyncDir ? `Async dir: ${job.lastAsyncDir}` : undefined,
			job.lastError ? `Error: ${job.lastError}` : undefined,
			job.state === "scheduled" ? `Cancel: subagent({ action: "schedule-cancel", id: "${job.id}" })` : undefined,
			job.lastRunId ? `Async status: subagent({ action: "status", id: "${job.lastRunId}" })` : undefined,
		].filter((line): line is string => Boolean(line));
		return textResult(lines.join("\n"));
	}

	private cancelJob(params: SubagentParamsLike): AgentToolResult<Details> {
		const requestedId = params.id ?? params.runId;
		if (!requestedId) return textResult("action='schedule-cancel' requires id.", true);
		const store = this.requireStore();
		const job = resolveJobById(store.list(), requestedId);
		if (job.state === "running") return textResult(`Scheduled run ${job.id} already launched async run ${job.lastRunId ?? "unknown"}; interrupt that async run instead.`, true);
		if (terminalState(job.state)) return textResult(`Scheduled run ${job.id} is already ${job.state}.`, true);
		const now = this.now();
		this.clearTimer(job.id);
		store.mutate((data) => {
			const stored = data.jobs.find((candidate) => candidate.id === job.id);
			if (!stored) return;
			stored.state = "canceled";
			stored.canceledAt = now;
			stored.updatedAt = now;
		});
		return textResult(`Canceled scheduled subagent run ${job.id}.`);
	}

	private rearmScheduledJobs(): void {
		const store = this.requireStore();
		const now = this.now();
		const maxLatenessMs = resolveMaxLatenessMs(this.deps.config);
		const dueToMiss = store.list().filter((job) => job.state === "scheduled" && job.runAt + maxLatenessMs < now);
		if (dueToMiss.length > 0) {
			store.mutate((data) => {
				for (const missed of dueToMiss) {
					const job = data.jobs.find((candidate) => candidate.id === missed.id);
					if (!job || job.state !== "scheduled") continue;
					job.state = "missed";
					job.updatedAt = now;
					job.lastError = `Missed scheduled time by more than ${formatDuration(maxLatenessMs)} while Pi was not available.`;
				}
			});
		}
		for (const job of store.list()) {
			if (job.state === "scheduled") this.arm(job);
		}
	}

	private arm(job: ScheduledRunJob): void {
		this.clearTimer(job.id);
		const delayMs = Math.max(0, job.runAt - this.now());
		const timer = this.timersApi.setTimeout(() => {
			void this.fire(job.id);
		}, Math.min(delayMs, MAX_TIMER_DELAY_MS));
		timer.unref?.();
		this.timers.set(job.id, timer);
	}

	private async fire(jobId: string): Promise<void> {
		this.clearTimer(jobId);
		const store = this.store;
		const ctx = this.ctx;
		if (!store || !ctx) return;
		let job = store.get(jobId);
		if (!job || job.state !== "scheduled") return;
		const now = this.now();
		// A timer capped at MAX_TIMER_DELAY_MS may fire before runAt for far-future schedules; re-arm and wait.
		if (now < job.runAt) {
			this.arm(job);
			return;
		}
		const maxLatenessMs = resolveMaxLatenessMs(this.deps.config);
		if (job.runAt + maxLatenessMs < now) {
			store.mutate((data) => {
				const stored = data.jobs.find((candidate) => candidate.id === jobId);
				if (!stored || stored.state !== "scheduled") return;
				stored.state = "missed";
				stored.updatedAt = now;
				stored.lastError = `Missed scheduled time by more than ${formatDuration(maxLatenessMs)}.`;
			});
			return;
		}
		store.mutate((data) => {
			const stored = data.jobs.find((candidate) => candidate.id === jobId);
			if (!stored || stored.state !== "scheduled") return;
			stored.state = "running";
			stored.firedAt = now;
			stored.updatedAt = now;
		});
		job = store.get(jobId);
		if (!job || job.state !== "running") return;
		const controller = new AbortController();
		try {
			const result = await this.deps.launch(job.params, ctx, controller.signal);
			const launchRunId = result.details?.asyncId ?? result.details?.runId;
			store.mutate((data) => {
				const stored = data.jobs.find((candidate) => candidate.id === jobId);
				if (!stored) return;
				stored.updatedAt = this.now();
				if (result.isError || !launchRunId) {
					stored.state = "failed";
					stored.lastError = result.content.find((item) => item.type === "text")?.text ?? "Scheduled subagent launch failed.";
					return;
				}
				stored.state = "fired";
				stored.lastRunId = launchRunId;
				stored.lastAsyncDir = result.details?.asyncDir;
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			store.mutate((data) => {
				const stored = data.jobs.find((candidate) => candidate.id === jobId);
				if (!stored) return;
				stored.state = "failed";
				stored.lastError = message;
				stored.updatedAt = this.now();
			});
		}
	}

	private requireStore(): ScheduledRunStore {
		if (!this.store) throw new Error("Scheduled subagent store is not bound to a session.");
		return this.store;
	}

	private clearTimer(jobId: string): void {
		const timer = this.timers.get(jobId);
		if (!timer) return;
		this.timersApi.clearTimeout(timer);
		this.timers.delete(jobId);
	}

	private stopTimers(): void {
		for (const timer of this.timers.values()) this.timersApi.clearTimeout(timer);
		this.timers.clear();
	}
}

export function createScheduledRunManager(deps: ScheduledRunManagerDeps): ScheduledRunManager {
	return new ScheduledRunManager(deps);
}
