import { Type } from "typebox";
import {
	AcceptanceOverride,
	ChainItem,
	ControlOverrides,
	OutputModeOverride,
	SkillOverride,
	TaskItem,
	ToolBudgetOverride,
	TurnBudgetOverride,
} from "./blocks.ts";
import { keepTopLevelParameterDescriptions } from "./pruning.ts";

const SubagentParamsSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (SINGLE mode) or target for management get/update/delete" })),
	task: Type.Optional(Type.String({ description: "Task (SINGLE mode, optional for self-contained agents)" })),
	// Management action (when present, tool operates in management mode)
	action: Type.Optional(Type.String({
		description: "Management/control action only. Must be omitted for execution mode (single, parallel, or chain)."
	})),
	id: Type.Optional(Type.String({
		description: "Run id or prefix for action='status', action='interrupt', action='resume', action='steer', or action='append-step'."
	})),
	runId: Type.Optional(Type.String({
		description: "Target run ID for action='interrupt', action='resume', action='steer', or action='append-step'. Defaults to the most recently active controllable run for interrupt. Prefer id for new calls."
	})),
	dir: Type.Optional(Type.String({
		description: "Async run directory for action='status', action='resume', or action='steer'."
	})),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child index for actions that target a specific child or transcript." })),
	view: Type.Optional(Type.String({
		enum: ["fleet", "transcript"],
		description: "Optional status view. Use view='fleet' for a read-only active foreground/async fleet surface, or view='transcript' with id/dir (and optional index) to tail a run transcript.",
	})),
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum transcript lines for action='status', view='transcript'. Defaults to 80." })),
	message: Type.Optional(Type.String({ description: "Follow-up message for action='resume' or non-terminal guidance for action='steer'. Use index to choose a child from multi-child runs." })),
	schedule: Type.Optional(Type.String({ description: "Explicit one-shot schedule for action='schedule'. Only honored when scheduledRuns.enabled is true. Use '+10m' or a future ISO timestamp with timezone; scheduled runs always launch async with fresh context." })),
	scheduleName: Type.Optional(Type.String({ description: "Optional display name for action='schedule'." })),
	// Chain identifier for management (can't reuse 'chain' — that's the execution array)
	chainName: Type.Optional(Type.String({
		description: "Chain name for get/update/delete management actions"
	})),
	// Agent/chain configuration for create/update (nested to avoid conflicts with execution fields)
	config: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "object", additionalProperties: true },
			{ type: "string" },
		],
		description: "Agent/chain config for create/update. Object or JSON string; presence of steps creates a chain."
	})),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "PARALLEL mode: [{agent, task, count?, output?, outputMode?, reads?, progress?}, ...]" })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Top-level PARALLEL mode only: max concurrent tasks. Defaults to config.parallel.concurrency or 4." })),
	worktree: Type.Optional(Type.Boolean({
		description: "Create isolated git worktrees for parallel tasks; requires clean git state."
	})),
	chain: Type.Optional(Type.Array(ChainItem, { description: "CHAIN mode: sequential steps; each result becomes {previous}. append-step takes one tail step and may use {chain_dir}/{outputs.name}." })),
	context: Type.Optional(Type.String({
		enum: ["fresh", "fork"],
		description: "'fresh' or 'fork' to branch from parent session. Explicit context overrides every child in the invocation. If omitted, each requested agent uses its own defaultContext; agents without defaultContext: 'fork' run fresh.",
	})),
	chainDir: Type.Optional(Type.String({ description: "Persistent chain artifact directory; defaults to user-scoped temp storage." })),
	async: Type.Optional(Type.Boolean({ description: "Run in background (default: false, or per config)" })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Optional run-level timeout in ms for foreground and async/background runs. Alias of maxRuntimeMs." })),
	maxRuntimeMs: Type.Optional(Type.Integer({ minimum: 1, description: "Alias of timeoutMs for optional run-level timeout in foreground and async/background runs." })),
	turnBudget: Type.Optional(TurnBudgetOverride),
	toolBudget: Type.Optional(ToolBudgetOverride),
	agentScope: Type.Optional(Type.String({ description: "Agent discovery scope: 'user', 'project', or 'both' (default: 'both'; project wins on name collisions)" })),
	cwd: Type.Optional(Type.String()),
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
	share: Type.Optional(Type.Boolean({ description: "Upload session to GitHub Gist for sharing (default: false)" })),
	sessionDir: Type.Optional(
		Type.String({ description: "Directory to store session logs (default: temp; enables sessions even if share=false)" }),
	),
	// Clarification TUI
	clarify: Type.Optional(Type.Boolean({ description: "Show TUI to preview/edit before execution. Explicit clarify: true keeps the run foreground for the clarify UI; omitted clarify can still run in the background when async: true is set." })),
	control: Type.Optional(ControlOverrides),
	// Solo agent overrides
	output: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "string" },
			{ type: "boolean" },
		],
		description: "Output file for single agent (string), or false to disable. Relative paths resolve against cwd.",
	})),
	outputMode: Type.Optional(OutputModeOverride),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for single agent (e.g. 'anthropic/claude-sonnet-4')" })),
	acceptance: Type.Optional(AcceptanceOverride),
});

export const SubagentParams = keepTopLevelParameterDescriptions(SubagentParamsSchema);
