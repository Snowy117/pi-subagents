# TypeScript Development Guidelines

> Conventions for `pi-subagents` — a TypeScript Node.js CLI / Pi extension.
> This is **not** a frontend project; there are no components, pages, or
> React hooks here.

---

## Overview

`pi-subagents` is a single-repo, no-build TypeScript project. Node runs `.ts`
directly via `--experimental-strip-types`. Source is organized by
responsibility domain under `src/`. These guidelines document the
**actual conventions** of the codebase so every AI session writes code that
fits in.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | `src/` domain layout, `runs/` engine split, naming | ✅ Filled |
| [Module & Export Guidelines](./module-and-export-guidelines.md) | ESM, `node:` prefix, `.ts` extensions, `import type`, named exports | ✅ Filled |
| [Schema & Type Safety](./schema-and-type-safety.md) | TypeBox runtime schemas, `shared/types.ts`, union types | ✅ Filled |
| [Testing Guidelines](./testing-guidelines.md) | `node:test` + `assert/strict`, three tiers, injected fakes | ✅ Filled |
| [Error & I/O Guidelines](./error-and-io-guidelines.md) | Atomic JSON, dependency injection, best-effort catch, errno branching | ✅ Filled |
| [Cross-Extension Contracts](./cross-extension-contracts.md) | Co-existence with pi-intercom: tool-name collision, cross-protocol handshake, reply-path asymmetry | ✅ Filled |
| [Quality Guidelines](./quality-guidelines.md) | Required/forbidden patterns, review checklist | ✅ Filled |

Also see the cross-cutting thinking guides in
[`../guides/`](../guides/index.md) (code reuse, cross-layer data flow).

---

## Pre-Development Checklist

Before writing code in this project:

- [ ] Identify the **responsibility domain** — which `src/<dir>` does this belong to?
      (`runs/background/` behaviors get a *new small file*, not growth in an existing one.)
- [ ] Confirm import style: `node:` prefix, `.ts` extension on relative imports,
      `import type` for types.
- [ ] If touching I/O: does the function accept **injectable dependencies**
      (`fs?`, `now?`, …)? Does it write JSON via `writeAtomicJson`?
- [ ] If adding tool/RPC params: define a **TypeBox schema**; descriptions
      top-level only.
- [ ] Plan the **`test/unit/<name>.test.ts`** with injected fakes up front.

---

## Quality Check

After writing code:

- [ ] `npm test` (unit tier) passes.
- [ ] `lsp_diagnostics` is clean (run `path="*"` for a workspace sweep).
- [ ] Suppressed errors have explanatory comments; errno branching uses `.code`.
- [ ] No forbidden patterns from [quality-guidelines.md](./quality-guidelines.md).
- [ ] Spawned children have stdio guards; persisted JSON is atomic.

---

**Language**: All documentation is written in **English**.
