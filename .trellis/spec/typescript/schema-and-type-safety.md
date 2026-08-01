# Schema & Type Safety

> How this project defines, validates, and reuses types. The defining trait:
> **runtime schemas via TypeBox**, not just compile-time interfaces.

---

## Overview

Type safety in `pi-subagents` has two layers:

1. **Compile-time** — TypeScript interfaces/types (in `src/shared/types.ts`
   and co-located `.ts` files), checked via the TypeScript language server.
2. **Runtime** — [TypeBox](https://github.com/sinclairzx/typebox) schemas
   (`Type.*`) for any data crossing a trust boundary (tool params, RPC
   payloads, config).

Runtime validation matters because subagent tool parameters and JSON RPC
bridges come from external callers / child processes. A plain TS interface
gives no protection there.

---

## Subagent Dispatch Schema (16 params)

After the `08-01-simplify-subagent-params` cleanup, the subagent dispatch API
was reduced from 30+ params to 16. All configuration-driven defaults
(`toolBudget`, `turnBudget`, `timeout`, `cwd`, `sessionDir`, `output`,
`outputMode`, `reads`, `control`) are read from agent config only — dispatch
no longer overrides them.

```typescript
const SubagentParamsSchema = Type.Object({
  // Management/control
  action: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  index: Type.Optional(Type.Integer({ minimum: 0 })),
  view: Type.Optional(Type.String({ enum: ["fleet", "transcript"] })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  message: Type.Optional(Type.String()),
  config: Type.Optional(Type.Unsafe({ anyOf: [{ type: "object" }, { type: "string" }] })),

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

`TaskItem` has 6 fields:

```typescript
const TaskItem = Type.Object({
  agent: Type.String(),
  task: Type.String(),
  count: Type.Optional(Type.Integer({ minimum: 1 })),
  progress: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String()),
  skill: Type.Optional(SkillOverride),
});
```

### One mode to rule them all

All execution is unified via `tasks: [{agent, task}]`. A single task is just
parallel with n=1. The old `agent`/`task` top-level params are removed.

### Removed features (from user-facing dispatch)

- Chain support (CHAIN mode, chainDir, chainName, dynamic fanout)
- Clarify TUI
- Session sharing (GitHub Gist)
- Acceptance gates
- toolBudget / turnBudget / timeoutMs / maxRuntimeMs overrides
- cwd override
- sessionDir override
- control override
- agentScope override
- output / outputMode / reads overrides
- runId / dir aliases (only `id`)

## TypeBox Schemas (for tool params & RPC)

`src/extension/schemas.ts` defines the public tool-parameter schemas using
TypeBox. This is the canonical pattern for anything exposed as a tool or RPC:

```ts
import { Type } from "typebox";

// Primitive scalar
const SkillOverride = Type.Unsafe({
  anyOf: [
    { type: "array", items: { type: "string" } },
    { type: "boolean" },
    { type: "string" },
  ],
  description: "Skill name(s) to make available (comma-separated), array of strings, or boolean",
});

// Composed object with optional fields
Type.Object({
  agent: Type.String({ description: "..." }),
  task: Type.Optional(Type.String()),
  async: Type.Optional(Type.Boolean()),
});
```

Observed TypeBox builder usage (frequency): `Type.Optional` (121),
`Type.String` (57), `Type.Integer` (18), `Type.Object` (14),
`Type.Boolean` (14), `Type.Unsafe` (10), `Type.Array` (5), `Type.Number` (1).

### Conventions

- **Use `Type.Optional(...)`** for optional fields rather than omitting
  them and relying on `?` — it keeps the schema and the TS type in sync.
- **Add `description` only at the top level** of tool parameters.
  `schemas.ts` runs every schema through `keepTopLevelParameterDescriptions`
  → `pruneNestedDescriptions`, which strips nested `description` keys so
  only `properties.<key>.description` survives. If you need a description,
  put it on a direct child of the top `properties` object.
- **Use `Type.Unsafe(...)`** when you need a union/shape TypeBox's high-level
  builders don't express cleanly (e.g. `string | boolean | string[]`).
- **Reuse scalar schemas** (`SkillOverride`, `OutputOverride`) across
  multiple tools instead of re-declaring the union each time.

---

## TypeScript Types (internal data)

For purely internal data structures, define interfaces in the module that
owns them, or in `src/shared/types.ts` for cross-cutting types.

`src/shared/types.ts` is the **central registry** for types shared across
modules: `MaxOutputConfig`, `OutputMode`, `JsonSchemaObject`,
`ChainOutputMap`, `WorkflowGraphNode`, `SubagentState`, `Details`, etc.

```ts
// src/shared/types.ts
export type OutputMode = "inline" | "file-only";
export type JsonSchemaObject = Record<string, unknown>;
export type WorkflowNodeStatus = "pending" | "running" | "completed" | "failed" | "paused" | "detached";
export interface MaxOutputConfig { bytes?: number; lines?: number; }
```

### Conventions

- **String-union types for status / mode enums** — e.g.
  `OutputMode`, `WorkflowNodeStatus`. Do not use `enum`; use string-literal
  unions (`type X = "a" | "b"`).
- **Prefer `interface` for object shapes, `type` for unions/aliases.**
- **`unknown` over `any`** for opaque payloads — e.g. `JsonSchemaObject =
  Record<string, unknown>`. Catch errors as `unknown` and narrow with
  `NodeJS.ErrnoException` casts (see error/IO guidelines).
- **Co-locate a type with the module that produces it** unless it is
  genuinely cross-cutting, in which case it goes in `shared/types.ts`.

---

## When to use which

| Data source | Mechanism |
|-------------|-----------|
| Subagent tool parameters | TypeBox schema in `extension/schemas.ts` |
| RPC bridge payloads | TypeBox schema or explicit validation in `extension/rpc.ts` |
| Internal config / derived state | TS interface/type, often in `shared/types.ts` |
| Opaque passthrough (model JSON, etc.) | `unknown` / `Record<string, unknown>` |

---

## Common Mistakes

- **Validating external params with only a TS interface** — no runtime
  protection. Always route tool params through a TypeBox schema.
- **Adding nested `description` keys** — they get stripped by
  `keepTopLevelParameterDescriptions`; put descriptions at the top level.
- **Duplicating a union type** across files instead of reusing a shared
  scalar schema or a type in `shared/types.ts`.
- **Using `enum`** — the codebase uses string-literal union types everywhere.
