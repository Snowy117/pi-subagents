# Module & Export Guidelines

> Import/export conventions for this ESM TypeScript project. These rules are
> backed by codebase-wide statistics — they are **near-100% consistent**, so
> violating them produces code that visibly stands out.

---

## Overview

- **Module system**: pure ESM (`"type": "module"` in `package.json`).
- **No build step**: Node runs `.ts` directly via `--experimental-strip-types`
  / `--experimental-transform-types`. There is no bundler, no `tsc` emit.
- **Type checking**: via `typescript-language-server` (LSP), not a `tsconfig`
  compile. Diagnostics come from the editor/runtime.

---

## Import Rules (all hard conventions)

### 1. Always use the `node:` prefix for builtins

```ts
// ✅ correct
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";

// ❌ forbidden — bare builtin names
import * as fs from "fs";
import * as path from "path";
```

Observed builtin usage (frequency): `node:path` (128), `node:fs` (126),
`node:os` (67), `node:url` (17), `node:crypto` (13), `node:module` (2),
`node:child_process` (via named `spawn`), `node:events`, `node:assert/strict`.

### 2. Relative imports MUST include the `.ts` extension

This is the single most consistent convention in the codebase:
**409 relative imports include `.ts`; 0 omit it.** Always write the extension.

```ts
// ✅ correct
import { writeAtomicJson } from "./atomic-json.ts";
import type { AgentConfig } from "../../agents/agents.ts";
import { createAsyncJobTracker } from "../background/async-job-tracker.ts";

// ❌ forbidden — missing extension
import { writeAtomicJson } from "./atomic-json";
```

Node's native TypeScript stripping requires the explicit extension, and the
project depends on it.

### 3. Use namespace imports for `fs` / `path` / `os`

```ts
// ✅ canonical form (used 52× / 50× / 13× respectively)
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
```

Prefer `import * as fs` over `import { readFileSync }` for these modules.

### 4. Use `import type` for type-only imports

61 of 93 source files use `import type`. Separate type-only imports so they
are erased at runtime:

```ts
// ✅ type-only import, separately declared
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
```

When importing both a value and a type from the same module, use an inline
`type` modifier:

```ts
// ✅ mixed value + type from one module
import { createChildTranscriptWriter, type ChildTranscriptWriter } from "../../shared/child-transcript.ts";
```

---

## Export Rules

### 1. Named exports by default

```ts
// ✅ named exports — the default everywhere except extension entry points
export function formatDuration(ms: number): string { ... }
export interface MaxOutputConfig { ... }
export type OutputMode = "inline" | "file-only";
export const ASYNC_DIR = ".pi/agent/subagent/async";
```

Observed export counts: `function` (426), `interface` (148), `const` (103),
`type` (64), `class` (6).

### 2. `export default` is reserved for Pi extension entry points

Only **4 files** use `export default`, all extension registrars:

```ts
// src/extension/index.ts
export default function registerSubagentExtension(pi: ExtensionAPI): void { ... }
```

Do **not** use `export default` for regular modules. If you reach for it,
you almost certainly want a named `register*` / `create*` export instead.

### 3. Factory functions: `create*` for stateful producers

When a module produces a stateful object or closure, export a
`create*` factory rather than a `class`. There are **17** `create*`
factories in the codebase:

```ts
export function createAtomicJsonWriter(options?: AtomicJsonWriterOptions): (filePath: string, payload: object) => void { ... }
export function createAsyncJobTracker(...) { ... }
export function createResultWatcher(...) { ... }
export function createJsonlWriter(...) { ... }
export function createFileCoalescer(...) { ... }
```

Classes (only 6 total) are reserved for genuinely polymorphic objects.
Prefer `create*` + closures + injected dependencies for everything else
(see [error-and-io-guidelines.md](./error-and-io-guidelines.md) for the
dependency-injection pattern).

---

## Common Mistakes

- **Omitting `.ts`** in a relative import — breaks at runtime under native TS.
- **Forgetting `node:` prefix** — works today but violates the universal convention.
- **Using `export default`** for a non-extension module — breaks the import-style uniformity.
- **Value import where a type import suffices** — always split with `import type`.
