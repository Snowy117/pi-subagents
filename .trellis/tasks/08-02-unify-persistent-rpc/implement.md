# Implementation Plan: Unify child mode to persistent RPC

Phases ordered to minimize risk. Each ends green (`npm run test:unit`).

## Phase 1 — ForegroundLiveChild gets sessionFile

- [ ] `src/shared/types/async-types.ts`: add `sessionFile?: string` to `ForegroundLiveChild`
- [ ] `src/runs/foreground/execution/run-single-attempt.ts`: find the `registerForegroundLiveChild` call and the `stateOptions` block, pass `sessionFile: options.sessionFile`
- [ ] `src/tui/steer-view/target-model.ts` `fromForeground`: in the `foregroundLiveChildren` loop, include `sessionFile: child.sessionFile`
- [ ] Verify: `resolveChildChannel` → `resolveForeground` → `target.sessionFile` is now populated for live children
- Validate: `npm run test:unit`

## Phase 2 — Make persistent unconditional in run-single-attempt

- [ ] `src/runs/foreground/execution/run-single-attempt.ts`:
  - Remove `const persistent = options.persistentChildren === true;`
  - `baseArgs` always `["--mode", "rpc"]`
  - `mode` always `"rpc"` (remove `mode: persistent ? "rpc" : "json"`)
  - `stdio` always `["pipe", "pipe", "pipe"]`
  - Remove `if (persistent)` guards around registration/close logic (lines 250, 288, 303)
  - Remove `if (persistent && registry)` — `registry` is always present
  - Remove `state.rpcWrite` conditional — always available
  - Keep `state.rpcWrite` for the initial prompt delivery
- Validate: `npm run test:unit`

## Phase 3 — Config cleanup

- [ ] `src/extension/config.ts`:
  - Remove `persistentChildren` from `ExtensionConfig` (or mark deprecated)
  - Remove `ResolvedPersistentChildConfig` interface
  - Remove `DEFAULT_PERSISTENT_CHILD_CONFIG`
  - Remove `resolvePersistentChildConfig` function
  - Keep `eviction` config for backward compat (no-op)
- [ ] `src/extension/index.ts`:
  - Remove `config.persistentChildren` default injection (lines 85-88)
  - Remove `resolvePersistentChildConfig` import and usage in eviction timer
  - Keep eviction timer — always runs with defaults
- [ ] `src/runs/foreground/execution/subagent-executor.ts`: remove `resolvePersistentChildConfig` usage if any
- Validate: `npm run test:unit`

## Phase 4 — Async runner cleanup

- [ ] `src/runs/background/runner/run-single-step-helpers.ts`: remove `const persistent = ctx.persistentChildren === true;` — RPC is always on
- [ ] `src/runs/background/runner/run-single-step.ts`: remove `ctx.persistentChildren === true` argument
- [ ] `src/runs/background/runner/runner-step-sequential.ts`: remove `persistentChildren: state.config.persistentChildren`
- [ ] `src/runs/background/runner/runner-step-parallel.ts`: remove `persistentChildren: state.config.persistentChildren`
- [ ] `src/runs/background/async-execution/single-execution.ts`: remove `persistentChildren: params.persistentChildren === true ? true : undefined`
- [ ] `src/runs/background/async-execution/chain-execution.ts`: same
- Validate: `npm run test:unit && npm run test:integration`

## Phase 5 — Regression sweep

- [ ] `npm run test:all` (unit + integration + e2e)
- [ ] Manual smoke: run foreground subagent → `/subagents` → select → host-editor mode (not read-only)
- [ ] Manual smoke: async subagent → `/subagents` → select → host-editor mode

## Risky files / rollback

- `src/runs/foreground/execution/run-single-attempt.ts` — core change; rollback = git revert
- `src/extension/config.ts` + `index.ts` — config removal; rollback = restore config processing
- `src/shared/types/async-types.ts` — additive only; no rollback needed