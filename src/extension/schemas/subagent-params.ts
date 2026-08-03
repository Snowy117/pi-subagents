import { Type } from "typebox";
import { TaskItem } from "./blocks.ts";
import { keepTopLevelParameterDescriptions } from "./pruning.ts";

const SubagentParamsSchema = Type.Object({
	// Management/control
	action: Type.Optional(Type.String({
		description: "Management/control action. Use action='wait' with optional id or all to wait for detached subagent runs."
	})),
	all: Type.Optional(Type.Boolean({ description: "For action='wait', wait for every run captured at call start instead of the first completion." })),
	id: Type.Optional(Type.String({
		description: "Run id or unique prefix for action='wait', action='status', action='interrupt', action='resume', or action='steer'. Exact ids win over prefixes."
	})),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child index for actions that target a specific child or transcript." })),
	view: Type.Optional(Type.String({
		enum: ["fleet", "transcript"],
		description: "Optional status view. Use view='fleet' for a read-only active foreground/async fleet surface, or view='transcript' with id (and optional index) to tail a run transcript.",
	})),
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum transcript lines for action='status', view='transcript'. Defaults to 80." })),
	message: Type.Optional(Type.String({ description: "Follow-up message for action='resume' or non-terminal guidance for action='steer'. Use index to choose a child from multi-child runs." })),
	config: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "object", additionalProperties: true },
			{ type: "string" },
		],
		description: "Agent configuration for supported management actions. Object or JSON string."
	})),
	// Scheduling
	schedule: Type.Optional(Type.String({ description: "Explicit one-shot schedule for action='schedule'. Only honored when scheduledRuns.enabled is true. Use '+10m' or a future ISO timestamp with timezone; scheduled runs always launch async with fresh context." })),
	scheduleName: Type.Optional(Type.String({ description: "Optional display name for action='schedule'." })),
	// Execution
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Execution tasks: [{agent, task, count?, progress?, model?, skill?}]. Exactly one count-expanded invocation is single; more than one is parallel." })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Max concurrent tasks. Defaults to config.parallel.concurrency or 4." })),
	worktree: Type.Optional(Type.Boolean({
		description: "Create isolated git worktrees for parallel tasks; requires clean git state."
	})),
	context: Type.Optional(Type.String({
		enum: ["fresh", "fork"],
		description: "'fresh' or 'fork' to branch from parent session. Explicit context overrides every child in the invocation. If omitted, each requested agent uses its own defaultContext; agents without defaultContext: 'fork' run fresh.",
	})),
	async: Type.Optional(Type.Boolean({ description: "Return immediately after detached launch. When false/default, the same detached runner is launched and this call waits for its full result." })),
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
});

export const SubagentParams = keepTopLevelParameterDescriptions(SubagentParamsSchema);
