# Design — Split oversized TS files

Companion to `prd.md`. This document fixes the **how**: the split pattern, the
per-area plan, the dispatch/verification model, and the rollback shape.

## 1. The core transformation: "split + barrel"

Every oversized file `X.ts` is transformed the same way:

```
BEFORE                       AFTER
src/<dir>/foo.ts   (900)   → src/<dir>/foo.ts          (barrel, ~10–40 lines)
                             src/<dir>/foo/<concern-a>.ts
                             src/<dir>/foo/<concern-b>.ts
                             src/<dir>/foo/<concern-c>.ts
```

- `foo.ts` becomes a **wildcard re-export hub**: `export * from "./foo/a.ts"; …`.
  Every existing `import { X } from "…/foo.ts"` keeps resolving. **Importers
  do not change** — this is what makes the refactor safe and each chunk
  independently verifiable.
- The `foo/` submodules are **purely internal**: they are imported only by the
  barrel (and, optionally, by each other via relative `./` paths). They are
  never imported from outside the `foo/` tree. This keeps the public import
  surface identical to today.
- When a file is imported by **very few** modules (≤ ~3) AND a barrel would be
  pure ceremony, the chunk may instead move importers to deep paths — but the
  default is always barrel, because it is mechanical and reversible.

### Barrel sizing

A barrel is one `export *` line per submodule. Even `types.ts` (127 exports)
becomes a ~10-line barrel across ~8–10 type-group submodules. **No barrel will
approach the 300-line limit.** If a barrel ever would, that signals the split
is wrong (re-cut the seams), not that the barrel should grow.

### Why wildcard `export *` is safe here

The names being re-exported already coexist in one module today, so they are
already unique. The only `export *` collision risk is between *different*
modules — and barrels re-export from sibling submodules of the *same* logical
module, so no collision is possible.

### What the barrel must NOT do

- Must not add, rename, or drop exports vs. the original file (R2: behavior
  preserved). A post-split check: the set of names exported by the new
  `foo.ts` barrel must equal the set the old `foo.ts` exported. The sub-agent
  verifies this by diffing exported symbol names before/after.

## 2. Finding seams (semantic boundaries)

The sub-agent for each chunk **reads the file** and cuts along existing
boundaries, never at an arbitrary line number. Good seam signals in this
codebase:

- Clusters of related `function`/`const`/`type`/`interface` declarations.
- A single oversized function → extract private helpers it calls into a
  `<stem>-helpers.ts` (still ≤300 lines each); the function body stays in one
  submodule. (Micro-refactor, allowed by R6.)
- `types.ts`-style files → group types by domain (run types, chain types,
  budget types, control types, …) into `<domain>-types.ts`.
- Pure helpers vs. orchestration → separate files.

Bad seams (forbidden by R4): "first 300 lines / next 300 lines" cuts; files
that only exist to hold overflow; splitting one cohesive function's body
across files.

## 3. Per-area plan

Line counts are pre-refactor (`wc -l`). "files>300" = the files in that area
that violate R1. Each oversized file → `barrel + <stem>/` subdir by default.

### Tier 1 — leaf primitives (parallel-safe, lowest risk)

| Area | Oversized files (lines) | Notes |
|---|---|---|
| `src/shared/` | `types.ts` (1267, **82 importers**), `utils.ts` (554, 36 importers), `settings.ts` (450, 15) | Barrels **essential**. `types/` grouped by domain. `shared/` direct-file count stays ~16. |
| `src/tui/` | `render.ts` (1748) | Splits into text-wrap, glyph/animation, stats, line-building concerns → `tui/render/`. Keeps `render.ts` + `render-helpers.ts`. |
| `src/profiles/` | `profiles.ts` (637) | Flat split into ≤3 files (only 1 file now → headroom). |
| `src/intercom/` | `native-supervisor-channel.ts` (683), `result-intercom.ts` (377) | `native-supervisor-channel/` subdir for the big one; `result-intercom` flat 2-file. |

### Tier 2 — mid-level

| Area | Oversized files (lines) | Notes |
|---|---|---|
| `src/agents/` | `agents.ts` (1553, **28 importers**), `agent-management.ts` (1052), `skills.ts` (729) | Barrels for `agents.ts`. `agents.ts` = types + discovery → split by that seam. `agent-management.ts` = validation helpers + CRUD actions. |
| `src/slash/` | `slash-commands.ts` (1296), `prompt-template-bridge.ts` (420), `prompt-workflows.ts` (330) | `slash-commands/` subdir; others flat 2-file. |
| `src/runs/shared/` | `nested-events.ts` (908), `acceptance.ts` (879), `worktree.ts` (600), `subagent-prompt-runtime.ts` (342), `mcp-direct-tool-allowlist.ts` (365) | Already 23 files (spec ceiling). Split each into a `<stem>/` subdir so direct count stays 23. **Note:** `subagent-prompt-runtime.ts` is one of the 4 `export default` entry points — its barrel must re-export the default. |

### Tier 3 — extension surface

| Area | Oversized files (lines) | Notes |
|---|---|---|
| `src/extension/` | `index.ts` (657, **`export default` entry**), `rpc.ts` (369), `schemas.ts` (309) | `index.ts` keeps its path + `export default registerSubagentExtension`; internals move to `extension/registration/` and `index.ts` delegates. `rpc`/`schemas` flat 2-file. |

