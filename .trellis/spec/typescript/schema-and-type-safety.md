# Schema & Type Safety

> Runtime schemas and shared TypeScript contracts for `pi-subagents`.

## Overview

The project has two type-safety layers:

1. **Runtime validation** with TypeBox for data crossing a trust boundary, especially tool parameters and RPC payloads.
2. **Compile-time types** for internal state, normalized lifecycle data, and cross-module contracts.

A TypeScript interface alone is not validation. External tool/RPC input must have a runtime schema or explicit parser.

## Current `subagent` schema

The public API is one tool. Management, integrated wait, scheduling, and execution share one top-level object:

```ts
const SubagentParamsSchema = Type.Object({
  // Management and integrated wait
  action: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  index: Type.Optional(Type.Integer({ minimum: 0 })),
  view: Type.Optional(Type.String({ enum: ["fleet", "transcript"] })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  message: Type.Optional(Type.String()),
  config: Type.Optional(Type.Unsafe({
    anyOf: [{ type: "object" }, { type: "string" }],
  })),
  all: Type.Optional(Type.Boolean()),

  // Scheduling
  schedule: Type.Optional(Type.String()),
  scheduleName: Type.Optional(Type.String()),

  // Execution
  tasks: Type.Optional(Type.Array(TaskItem)),
  concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
  worktree: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.String({ enum: ["fresh", "fork"] })),
  async: Type.Optional(Type.Boolean()),
  artifacts: Type.Optional(Type.Boolean()),
  includeProgress: Type.Optional(Type.Boolean()),
});
```

`TaskItem` is the only public execution shape:

```ts
const TaskItem = Type.Object({
  agent: Type.String(),
  task: Type.String(),
  count: Type.Optional(Type.Integer({ minimum: 1 })),
  progress: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String()),
  skill: Type.Optional(SkillOverride),
});
```

Do not restore public top-level `agent`/`task`, chain, runtime/cwd/session/output/reads/control overrides, or standalone wait parameters.

## Integrated wait contract

Waiting uses the normal tool schema:

```ts
subagent({ action: "wait" })
subagent({ action: "wait", all: true })
subagent({ action: "wait", id: "exact-or-unique-prefix" })
```

Schema/type requirements:

- `wait` is part of `SUBAGENT_ACTIONS`;
- `all?: boolean` is a direct top-level parameter;
- `id` is shared by wait/status/control targeting;
- no `timeoutMs` orchestration field exists;
- no `WaitParamsSchema`, standalone `wait` tool type, wait enablement config, or wait environment switch exists;
- root and child-safe executors receive authorized lifecycle roots through injected internal dependencies, not user input.

The runtime action dispatcher handles `wait` before generic agent-management actions. Internal wait results remain normal `AgentToolResult<Details>` values.

## Canonical execution mode

Mode is determined once after `count` expansion:

```ts
type SubagentRunMode = "single" | "parallel";

function modeForConcreteInvocationCount(count: number): SubagentRunMode {
  return count === 1 ? "single" : "parallel";
}
```

Contracts:

- one task with omitted `count` or `count: 1` is `single`;
- one task with `count > 1` is `parallel`;
- multiple concrete tasks are `parallel`;
- prepared execution stores the canonical mode and one generated run ID;
- launch metadata, nested metadata, persisted status, tracker events, call labels, and final `Details.mode` reuse those values;
- downstream modules must not infer mode again from `tasks.length > 0`.

This replaces the stale rule that a one-element task array was “parallel with n=1.”

## Detached return policy

All public execution launches through the detached runner. `async` is a return-policy field:

- `async: true` returns the launch receipt;
- false/default claims sync ownership, launches the same detached runner, waits for its exact generated ID, and reconstructs the full result.

Do not add a separate public foreground/synchronous input union. Internal compatibility or resume helpers may retain narrower legacy types only when they remain reachable for non-public behavior.

## Completion types

The result file is an external JSON boundary and must be modeled faithfully. The normalized completion contract includes available:

- run ID, session ID, mode, state, summary, error, timestamps, duration, cwd, and async directory;
- child agent, task, output, error, status, exit code, usage, session file, model, model attempts, cost, artifacts, truncation, transcript, and structured output;
- run output maps, workflow graph, aggregate tokens/cost, budgets, and lifecycle metadata.

