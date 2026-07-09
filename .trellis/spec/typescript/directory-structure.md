# Directory Structure

> How source code is organized in `pi-subagents` — a TypeScript Node.js
> CLI / Pi extension (NOT a frontend/web project).

---

## Overview

`pi-subagents` is a single-repo, no-build TypeScript project. Source lives
under `src/`, organized by **responsibility domain**, not by file type.
Every directory is a cohesive module with one job. There is no bundler,
no `tsconfig.json` build step, and no `src/components` or `src/pages` —
Node runs the `.ts` files directly via `--experimental-strip-types`.

---

## Directory Layout

```
src/
├── extension/      Extension entry points + RPC/schemas (the public surface registered into pi)
├── agents/         Agent discovery, frontmatter, memory, scope, selection, serialization
├── runs/           Execution engines for subagent runs
│   ├── foreground/   Synchronous, streamed runs (single, parallel, chain)
│   ├── background/   Async/scheduled/wait/fleet runs (20 files — the largest module)
│   └── shared/       Cross-engine concerns: budgets, acceptance, structured output, control
├── shared/         Project-wide primitives: types, atomic-json, utils, formatters, settings, session-identity
├── intercom/       Inter-session messaging bridge + native supervisor channel
├── slash/          Slash-command + prompt-template bridges
├── tui/            Terminal rendering (ink-style Component trees)
└── profiles/       Profile configuration
test/
├── unit/           85 files — pure logic, no real subagent spawning, heavy use of injected fakes
├── integration/    21 files — multi-module wiring, real file I/O, mock pi
├── e2e/            1 file  — real end-to-end session via child CLI
└── support/        Shared test helpers + loader (register-loader.mjs, mock-pi.ts, helpers.ts)
```

---

## Module Organization Rules

### 1. Group by responsibility domain

Each `src/<dir>` owns one domain. The split is **NOT** by language feature
(no `src/utils`, no `src/types` dump). The only general-purpose bucket is
`src/shared/` (see below).

- `runs/background/` is the largest (20 files) because async execution is
  the most complex domain — it is intentionally split into many small
  files (`async-execution.ts`, `wait.ts`, `notify.ts`, `run-status.ts`,
  `completion-dedupe.ts`, `completion-batcher.ts`, `fleet-view.ts`, …).
- `runs/` is subdivided into `foreground/`, `background/`, `shared/`.
  `runs/shared/` holds concerns used by BOTH engines (turn/tool budgets,
  acceptance, structured output, control, run history).

### 2. `src/shared/` = leaf primitives only

`src/shared/` holds low-level, dependency-light building blocks reused
across the whole project:

- `types.ts` — central type definitions (cross-cutting types live here)
- `atomic-json.ts` — atomic file writes
- `utils.ts` — config-dir resolution, formatting helpers
- `formatters.ts`, `status-format.ts`, `model-info.ts`, `session-identity.ts`,
  `session-tokens.ts`, `jsonl-writer.ts`, `settings.ts`, `artifacts.ts`, …

Do **not** put domain logic here. If a file needs to import from
`runs/` or `extension/`, it does not belong in `shared/`.

### 3. One file = one cohesive concern

Files are kept small and single-purpose. The `runs/background/` directory
proves this: instead of one giant `async.ts`, the work is split into
`async-execution.ts`, `async-resume.ts`, `async-status.ts`,
`async-job-tracker.ts`, `run-status.ts`, `result-watcher.ts`,
`scheduled-runs.ts`, `notify.ts`, `wait.ts`, `fleet-view.ts`, etc.
**When adding async/background behavior, create a new focused file in
`runs/background/` rather than appending to an existing large file.**

#### Hard line budget (300 / 500)

- **Every `src/**/*.ts` file must stay ≤ 300 lines.**
- **Every `test/**/*.ts` file must stay ≤ 500 lines.**

When a file approaches or exceeds its budget, split it along a cohesive
seam into a `<stem>/` subdirectory and keep `<stem>.ts` as a re-export
barrel (see [module-and-export-guidelines.md](./module-and-export-guidelines.md) §4).
Do **not** pile flat sibling files into a directory that is already at its
file-count ceiling (`runs/background/` = 20, `runs/shared/` = 23): use a
`<stem>/` subdir in that case.

#### Splitting a closure-heavy giant: shared-state-object extraction

Some files are dominated by ONE large async function with many inline
closures sharing mutable state (e.g. `runSubagent`, `runSingleAttempt`).
The approved technique is **shared-state-object + closure-group extraction**:

1. Collect the mutable locals into a `*State` interface + a `create*State()`
   factory (e.g. `RunnerState`, `SingleAttemptState`).
2. Extract cohesive closure groups into sibling modules (`runner-step-control.ts`,
   `single-attempt-events.ts`, …) as functions taking `(state, …params)`.
3. The extracted functions mutate the SAME state object by reference.

**Critical R2 rule for concurrent/spawn code:** do NOT add or remove `await`,
do NOT change handler-registration order or event-processing order, and do
NOT change mutation order. Inline `let x` captured by reference becomes
`state.x` access so by-reference visibility is preserved byte-for-byte.

### 4. Extension entry points use `export default`

Only **4** files in the entire codebase use `export default`, and they are
all Pi extension registration entry points:

- `src/extension/index.ts` — `registerSubagentExtension`
- `src/extension/fanout-child.ts` — `registerFanoutChildSubagentExtension`
- `src/runs/background/notify.ts` — `registerSubagentNotify`
- `src/runs/shared/subagent-prompt-runtime.ts` — `registerSubagentPromptRuntime`

Everywhere else uses **named exports only** (see
[module-and-export-guidelines.md](./module-and-export-guidelines.md)).

---

## Naming Conventions

- **Directories**: lowercase, hyphen-separated where needed (`runs`, `background`, no plurals for domain dirs).
- **Files**: lowercase `kebab-case.ts` — e.g. `atomic-json.ts`, `post-exit-stdio-guard.ts`, `async-job-tracker.ts`.
- **Test files**: mirror the source path under `test/<layer>/`, same stem + `.test.ts` — `src/shared/atomic-json.ts` → `test/unit/atomic-json.test.ts`.
- **Imports use the full `.ts` extension** in relative paths: `from "./atomic-json.ts"`. This is a hard convention (see module guidelines).

---

## Examples

- **Well-organized large domain**: `src/runs/background/` — many small files, each one job.
- **Leaf primitive module**: `src/shared/` — reusable, low-dependency.
- **Engine split**: `src/runs/{foreground,background,shared}` — shared concerns factored into `runs/shared/`.
