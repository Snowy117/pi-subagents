# Quality Guidelines

> Code-quality standards and forbidden/required patterns for `pi-subagents`.
> Use this as the review checklist before committing.

---

## Overview

This is a TypeScript Node.js extension with **no bundler, no `tsconfig`
compile, and no linter configured**. Quality is enforced by:
1. Near-universal code conventions (see the other spec files).
2. The TypeScript language server (`typescript-language-server`) for type
   errors — check via `lsp_diagnostics` after editing.
3. The `node:test` suite (`npm test` for unit).

Because there is no CI linter catching style violations, **the conventions
must be followed by hand**. Reviewers compare against the existing code.

---

## Required Patterns

- **`node:` prefix** on all builtin imports (`node:fs`, `node:path`, …).
- **`.ts` extension** on every relative import path.
- **`import type`** for type-only imports (split out from value imports).
- **Named exports**; `export default` only for Pi extension registrars.
- **Atomic writes** (`writeAtomicJson`) for any persisted JSON — never
  in-place `writeFileSync` on status/config.
- **Injectable dependencies** (`fs?`, `now?`, `pid?`, `random?`, `wait?`)
  for any function doing I/O, time, randomness, or process spawning.
- **TypeBox schemas** for tool params and RPC payloads crossing a trust
  boundary.
- **String-literal union types** (`type X = "a" | "b"`) instead of `enum`.
- **`node:assert/strict`** + `node:test` in tests, with injected fakes.
- **Best-effort `try/catch` carries a comment** explaining why suppression
  is safe.
- **Errno branching via `NodeJS.ErrnoException.code`**, not `error.message`.

---

## Forbidden Patterns

| Pattern | Why | Do instead |
|---------|-----|------------|
| Relative import without `.ts` | Breaks at runtime under native TS stripping | `from "./foo.ts"` |
| Builtin import without `node:` | Violates universal convention; fragile | `from "node:fs"` |
| `export default` in a non-extension module | Breaks import uniformity | named export |
| `enum` | Not used in the codebase | string-literal union type |
| Loose `node:assert` | Hides coercion bugs | `node:assert/strict` |
| In-place `writeFileSync(target, json)` | Torn reads, Windows contention | `writeAtomicJson` |
| Bare `catch {}` with no comment | Reviewers can't tell if suppression is safe | add an explanatory comment |
| Branching on `error.message` | Brittle, locale-dependent | branch on `.code` |
| Spawning child without stdio guard | Stuck child hangs the extension | `attachPostExitStdioGuard` |
| `any` for external payloads | No type safety | `unknown` / TypeBox schema |
| Adding to a large file in `runs/background/` | That module is intentionally many small files | new focused file |
| Frontend-style scaffolding (components/pages/hooks/store) | This is a Node CLI, not a web app | domain-organized modules |

---

## Testing Requirements

- **Every new logic unit gets a `test/unit/<name>.test.ts`** mirroring the
  source path, using injected fakes — no real subprocesses.
- **Cross-module wiring** goes in `test/integration/` with the mock-pi harness.
- **`npm test` (unit tier) must pass** before commit. It is the fast loop.
- Tests must be **deterministic**: inject `now`/`random`/`pid`; no real timers
  or real filesystem in unit tests.
- Run the TypeScript language server diagnostics (`lsp_diagnostics`, or
  `path="*"` for the whole workspace) after non-trivial edits.

---

## Code Review Checklist

Before approving a change, verify:

- [ ] Imports use `node:` prefix, `.ts` extension, and `import type` where type-only.
- [ ] New module uses named exports (or `export default` only if it's a registrar).
- [ ] No `enum`; union types used instead.
- [ ] Any new persisted JSON goes through `writeAtomicJson`.
- [ ] I/O-bearing functions accept injectable deps (so they're unit-testable).
- [ ] Tool/RPC params have a TypeBox schema; descriptions are top-level only.
- [ ] Suppressed errors have explanatory comments; errno branching uses `.code`.
- [ ] Spawned children have stdio guards.
- [ ] A `test/unit/<name>.test.ts` exists for new logic, using fakes.
- [ ] `npm test` passes and `lsp_diagnostics` is clean.
- [ ] New code is placed in the right domain directory (`runs/background/`
      gets a new small file, not appended growth; leaf primitives in `shared/`).
- [ ] **Reality check**: the code matches what the codebase *actually* does —
      see the cross-layer & code-reuse thinking guides in `.trellis/spec/guides/`.

---

## Verification Tip

Because there's no lint CI, lean on the LSP: after edits call
`lsp_diagnostics` on the file (or `path="*"` for a workspace-wide sweep) to
catch type errors the runtime would otherwise surface late.
