import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_MAX_LATENESS_MS,
	DEFAULT_MAX_PENDING,
	SCHEDULED_RUN_ACTIONS,
	type ScheduledRunAction,
	type ScheduledRunJob,
	type ScheduledRunState,
} from "./types.ts";
import type { Details, ExtensionConfig } from "../../../shared/types.ts";
import type { SubagentParamsLike } from "../../foreground/subagent-executor.ts";

export function isScheduledRunAction(action: unknown): action is ScheduledRunAction {
	return typeof action === "string" && (SCHEDULED_RUN_ACTIONS as readonly string[]).includes(action);
}

export function scheduledRunsEnabled(config: ExtensionConfig): boolean {
	return config.scheduledRuns?.enabled === true;
}

export function parseScheduledRunTime(schedule: string, now = Date.now()): number {
	const trimmed = schedule.trim();
	const relative = trimmed.match(/^\+(\d+)(s|m|h|d)$/);
	if (relative) {
		const amount = Number(relative[1]);
		if (!Number.isSafeInteger(amount) || amount < 1) throw new Error(`Invalid schedule "${schedule}". Relative schedules must be positive, such as "+10m".`);
		const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "s" | "m" | "h" | "d"];
		const runAt = now + amount * unitMs;
		if (!Number.isSafeInteger(runAt) || Number.isNaN(new Date(runAt).getTime())) throw new Error(`Invalid schedule "${schedule}". Relative delay is too large.`);
		return runAt;
	}
	if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
		const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
		if (!iso) throw new Error(`Invalid schedule "${schedule}". Absolute ISO timestamps must include a timezone, such as "2030-01-01T09:00:00Z".`);
		const year = Number(iso[1]);
		const month = Number(iso[2]);
		const day = Number(iso[3]);
		const hour = Number(iso[4]);
		const minute = Number(iso[5]);
		const second = iso[6] === undefined ? 0 : Number(iso[6]);
		const offset = iso[7]!;
		const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
		const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
		const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
		if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
			throw new Error(`Invalid schedule "${schedule}". Use a valid future ISO timestamp.`);
		}
		const parsed = new Date(trimmed).getTime();
		if (!Number.isNaN(parsed)) {
			if (parsed <= now) throw new Error(`Scheduled time ${new Date(parsed).toISOString()} is in the past.`);
			return parsed;
		}
	}
	throw new Error(`Invalid schedule "${schedule}". Use a one-shot relative delay like "+10m" or a future ISO timestamp with timezone.`);
}

export function resolveMaxLatenessMs(config: ExtensionConfig): number {
	const value = config.scheduledRuns?.maxLatenessMs;
	return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_LATENESS_MS;
}

export function resolveMaxPending(config: ExtensionConfig): number {
	const value = config.scheduledRuns?.maxPending;
	return Number.isInteger(value) && value >= 1 ? value : DEFAULT_MAX_PENDING;
}

export function terminalState(state: ScheduledRunState): boolean {
	return state === "fired" || state === "canceled" || state === "missed" || state === "failed";
}

export function jobMode(params: SubagentParamsLike): Details["mode"] {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	return "single";
}

export function describeScheduledTarget(params: SubagentParamsLike): string {
	if ((params.chain?.length ?? 0) > 0) return `chain (${params.chain!.length})`;
	if ((params.tasks?.length ?? 0) > 0) return `parallel (${params.tasks!.length})`;
	return params.agent ? `agent ${params.agent}` : "subagent run";
}

export function textResult(text: string, isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

export function resolveJobById(jobs: ScheduledRunJob[], requestedId: string): ScheduledRunJob {
	const exact = jobs.find((job) => job.id === requestedId);
	if (exact) return exact;
	const matches = jobs.filter((job) => job.id.startsWith(requestedId));
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) throw new Error(`Ambiguous scheduled run id prefix '${requestedId}' matched: ${matches.map((job) => job.id).join(", ")}. Provide a longer id.`);
	throw new Error(`Scheduled run '${requestedId}' not found.`);
}

export function sanitizeScheduledParams(params: SubagentParamsLike): { params?: SubagentParamsLike; error?: string } {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
		return { error: "action='schedule' requires exactly one execution mode: agent, tasks, or chain." };
	}
	if (!params.schedule?.trim()) return { error: "action='schedule' requires schedule, such as '+10m' or a future ISO timestamp." };
	if (params.context === "fork") return { error: "Scheduled subagent runs require fresh context. Forked parent-session context is not safe at fire time." };
	if (params.async === false) return { error: "Scheduled subagent runs are always async; omit async or set async: true." };
	if (params.clarify === true) return { error: "Scheduled subagent runs cannot open clarify UI; omit clarify or set clarify: false." };

	const {
		action: _action,
		id: _id,
		runId: _runId,
		dir: _dir,
		index: _index,
		message: _message,
		chainName: _chainName,
		config: _config,
		schedule: _schedule,
		scheduleName: _scheduleName,
		...executionParams
	} = params;
	return { params: { ...executionParams, async: true, clarify: false, context: "fresh" } };
}
