# Error & I/O Guidelines

> How this project handles filesystem I/O, process control, and errors. The
> codebase is a long-running extension that must **never crash its host** —
> this produces two pervasive patterns: **atomic writes** and
> **best-effort error suppression with explanatory comments**.

---

## Overview

Because `pi-subagents` runs inside the pi host process and spawns/monitors
child processes, I/O failure modes are common and varied (Windows rename
locks, ENOENT on races, broken pipes after child exit). The conventions
below keep the host alive.

---

## 1. Atomic JSON Writes (hard convention for status/config)

Never write a JSON file by overwriting it in place. Use the atomic writer
from `src/shared/atomic-json.ts`:

```ts
import { writeAtomicJson } from "../../shared/atomic-json.ts";
writeAtomicJson(filePath, payload);   // write-to-temp then rename
```

`atomic-json.ts` implements write-temp-then-rename with:

- **Temp file naming**: `.${base}.${pid}.${now}.${random}.tmp` so concurrent
  writers never collide.
- **`mkdirSync(dirname, { recursive: true })`** before writing.
- **Rename retry** on Windows (`EACCES`, `EBUSY`, `EPERM`) with exponential
  backoff (`DEFAULT_RENAME_RETRY_DELAYS_MS = [10,25,50,100,200,500,1000,2000,4000]`).
- **`finally { rmSync(temp, { force: true }) }`** to clean up on failure.

```ts
// src/shared/atomic-json.ts — the canonical pattern
export function createAtomicJsonWriter(options: AtomicJsonWriterOptions = {}) {
  const fsImpl = options.fs ?? fs;
  // ...
  return (filePath: string, payload: object): void => {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(dir, `.${base}.${pid}.${now()}.${rand}.tmp`);
    try {
      fsImpl.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf-8");
      renameWithRetry(fsImpl, tempPath, filePath, retryDelaysMs, wait);
    } finally {
      fsImpl.rmSync(tempPath, { force: true });
    }
  };
}
export const writeAtomicJson = createAtomicJsonWriter();
```

**Rule**: any code that persists status / config / run state to disk goes
through `writeAtomicJson`. Do not hand-roll `fs.writeFileSync(target, ...)`.

---

## 2. Dependency Injection for I/O (enables deterministic tests)

Production functions that do I/O accept injectable dependencies via an
options object. This is what makes the unit-test fake pattern possible
(see [testing-guidelines.md](./testing-guidelines.md)):

```ts
type AtomicJsonFs = Pick<typeof fs, "mkdirSync" | "writeFileSync" | "renameSync" | "rmSync">;

type AtomicJsonWriterOptions = {
  fs?: AtomicJsonFs;            // inject a fake filesystem
  now?: () => number;           // inject deterministic time
  pid?: number;                 // inject deterministic pid
  random?: () => number;        // inject deterministic randomness
  retryRenameErrors?: boolean;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => void;  // inject the wait (no real sleep in tests)
};
```

Observed injection points: `now?` (15×), `pid?` (8×), `fs?` (several modules),
`random?`, `wait?`.

**Rule**: if a function touches the filesystem, clock, randomness, or process
spawning, expose those as optional injected dependencies with sensible
defaults (`?? fs`, `?? Date.now`, `?? process.pid`).

---

## 3. Best-Effort `try/catch` with an Explanatory Comment

Non-fatal operations are wrapped in `try/catch` that swallows the error, and
**the catch always carries a comment explaining WHY suppression is safe.**
Bare `catch {}` without a comment is a smell — reviewers will flag it.

```ts
// src/shared/artifacts.ts
try {
  // Artifact cleanup is best-effort housekeeping. Skip files that disappear
  // or become unreadable while scanning so one bad entry does not block the rest.
  // ...
} catch { /* fall through */ }

// src/shared/utils.ts — config-dir resolution
try {
  let dir = path.dirname(fs.realpathSync(entryPoint));
  while (dir !== path.dirname(dir)) { /* ... */ }
} catch {
  // Package metadata lookup is best-effort; detached runners must not fail here.
}

// src/shared/post-exit-stdio-guard.ts
try { child.stdout?.destroy(); } catch {}
try { return child.kill(signal); } catch { return false; }
```

The recurring justification phrases: *"best-effort"*, *"must not fail here"*,
*"fall through"*, *"skip … so one bad entry does not block the rest"*, and
the detachment note *"detached runners must not fail"*.

**Rule**: when you suppress an error, write the comment. The comment answers:
what is best-effort here, and what breaks if this threw?

---

## 4. Narrowing `ErrnoException` by `code`

Filesystem/process errors are caught as `unknown` and narrowed by inspecting
the `code` property via `NodeJS.ErrnoException`:

```ts
// the canonical ENOENT check — appears ~10× across src/
if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
// or defensively optional-chained:
const code = (error as NodeJS.ErrnoException | undefined)?.code;
```

Decide behavior on the **specific code** (`ENOENT`, `EACCES`, `EBUSY`,
`EPERM`), not on the error message. `ENOENT` almost always means "treat as
absent / empty"; the retryable set (`EACCES|EBUSY|EPERM`) drives rename retry.

```ts
// src/shared/atomic-json.ts
const RETRYABLE_RENAME_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && RETRYABLE_RENAME_ERROR_CODES.has(code);
}
```

**Rule**: catch as `unknown`, cast to `NodeJS.ErrnoException`, branch on
`code`. Never `throw` then re-catch based on `error.message`.

---

## 5. Process / stdio Guards

Child-process stdio is unreliable after exit (broken pipes, hung streams).
`src/shared/post-exit-stdio-guard.ts` provides:

- `trySignalChild(child, signal)` — kills wrapped in `try/catch` returning
  `boolean`.
- `attachPostExitStdioGuard(child, { idleMs, hardMs })` — drains a child's
  stdout/stderr after exit with an idle timeout and a hard timeout, then
  `destroy()`s any unended stream (each destroy individually guarded).

**Rule**: when you spawn and pipe a child, guard its stdio so a stuck child
cannot hang the extension. Wrap `child.kill()` in `trySignalChild`.

---

## Common Mistakes

- **In-place `writeFileSync` on a status/config file** — causes torn reads
  on crash and Windows rename contention. Use `writeAtomicJson`.
- **Bare `catch {}` with no comment** — always explain why suppression is safe.
- **Branching on `error.message`** instead of the `NodeJS.ErrnoException` `code`.
- **Hard-coding `fs`/`Date.now`/`process.pid`/`Math.random`** in a function
  that should be unit-testable — expose them as injected options.
- **Spawning a child without a stdio guard** — a stuck child stream can hang
  the whole extension.