The result watcher validates session ownership and normalizes before passing data to the completion broker, intercom, event bus, tracker, or synchronous converter. Do not maintain several weaker competing result shapes.

`Usage` belongs to each child result when the runner knows it. Legacy files without per-child usage use an explicit zero usage object; never distribute aggregate tokens or cost across children heuristically.

## Completion broker contracts

The session-scoped broker owns two typed maps:

```ts
interface SyncOwnership {
  runId: string;
  sessionId: string;
  mode: SubagentRunMode;
  tasks: ConcreteTaskDescriptor[];
  claimedAt: number;
}

interface CachedCompletion {
  completion: NormalizedAsyncCompletion;
  cachedAt: number;
}
```

The exact interfaces may remain co-located with the broker, but the contracts are:

- claim is keyed by exact run ID and owning session;
- completion cache and ownership have bounded, TTL-pruned lifetimes;
- cache-before-publish allows fast-completion recovery;
- wait is exact-run and subscribes before rechecking;
- session reset drops foreign-session state;
- dispose resolves/cleans internal waiters without affecting detached processes;
- general `action:"wait"` is an observer and creates no sync ownership.

## TypeBox conventions

`src/extension/schemas.ts` and `src/extension/schemas/*.ts` define public tool schemas.

### Required patterns

- Use `Type.Optional(...)` for optional properties.
- Put descriptions on direct children of the top-level parameter object. The schema sanitizer removes nested descriptions.
- Use `Type.Unsafe(...)` for unions TypeBox builders do not express cleanly.
- Reuse shared scalar schemas such as skill overrides.
- Keep runtime schema and exported TypeScript parameter type aligned.
- Prefer strict finite unions or explicit runtime validation where the external vocabulary is closed.

Example scalar union:

```ts
const SkillOverride = Type.Unsafe({
  anyOf: [
    { type: "array", items: { type: "string" } },
    { type: "boolean" },
    { type: "string" },
  ],
});
```

## TypeScript conventions

- Use `interface` for object shapes and `type` for unions/aliases.
- Use string-literal unions, not `enum`.
- Use `unknown`, not `any`, for opaque external payloads.
- Co-locate producer-owned types with their module; move them to `src/shared/types.ts` only when genuinely cross-cutting.
- Use `import type` for type-only imports.
- Keep relative ESM imports suffixed with `.ts`.

Examples:

```ts
export type WorkflowNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "detached";

export interface MaxOutputConfig {
  bytes?: number;
  lines?: number;
}
```

## Package-owned keybinding parsing

`subagents.openPicker` is intentionally not part of Pi's runtime action definition table. Its package parser is another trust boundary:

- accepted JSON value: one valid key string, an array containing only valid key strings, or `[]`;
- invalid member, invalid shape, or malformed file: no binding;
- valid duplicates are removed;
- values are validated against the supported Pi TUI key grammar before casting to `KeyId`;
- raw matching uses `matchesKey` only after validation.

Do not type-cast an arbitrary JSON string to `KeyId` without runtime validation.

The live host actions `app.exit` and `tui.input.submit` are different: they must resolve through the global keybinding manager's `matches()` method so user remaps, removals, migrations, and runtime patches remain authoritative.

## Common mistakes

- Adding only a TypeScript field for external input without updating its TypeBox schema.
- Restoring a separate wait schema/tool instead of using `action:"wait"`.
- Recomputing single/parallel mode from raw task-array presence.
- Returning only a short async summary from a synchronous launch-plus-wait call.
- Treating aggregate run usage as per-child usage.
- Using `any` for result-file or RPC payloads.
- Adding nested schema descriptions and expecting them to survive sanitization.
- Accepting partially valid picker key arrays instead of rejecting the invalid binding.

## Validation checklist

- [ ] Public schema accepts integrated wait and contains no wait timeout.
- [ ] One/count:1 execution is typed and tested as single.
- [ ] Count>1 and multiple tasks are typed and tested as parallel.
- [ ] Rich result-file fields survive normalization and sync conversion.
- [ ] Missing legacy child usage becomes explicit zero usage.
- [ ] Broker ownership/cache are session-scoped, bounded, and disposable.
- [ ] External keybinding values are runtime-validated before `KeyId` use.
- [ ] TypeScript diagnostics and focused schema/result tests are clean.

**Language**: All documentation is written in English.