### Tier 4 — execution engines (highest risk, strictly sequential)

| Area | Oversized files (lines) | Notes |
|---|---|---|
| `src/runs/background/` async cluster | `async-execution.ts` (1065), `scheduled-runs.ts` (514), `fleet-view.ts` (536), `wait.ts` (449), `async-job-tracker.ts` (441), `run-status.ts` (438), `async-resume.ts` (410), `async-status.ts` (395), `stale-run-reconciler.ts` (388), `control-channel.ts` (332), `result-watcher.ts` (315) | Background is at the 20-file ceiling → multi-file splits go in `<stem>/` subdirs. |
| `src/runs/foreground/` chain cluster | `chain-clarify.ts` (1333), `chain-execution.ts` (1313), `execution.ts` (1260) | Only 4 files now → room to split flat or via subdirs (`runSingleAttempt` in `execution.ts` is ~846 lines → extract helpers). |
| `src/runs/background/subagent-runner.ts` (**3171**) | GIANT — own chunk | Dominated by `runSubagent` (~1820 lines) + `runSingleStep` (~386) + event-logging + parallel clusters. Split into `runs/background/runner/` (~12 submodules) + `subagent-runner.ts` barrel. **Highest background risk.** |
| `src/runs/foreground/subagent-executor.ts` (**3681**) | GIANT — own chunk | Many medium functions + `runChainPath`/`runAsyncPath` orchestration + resume/control clusters. Split into `runs/foreground/executor/` (~13 submodules) + barrel. **Highest overall risk**; do last. |

### Tier 5 — tests (after all src import paths are final)

| Files >500 (17) | Strategy |
|---|---|
| integration: `async-execution`(2772), `single-execution`(1930), `chain-execution`(1535), `fork-context-execution`(1306), `slash-commands`(1284), `async-job-tracker`(1107), `intercom-result-delivery`(1081), `result-watcher`(892), `render-widget`(691), `render-fork-badge`(583) | Most use a single top-level `describe` with nested `it`s → split by feature into sibling `.test.ts` files (e.g. `single-execution-timeout.test.ts`, `single-execution-output.test.ts`). Shared setup → extract into `test/support/` helper if duplicated. |
| unit: `agent-frontmatter`(1268, **14 describes** → easy group), `run-status`(997), `pi-args`(824, 3 describes), `agent-overrides`(579), `schemas`(562), `agent-management`(556), `subagent-prompt-runtime`(517) | Group `describe`s by theme into 2–4 files each. |

Tests run **last** so they split against the final, stable import graph.

## 4. Dispatch & verification model

### One writer, sequential chunks

The whole refactor shares one working tree with deeply intertwined imports.
Per the pi-subagents "one writer per cwd" rule, chunks run **sequentially in
the main tree** (not parallel worktrees). Parallelism is reserved for Tier-1
leaf areas only if the user/expediter chooses, and only with disjoint file
sets. **Default: sequential.**

Each chunk is one sub-agent dispatch:

> Active task: `.trellis/tasks/07-08-split-ts-files`
> You are a `trellis-implement` sub-agent for chunk <N>: split <files> in
> <area>. Read `prd.md`, `design.md`, `implement.md`. Apply the "split +
> barrel" transformation. Do NOT change behavior. When done: run
> `<validation>` and report exported-symbol parity + line counts + test result.

### Per-chunk validation (gate before next chunk)

1. `wc -l` on the touched files — all ≤ budget.
2. Exported-symbol parity: the barrel re-exports exactly the names the
   original exported (sub-agent lists both sets).
3. Type check: `lsp_diagnostics path="*"` shows no new errors.
4. Targeted tests pass:
   - unit-area chunk → `node --experimental-strip-types --test <relevant unit tests>`.
   - engine chunk → relevant unit **and** integration tests.
5. Full regression at tier boundaries: after Tier 4, run
   `npm run test:unit && npm run test:integration`.

### Final gate (before Phase 3.4)

- R1/R2 acceptance checks from `prd.md` (the `wc -l` sweeps + test suites).
- `git diff --stat` eyeballed: only moves/splits/import edits.
- Spot-check 2–3 split submodules for semantic cohesion (R4).

## 5. Compatibility & risk

| Risk | Mitigation |
|---|---|
| Breaking a relative import path | Barrel preserves the public path; submodules are internal-only. Sub-agent runs targeted tests each chunk. |
| Dropping/renaming an export during split | Exported-symbol parity check every chunk. |
| One giant function can't fit a submodule | Extract private helpers (R6 micro-refactor); never split a function body across files. |
| `export default` entry points | Barrels re-export the default; entry path + `package.json` globs unchanged. |
| Test-dir crowding (OQ1) | Deferred to user; default flat. |
| Sub-agent context drift over a long chunk | Each chunk is bounded to one area + one dispatch; main session integrates & verifies between chunks. |

## 6. Rollback

Each chunk is a discrete, committable unit. If a chunk fails verification and
cannot be repaired quickly, `git restore` the touched paths and redo. Because
barrels keep importers stable, a failed chunk does **not** corrupt other
areas — the tree is valid before and after each chunk.
