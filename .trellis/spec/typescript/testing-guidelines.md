# Testing Guidelines

> Testing conventions for `pi-subagents`. The project uses **`node:test`**
> (the built-in test runner) with three tiers — no Jest, no Vitest, no
> external assertion library.

---

## Overview

- **Runner**: `node:test` (`describe`, `it`, `before`, `after`, `beforeEach`, `afterEach`).
- **Assertions**: `node:assert/strict` (imported as the default).
- **No build step in tests**: `--experimental-strip-types` (unit) /
  `--experimental-transform-types` (integration/e2e) run `.ts` directly.
- **Three tiers** mirroring a test pyramid.

```ts
// Standard test file header
import assert from "node:assert/strict";
import { describe, it } from "node:test";
```

**Assertion style**: always `import assert from "node:assert/strict"` (used
106×). The non-strict `import * as assert from "node:assert"` appears only
once — do not use it in new tests.

---

## Test Tiers

```
test/
├── unit/          85 files — pure logic, injected fakes, no real process spawning
├── integration/   21 files — multi-module wiring, real file I/O, mock pi harness
├── e2e/            1 file  — real end-to-end session via child CLI
└── support/              — shared helpers + loader (register-loader.mjs, mock-pi.ts, helpers.ts)
```

### Unit tests (`test/unit/*.test.ts`)

- **Run command**: `npm run test:unit` →
  `node --experimental-strip-types --test test/unit/*.test.ts`.
- **No real subprocesses, no real network.** External surfaces (filesystem,
  time, random, child process) are replaced with **dependency-injected fakes**.
- The dominant pattern is a fake implementation object passed into a
  `create*` factory via an options object.

```ts
// Canonical fake pattern — test/unit/atomic-json.test.ts
class FakeFs {
  files = new Map<string, string>();
  renameCalls = 0;
  mkdirSync(dirPath: string): void { /* record */ }
  writeFileSync(filePath: string, contents: string): void { this.files.set(filePath, contents); }
  renameSync(sourcePath: string, targetPath: string): void { this.renameCalls++; /* ... */ }
  rmSync(filePath: string): void { this.files.delete(filePath); }
}

function createWriter(fakeFs: FakeFs, waits: number[]) {
  return createAtomicJsonWriter({
    fs: fakeFs,                       // inject the fake filesystem
    now: () => 1000,                  // inject deterministic time
    pid: 42,
    random: () => 0.5,                // inject deterministic randomness
    retryRenameErrors: true,
    wait: (delayMs) => { waits.push(delayMs); },
  });
}
```

This is **the** testing philosophy of this codebase: production code accepts
injectable `fs`, `now`, `pid`, `random`, `wait` via an options object, and
tests supply deterministic fakes. If you cannot test something without
spawning a process, first check whether the production code should accept an
injectable dependency.

### Integration tests (`test/integration/*.test.ts`)

- **Run command**: `npm run test:integration` →
  `node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts`.
- Real multi-module wiring with **real file I/O** (temp dirs) but a **mock pi**
  (`test/support/mock-pi.ts`, `test/support/mock-pi-script.mjs`).
- Use `before/after/beforeEach/afterEach` for setup/teardown of temp files.
- The `.mjs` loader (`register-loader.mjs`) is required because integration
  tests may import modules that need transform (not just strip).

### E2E tests (`test/e2e/*.test.ts`)

- **Run command**: `npm run test:e2e`.
- Genuinely spawn a real pi session via the child CLI
  (`test/support/real-session-child-cli.mjs`, `real-session-runner.ts`).
- Keep these sparse — they are slow. Most behavior belongs in unit/integration.

---

## Naming & Structure Conventions

- **File name mirrors source**: `src/shared/atomic-json.ts` →
  `test/unit/atomic-json.test.ts`.
- **`describe` block = the unit under test; `it` = one behavior.** Test
  descriptions are full sentences, often starting with a verb:
  `it("falls back without importing the module")`,
  `it("honors an explicitly provided value")`,
  `it("consumes bounded dynamic fanout")`.
- **One assertion concept per `it`** — prefer many small `it`s over one big one.

---

## Running Tests

```bash
npm test            # = npm run test:unit (the fast tier, default)
npm run test:unit   # 85 unit tests, no I/O, injectable fakes
npm run test:integration
npm run test:e2e
npm run test:all    # unit → integration → e2e
```

There is no watch mode configured and no coverage tool — keep tests fast
and deterministic so `npm test` is a tight feedback loop.

---

## Common Mistakes

- **Using `node:assert` (loose) instead of `node:assert/strict`** — strict
  equality is the project default; loose asserts hide type coercion bugs.
- **Spawning a real process in a unit test** — inject a fake instead. If the
  code can't accept an injected dependency, refactor the production code first.
- **Non-deterministic tests** — always inject `now`/`random`/`pid` so retries,
  temp filenames, and timestamps are reproducible (see `atomic-json.ts`).
- **Misaligned file names** — `foo.ts` must be tested by `foo.test.ts` in the
  matching tier.
- **Big monolithic `it` blocks** — split into focused, sentence-named `it`s.
