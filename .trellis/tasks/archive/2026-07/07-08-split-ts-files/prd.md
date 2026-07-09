# PRD — Split oversized TS files for semantic modularity

## Goal

Refactor `pi-subagents` so every TypeScript source file respects a hard line
budget while remaining **behaviorally identical**. The plugin's runtime
behavior, public API, and test outcomes must not change. This is a
pure-structure refactor (file splitting + import-path bookkeeping), not a
feature change.

## Background / constraints (from codebase + spec)

- **No build step.** Node runs `.ts` directly via `--experimental-strip-types`
  (unit) / `--experimental-transform-types` (integration/e2e). There is no
  `tsconfig.json`, no bundler. Relative imports **must** carry the `.ts`
  extension. → Every file move implies updating every importer; this is the
  dominant risk of the whole task.
- **Spec is canonical** (`.trellis/spec/typescript/`):
  - `directory-structure.md` — group by responsibility domain; `src/shared/` =
    leaf primitives; one file = one cohesive concern; `export default` reserved
    for the 4 extension entry points; lowercase kebab-case files.
  - `module-and-export-guidelines.md` — named exports; `.ts` in every relative
    import; `node:` builtins; `import type` for types; `create*` factories.
  - `testing-guidelines.md` — `node:test` + `node:assert/strict`; three tiers;
    **npm scripts use shell-expanded flat globs** `test/unit/*.test.ts` etc.
- **Coupling evidence (grep):** `shared/types.ts` imported by **82** files,
  `shared/utils.ts` by **36**, `agents/agents.ts` by **28**, `shared/settings.ts`
  by **15**. These cannot be moved without either a barrel or rewriting dozens
  of importers.
- **Scale:** `src/` = 39,165 LOC across 93 files; **37 src files exceed 300
  lines**. `test/` = 37,380 LOC; **17 test files exceed 500 lines**. Two giants:
  `runs/foreground/subagent-executor.ts` (3,681) and `runs/background/subagent-runner.ts`
  (3,171).

## Requirements

### R1 — Line budgets (hard)

- Every `src/**/*.ts` file ≤ **300 lines** after refactor.
- Every `test/**/*.ts` file ≤ **500 lines** after refactor.
- Line count = `wc -l` (includes blank lines / comments). No exceptions for
  barrel re-export hubs (they stay tiny via wildcard re-export, see R3).

### R2 — Behavior preserved (hard)

- No change to plugin runtime behavior, registered tools/commands, prompt
  templates, TUI output, or public exports consumed by `pi`.
- The 4 `export default` extension entry points keep their default export and
  their file path (`src/extension/index.ts` etc.) so `package.json` `"pi".extensions`
  and `"files"` globs keep matching.
- `package.json` `"files"` include list (`src/**/*.ts`) must still cover all
  source after moves.
- All existing tests must still pass with no semantic change (only file
  location / grouping of test cases may change).

### R3 — Barrel re-export hubs preserve the public import surface (core technique)

When a widely-imported file `foo.ts` is split into a `foo/` subdirectory, the
original `foo.ts` is **kept as a thin re-export barrel**:

```ts
// foo.ts becomes a barrel (<300 lines, typically <50)
export * from "./foo/a.ts";
export * from "./foo/b.ts";
```

- Every existing `import … from "…/foo.ts"` keeps working unchanged.
- Wildcard `export *` is safe here because the names being split already belong
  to one module (no cross-module name collisions).
- This makes each split independently verifiable and minimizes the number of
  files touched per chunk. It is the project's first use of barrels (codebase
  currently has 0 `export *`); this is an accepted micro-refactor per R2.

### R4 — Semantic independence of split files

- Each new file must group a **cohesive concern** (not a random line-range cut).
  Seams follow existing function/type boundaries discovered by reading the file.
- No file may exist only to "hold overflow" with no semantic identity.

### R5 — Folder crowding control

- No `src/` folder should grow unbounded from splitting. Target: keep each
  `src/` folder's **direct file count ≤ ~15–20** (the spec already documents
  `runs/background/` at 20 as the accepted ceiling).
- When a split would push a folder over budget, place the new submodules in a
  new `<stem>/` subdirectory and keep `<stem>.ts` as the barrel (R3). This is
  mandatory for the two giants.
- `test/` folder strategy is a separate decision — see Open Questions.

### R6 — Micro-refactoring allowed, macros forbidden

- Allowed: extracting helpers, splitting one large function across cohesive
  private submodules, light rename of a purely-local (non-exported) symbol.
- Forbidden: changing function signatures on exported APIs, changing control
  flow, "optimizing" logic, merging concerns, removing code.

### R7 — Chunked, verifiable execution

- Work is divided into ordered, independently-verifiable chunks (see
  `implement.md`). After each chunk: relevant tests pass + no new type
  diagnostics. Sub-agents are dispatched per chunk (user-requested).

## Acceptance criteria

1. `find src -name '*.ts' | xargs wc -l` — **no src file > 300 lines**.
2. `find test -name '*.ts' | xargs wc -l` — **no test file > 500 lines**.
3. `npm run test:unit` passes (exit 0).
4. `npm run test:integration` passes (exit 0).
5. `npm run test:e2e` passes or is explicitly marked environment-unavailable
   with rationale (it spawns a real pi session).
6. LSP diagnostics: no **new** errors introduced (`lsp_diagnostics path="*"`
   shows no errors attributable to this refactor; pre-existing ones unchanged).
7. Every split file has a single cohesive concern (R4) — spot-checked at final
   review.
8. No `src/` folder exceeds the file-count budget (R5).
9. Plugin entry points + `package.json` globs unchanged in effect (R2).
10. `git diff` contains **only** moves/splits/import-path edits — no logic
    changes to exported behavior.

## Out of scope

- Rewriting or "modernizing" logic.
- Changing the test runner, assertion library, or npm script semantics
  (unless the user explicitly chooses the test-subdir option in Open Questions).
- Splitting `.md`, `.mjs`, or non-`.ts` files.
- Splitting files that are already under budget.
- Reorganizing `agents/`, `prompts/`, `skills/` markdown content.
- Performance optimization.

## Open questions (blocking decisions)

### OQ1 — Test directory organization (needs user decision)

Splitting 17 oversized test files produces ~30–40 new `.test.ts` files.
`test/unit` already holds 85 files (spec-documented norm). Options:

- **(A) Flat** — keep all tests in `test/{unit,integration}/`, mirror existing
  convention. `npm` scripts and CI (`test.yml`) unchanged. `test/unit` grows to
  ~105–110 files. *Recommended: lowest risk, spec-consistent.*
- **(B) Subdir grouping** — group into `test/unit/<domain>/` (agents/, runs/,
  slash/, shared/, …) and switch npm globs to `test/unit/**/*.test.ts`. Nicer
  layout, but changes `package.json` + `test.yml`, depends on Node's glob
  support, and breaks the spec-documented flat-glob convention.

Decision deferred to user review (Phase 1.4). Default if unreplied: **(A) flat**.

### OQ2 — Barrel pattern confirmation (informational; proceed unless objected)

Introducing `export *` barrel hubs (R3) is a new pattern for this codebase.
It is the primary risk-reducer. This is flagged for transparency, not a
blocking question — proceed with barrels unless the user objects at review.
