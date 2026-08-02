# Design: Unify child mode to persistent RPC

## Overview

Remove the `--mode json -p` path entirely. All children are RPC (`--mode rpc`).
This eliminates the `if (persistent)` branching and the root cause of the
"always read-only" bug: `foregroundLiveChildren` entries missing `sessionFile`.

## Changes

### 1. ForegroundLiveChild gets sessionFile

**File**: `src/shared/types/async-types.ts`

```ts
export interface ForegroundLiveChild {
  runId: string;
  index: number;
  agent: string;
  status: "running" | "completed" | "failed";
  controlRoot: string;
  steerInboxDir: string;
  actionControlDir: string;
  transcriptPath?: string;
  transcriptRoot?: string;
  sessionFile?: string;  // ← NEW
  updatedAt: number;
}
```

**File**: `src/runs/foreground/execution/run-single-attempt.ts`

Pass `sessionFile: options.sessionFile` when constructing the
`ForegroundLiveChild` object (around line 82 where `registerForegroundLiveChild`
is called, and in the `stateOptions`/`onDetachedExit` block).

### 2. run-single-attempt.ts — make persistent unconditional

Remove `const persistent = options.persistentChildren === true;` and all
`if (persistent)` / `if (persistent && registry)` guards. The RPC path
becomes the only path:

- `baseArgs` always `["--mode", "rpc"]`
- `mode` always `"rpc"`
- `stdio` always `["pipe", "pipe", "pipe"]`
- Registration/close logic always runs (no `if (persistent)` checks)
- `state.rpcWrite` is always available

### 3. target-model.ts — fromForeground passes sessionFile

In the `foregroundLiveChildren` loop, include `sessionFile: child.sessionFile`
in the `SteerViewTarget`. This lets `resolveChildChannel` use the session
file for reopen when the resident process is gone.

### 4. child-channel.ts — resolveForeground picks up sessionFile

`resolveForeground` already checks `target.sessionFile` after
`getForegroundResident` returns undefined. With sessionFile now populated
from `foregroundLiveChildren`, this path works for all foreground targets.

### 5. Config cleanup

**File**: `src/extension/config.ts`

- Remove `persistentChildren` from `ExtensionConfig` interface (or keep as
  deprecated no-op)
- Remove `ResolvedPersistentChildConfig` / `resolvePersistentChildConfig`
- Remove `DEFAULT_PERSISTENT_CHILD_CONFIG`

**File**: `src/extension/index.ts`

- Remove the `config.persistentChildren` default injection
- Remove `resolvePersistentChildConfig` usage in eviction timer
- Keep eviction timer (always runs, since all children are RPC)
- `PI_SUBAGENT_E2E_JSON_CHILD` env var in tests still works for testing
  the JSON fallback (but product code ignores it)

### 6. Options cleanup

**File**: `src/shared/types/options-types.ts`

- `RunSyncOptions.persistentChildren` stays as a type (test code passes it)
- Default logic in callers that sets `persistentChildren: true` becomes no-op
- Async runner (`run-single-step-helpers.ts`, `chain-execution.ts`, etc.)
  can stop passing `persistentChildren` — RPC is always on.

### 7. Test impact

- E2E test uses `PI_SUBAGENT_E2E_JSON_CHILD` to force JSON mode — keep that
  env var around; the test exercises the JSON path, which still works.
- Unit tests for `run-single-attempt.ts` that pass `persistentChildren: false`
  should be unaffected (the option is ignored).
- Integration tests that depend on JSON mode behavior need updating.

## Validation

- `npm run test:unit` — all pass
- `npm run test:integration` — existing pass rate maintained
- Manual smoke: foreground subagent → `/subagents` → select → host-editor mode

## Risk / Rollback

- `persistentChildren` being ignored is low-risk (all production paths already
  default to `true`; the JSON path was a legacy fallback).
- If JSON mode is needed for debugging, set `PI_SUBAGENT_E2E_JSON_CHILD=1`.