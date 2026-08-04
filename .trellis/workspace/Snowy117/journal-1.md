# Journal - Snowy117 (Part 1)

> AI development session journal
> Started: 2026-07-08

---

## 2026-07-09 — Chunk R3: split run-single-attempt.ts (931→196 + 7 modules)

Resolved the previously-accepted `runSingleAttempt` R1 residual (C10) via
user-authorized shared-state-object extraction. The 931-line single async
function had ~21 inline closures sharing ~20-30 mutable spawn-state locals.

Approach: extracted the closures into 7 cohesive sibling modules under
`execution/`, all closing over ONE `SingleAttemptState` reference so mutations
propagate identically (R2). Main `runSingleAttempt` stays ONE function
(orchestrator). No await / handler-registration-order / mutation-order change.

Result: all 8 files ≤300 (max 249). Integration single-execution 81/81,
full integration 461/467 (baseline exact), unit 986/989 (3 fail = pre-existing
subagent-prompt-runtime isolation noise, proven pre-existing on clean tree).
windows-hide-spawn test still passes without path change (spawn guard regex
matches the main file). Export parity 1/1.



## Session 1: Split all oversized TS files to ≤300/≤500 lines via barrel + shared-state extraction

**Date**: 2026-07-09
**Task**: Split all oversized TS files to ≤300/≤500 lines via barrel + shared-state extraction
**Branch**: `main`

### Summary

Refactored pi-subagents so every src file is ≤300 lines and every test file ≤500 lines, behavior identical. Split 37 oversized src files + 17 oversized test files across 14 chunks dispatched to trellis-implement subagents. Core technique: barrel re-export hubs (export *) so zero importers change. Two giant closure-heavy functions (runSubagent 1909→87, runSingleAttempt 931→196) split via shared-state-object extraction preserving concurrent control flow byte-for-byte. A 62-private-field class (chain-clarify-component 1159→226) split via method extraction with private→public relaxation (TS private erased at runtime). All 6 initial residuals resolved. Final: unit 989/989, integration 461/467 (6 pre-existing slash failures), LSP 0 (resolved 12 pre-existing type errors as a bonus). Recorded barrel pattern, 300/500 line budget, and shared-state extraction in spec.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `895598c` | (see git log) |
| `63f9d4d` | (see git log) |
| `310206a` | (see git log) |
| `82ca035` | (see git log) |
| `278cb6e` | (see git log) |
| `d03ae93` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: 修复 apply_patch 变更检测

**Date**: 2026-07-22
**Task**: 修复 apply_patch 变更检测
**Branch**: `main`

### Summary

将 apply_patch 纳入共享 mutation 工具分类，并让 completion guard 复用同一判断；补充回归测试，完整单元测试 991/991 通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ecafb0d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Wake wait on blocking supervisor requests

**Date**: 2026-07-30
**Task**: Wake wait on blocking supervisor requests
**Branch**: `main`

### Summary

Implemented event-driven supervisor attention for the pi-subagents wait tool: wait now subscribes to INTERCOM_DETACH_REQUEST_EVENT with subscribe-then-reconcile, queries a read-only lifecycle-refreshed actionable-request source filtered to exact initial run IDs, and returns transport-aware reply instructions. Added the additive replyTransport: pi-intercom discriminator with duplicate-message suppression and native action filtering; pi-intercom now writes native receipts only after broker delivery and cleans them up on all ask-exit paths, with test environment isolation for the bridge variables. Verified via trellis-check: 1000/1000 unit, focused integration green, pi-intercom 36/36; six pre-existing slash-command integration failures reproduced on baseline and are unrelated.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `50cbf65` | (see git log) |
| `838ecc5` | (see git log) |
| `f12499c` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: Interactive subagent control view

**Date**: 2026-07-31
**Task**: Interactive subagent control view
**Branch**: `main`

### Summary

Upgraded Pi to 0.82.1 and added an interactive TUI picker and full child chat view with async and foreground steering, semantic child thinking controls, safe live transcripts, plugin-compatible slash and Down entry, documentation, executable specs, and full tests.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `49375e6` | (see git log) |
| `9a026c2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete

## 2026-07-31 — Phase 1+2: persistent RPC execution children (foreground)

### Work Done

- **Phase 1 (launch plumbing)**: `buildPiArgs` gains `mode: "json"|"rpc"` (RPC: `--mode rpc`, no `-p`, no positional task/`@file`); new `rpc-protocol.ts` (LF-only JSONL write w/ drain backpressure + line reader w/ 16MB record cap, NOT readline); new `rpc-child-registry.ts` (one-writer registry + graceful/force closer: cancel dialogs → stdin EOF → SIGTERM → SIGKILL); `child-transcript.ts` tolerates `rpc_control` records (response/agent_settled/extension_ui_request/queue_update/compaction_*/auto_retry_*).
- **Phase 2 (foreground settle-driven)**: `runSingleAttempt` launches `--mode rpc` when `options.persistentChildren`; spawns stdin `["pipe",...]`, sends initial `prompt` over stdin, registers `PersistentRpcChild` in registry. `agent_settled` event → `state.finish(0)` → finalize (process stays resident); failed/stopped runs evict via `unregister` + graceful close. `startFinalDrain` disabled for RPC mode. close-handler: settled → only stdio flush, no error injection (after detached branch). `SingleResult.residentChild` flag set on settled success; `runSync` skips `markLiveTranscriptTerminal` when residentChild.
- Config: `resolvePersistentChildConfig(config)` in `src/extension/config.ts` (default enabled:true, idleEvictionMs 15min, maxResidentChildren 4; boolean or object form `{enabled, eviction:{idleMs,maxResidentChildren}}`); `ExtensionConfig.persistentChildren` field added; `extension/index.ts` injects `persistentChildren: {enabled:true}` default into loaded config (product default) and creates per-activation `createRpcChildRegistry()` passed via ExecutorDeps; `session_shutdown` calls `registry.closeAll("graceful")`. `buildSingleRunSyncOptions` injects `persistentChildren` (only when config field present) + registry into RunSyncOptions.
- mock-pi-script.mjs: RPC mode support (`--mode rpc` → read JSONL commands from stdin, respond `response` + events + `agent_settled`, stay resident until stdin EOF; plain `output` responses get default assistant message; waits for pending handlers before EOF exit).

### Testing

- Unit: 1077 pass (rpc-protocol 8, rpc-child-registry 6, pi-args RPC 5, child-transcript RPC 2, tui-config persistent 4).
- Integration: new `foreground-rpc-child.test.ts` (5 tests: resident-after-settle, task-over-stdin+mode arg, evictIdle, json-mode-no-registry, executor-config-injection) all pass.
- Baseline integration suite has pre-existing failures: slash-commands-message-delivery (6 tests, fails even on clean HEAD) + async-execution-dynamic timeout test (flaky under full-suite concurrency, passes standalone 3/3). Not caused by Phase 1-2.

### Next Steps

- Phase 3: async runner (`run-pi-streaming.ts`, `run-single-step.ts`) settle-driven RPC completion.
- Phase 4: viewer (steer-view host-editor routing, `//name` RPC command routing, input handler).
- Phase 5: eviction timers, crash recovery, reopen, docs.

## 2026-07-31 — Phase 3: async runner settle-driven RPC completion

### Work Done

- `runPiStreaming` gains `persistent?: boolean` + `registry?` params: RPC mode spawns stdin pipe, sends initial prompt, `agent_settled` → `finishResolve` (step result finalized, process stays resident, registered in runner-process registry); `close`/`error` handlers use `finishResolve` (no double-resolve). `RunPiStreamingResult.residentChild` flag. Failed settle evicts (unregister + graceful close).
- `buildStepPiArgs` (run-single-step-helpers) honors `ctx.persistentChildren` (RPC mode args).
- `SubagentRunConfig` + `SingleStepContext` gain `persistentChildren`/`persistentChildRegistry`.
- `runSubagent` (runner process entry) creates a runner-scoped `createRpcChildRegistry()` when persistentChildren; closes all gracefully before runner exit. **Key architecture fact: async children are spawned inside a separate runner process, so their RPC registry lives in that process, not the parent.** Parent-side viewer access is Phase 4 cross-process work.
- `AsyncChainParams`/`AsyncSingleParams` gain `persistentChildren`; chain-execution + single-execution pass it into `spawnRunner` cfg.
- Executor injection: async-path, chain-path, parallel-path-helpers, async-resume (uses `input.deps.config` — NOT `deps`), single-path pass `persistentChildren: deps.config.persistentChildren === undefined ? undefined : resolvePersistentChildConfig(deps.config).enabled` to executeAsyncChain/executeAsyncSingle. Fixed `deps is not defined` ReferenceError in async-resume.

### Testing

- Unit 1077 pass.
- New async integration tests (async-execution-single.test.ts): RPC mode arg + settle-without-exit (keepAlive) — 2 tests, pass.
- Full integration: 488 tests / 481 pass / 7 fail. Remaining failures = pre-existing baseline (slash-commands-message-delivery 6 tests fail even on clean HEAD; async-execution-dynamic timeout test flaky under suite concurrency, passes standalone). Intercom grouped/revival failures fixed (async-resume deps bug). No new regressions.

### Next Steps

- Phase 4: interactive viewer — steer-view host-editor routing (transcript widget above real editor via `ctx.ui.setWidget`), `pi.on("input")` handler gating on active child mode returning `{action:"handled"}`, `//name` RPC command routing via get_commands + extension_ui_request rendering, exit/switch commands.
- Phase 5: eviction timers (idle/overflow/session_shutdown — registry already wired), crash recovery, session reopen, config docs, README.

## 2026-07-31 — Phase 4: interactive host-editor routing viewer

### Work Done

- NEW `src/tui/steer-view/host-editor-mode.ts`: `createHostEditorConversation` — child-conversation mode that keeps the real Pi editor mounted, mounts a read-only transcript widget above it via `ctx.ui.setWidget()` (`HOST_EDITOR_WIDGET_KEY = "subagents-child-conversation"`), and routes ordinary submissions to the selected child's RPC process through `routeInput`:
  - `!bash` and single `/` → `{action:"continue"}` (parent-owned);
  - `//name args` → RPC `prompt: "/name args"` (child command), `{action:"handled"}`;
  - ordinary text → RPC `prompt` with `streamingBehavior` passthrough, `{action:"handled"}`.
  - Widget renders bounded read-only tail via `readTranscriptFallback`.
- `extension/index.ts`: creates `getResidentChild` (maps `foreground:runId:index` target key → registry `runId/index`; async children live in runner process → Phase 5 bridge); creates `hostEditorConversation`; registers `pi.on("input")` handler gated on `hostEditorConversation.active`; passes hostEditor+getResidentChild into `createSteerViewRuntime`; `/subagents exit` via `registerSlashCommands(pi, state, controller, hostEditor)`; session_shutdown closes host-editor + registry.closeAll; runtimeCleanup disposes conversation.
- `open-view.ts`: `SteerViewControllerOptions` gains `hostEditor`/`getResidentChild`; `showChat` activates host-editor mode when resident child exists (returns `{kind:"picker"}` synchronously, notify banner); picker filter shows `target.active || getResidentChild(target)` so settled resident children are selectable; `open()` loop exits when hostEditor.active matches target.
- `registration.ts`: `createSteerViewRuntime(state, config, options)` passes hostEditor/getResidentChild to controller.
- `registration.ts` (slash): `/subagents exit|close` closes host-editor mode + notify.

### Testing

- Unit: 1083 pass (new host-editor-mode.test.ts 6 tests: inactive→open, reject-no-resident, ordinary routing, //name routing, slash/!bash parent-owned, close-stops-routing).
- Integration: steer-view-entry.test.ts +2 (exit command, picker activation) — 7/7.
- Full suite: 490/483/7 = baseline failures only (slash-commands-message-delivery 6 pre-existing + async-execution-dynamic timeout flaky). No new regressions.

### Next Steps

- Phase 5: idle-eviction timer + overflow eviction wiring in extension runtime, crash recovery (RPC child crash → viewer error + read-only fallback), session reopen via --session bridge (guarded), config docs + README (persistentChildren/eviction keys), CHANGELOG.

## 2026-07-31 — Phase 5: eviction, crash recovery, reopen, docs

### Work Done

- `extension/index.ts`: eviction loop (every 60s, `resolvePersistentChildConfig(config)` → `evictIdle(idleEvictionMs)` + `evictOverflow(maxResidentChildren)`; config changes take effect next tick; timer cleared in runtimeCleanup). Reopen bridge: `createReopenBridge` (registry guard — never reopens while a resident entry exists; rebuilds minimal `--mode rpc --session <path>` args; original per-child flags not retained post-eviction).
- NEW `src/tui/steer-view/reopen-bridge.ts`: `createReopenBridge({registry, getChildLaunchArgs, cwd, env})` → `reopen(target)` returns resident child or undefined; `close()` → closeAll graceful. Fixed TDZ (assign `resident.close = createRpcChildCloser(resident, {})` after object creation).
- `host-editor-mode.ts`: crash recovery — on `resident.closed` while active, auto-close mode so input routing returns to parent (parent never torn down by child crash).
- Docs: README new section "Persistent children and direct conversation (Option B)" (host-editor routing, //name, /subagents exit, eviction settings JSON example with defaults idleMs 900000 / maxResidentChildren 4 / enabled true); CHANGELOG [Unreleased] Added entry.

### Testing

- Unit: 1086 pass (new reopen-bridge.test.ts 3 tests: fresh reopen, one-writer guard reuse, no-session-file undefined).
- Integration: 490/482/8 = baseline + flaky only (slash-commands-message-delivery 6 pre-existing, async-execution-dynamic timeout flaky, fork-context-async-preflight flaky — both pass standalone 9/9). No new regressions across Phases 1-5.

### Status

All 5 phases complete. Remaining for finish: trellis-update-spec, commit, then check subagent dispatch.

## 2026-07-31 — trellis-check round 1 fixes

### Work Done

Dispatched `trellis-check` subagent (run cc3b75e1) after Phases 1-5. Findings fixed:

- **BLOCKER-1** (async RPC empty prompt): `runPiStreaming` now takes an explicit `task` parameter (passed by `runSingleStep`); RPC prompt uses it instead of scraping argv for "Task: " (which RPC mode never embeds). Added mock rpcPrompts recording + async test assertion that stdin prompt contains the task text (regression guard).
- **MAJOR-2** (R6/AC8 //name + UI relay): `host-editor-mode.ts` rewritten — `refreshCommands` performs `get_commands` with request-id correlation + TTL cache (30s) + bounded 2s wait; unknown `//name` → visible "unavailable" notice, never a prompt; stdout streamed for `extension_ui_request` relay (`notify` → viewer notice). Tests updated: //name validates-then-executes, unknown rejected, notify relayed.
- **MAJOR-4** (detach leak): `run-single-attempt.ts` detached branch now unregisters + writes `{type:"abort"}` + graceful close of the resident RPC child (decided 2026-07-31 contract).
- **MEDIUM-5** (async final drain): `run-pi-streaming.ts` `startFinalDrain` returns early when `persistent`.
- **MEDIUM-6** (concurrent writer on retry): failed settle in run-pi-streaming evicts and resolves the step only after graceful close completes (`.then(() => finishResolve)`), keeping the session single-writer.
- **LOW-7**: close-handler settled early-return moved before error injection (`state.settled && !state.detached`).
- **LOW-8**: eviction loop re-reads config via `loadConfig()` each 60s tick (dynamic changes take effect).
- **LOW-9**: reopen args now include `--extension PROMPT_RUNTIME_EXTENSION_PATH` (exported from pi-args); comment corrected to not claim full flag retention.
- **LOW-10**: `rpc-protocol.ts` adds `stdin.on("error", noop)` + `safeWrite` try/catch (dead-child writes never crash the host).

**Gotcha found during verification**: `await` inside the synchronous `processStdoutLine` in run-pi-streaming is a ParseError (strip-types) — the failed-settle close must be `.then()`-chained, not awaited inline. Runner stderr log (`runner.stderr.log`) exposed the exact error.

### Testing

- Unit 1088 pass; async-execution-single 13/13; host-editor 8/8; e2e re-verified.
- MAJOR-3 (async resident unreachable from viewer) accepted as documented limitation (runner-process registry; cross-process bridge deferred per design).

## 2026-07-31 — trellis-check round 2 fixes

### Work Done

Second trellis-check (run 6c5cfa80) confirmed all 9 round-1 defects fixed, found 3 new:
- **A (LOW)**: `refreshCommands` timeout leaked a stdout listener and cached the empty timeout result for 30s (real commands reported "unavailable" after a slow response). Fixed: `finish(names, cache)` — timeout/no-stdout path returns empty WITHOUT caching and removes the listener; only a real correlated response populates the cache.
- **B (MEDIUM)**: `lastActivityAt` never refreshed by viewer activity — idle/cap eviction could evict the child being conversed with, dropping the next routed input. Fixed: `routeInput` touches `resident.lastActivityAt`; eviction loop skips the active viewer target (`evictIdle`/`evictOverflow` gained `{ except?: string }`; index.ts computes the active resident key from `hostEditorConversation.targetKey`).
- **C (LOW)**: failed-settle race resolves via close-handler (exitCode 0 + error) — downstream compensates; added integration test asserting failed settle → step failed + error (async-execution-single 14/14).

### Testing

- Unit 1092 pass (rpc-child-registry +2 except tests, host-editor 8).
- async-execution-single 14/14 (incl. new failed-settle eviction test).
- Integration/e2e re-verified; baseline failures only (slash 6 pre-existing).

## 2026-07-31 — trellis-check round 3 fixes

### Work Done

Third trellis-check (run 7aea91e2) confirmed round-2 fixes A/B/C correct, no blockers. One MEDIUM found (pre-existing since Phase 4):
- **Target switch while host-editor mode active did not switch** (open-view.ts): `showChat` now closes the old host-editor conversation before opening a new target (`if (hostEditor.active && targetKey !== target.key) close(ctx)`); the open() loop exits whenever `hostEditor.active` (not only when the same target is re-selected). `controller.open()` is re-entrant, so a second `/subagents` reopens the picker and switching works. Added integration test (8/8 steer-view-entry).
- Also added refreshCommands timeout-path unit test (9/9 host-editor-mode): after a 2s get_commands timeout, a later `//name` re-sends get_commands (empty timeout result is not cached).

### Testing

- Unit 1092+; steer-view-entry 8/8; host-editor-mode 9/9; integration/e2e re-verified; baseline failures only (slash 6 pre-existing).

## 2026-07-31 — trellis-check round 4 + final

### Work Done

Fourth trellis-check (run f70f4a45) verified target-switch fix + timeout test correct, no new defects, and stated no further review rounds needed. Two non-blocking suggestions also fixed:
- **Same-key re-select**: `open-view.ts` showChat returns `{kind:"picker"}` early when re-selecting the active host-editor target (no-op, avoids falling into the overlay chat).
- **Stale refresh race**: `host-editor-mode.ts` refreshCommands records the requesting resident key; `finish` only writes `commandCache` when `currentResident?.key === requestingKey` (a stale get_commands resolving after target switch cannot poison the active child's cache).

### Testing

- Unit 1091/1091; e2e 2/2 (first run occasionally flaky); integration 492/482/10 = 6 pre-existing slash + 4 async/result-watcher flakes (all pass standalone 33/33).
- 4 review rounds complete: round 1 (9 defects), round 2 (3 new), round 3 (1 medium target-switch), round 4 (clean, no further rounds needed). All fixed and verified.

### Status

Implementation + verification complete. Next: commit (Phase 3.4), then /trellis:finish-work.


## Session 5: Simplify subagent params: remove chain, acceptance, clarify, share, budget/timeout/cwd overrides

**Date**: 2026-08-01
**Task**: Simplify subagent params: remove chain, acceptance, clarify, share, budget/timeout/cwd overrides
**Branch**: `main`

### Summary

Massive parameter cleanup: removed chain, acceptance, clarify, share, toolBudget/turnBudget/timeoutMs/cwd/sessionDir/control/output/agentScope overrides. Unified dispatch via tasks:[{agent,task}]. Retained 16 dispatch params and 6 TaskItem fields. 127 files changed, 11385 lines removed, 460 inserted.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0be079a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: Subagents native view parity: host editor + host rendering

**Date**: 2026-08-02
**Task**: Subagents native view parity: host editor + host rendering
**Branch**: `main`

### Summary

Unified child conversation: full-height native-component assembler widget (user/assistant/toolCall↔toolResult/custom/bash, settings-faithful), host-editor routing for foreground AND async (runner conversation bridge: requests inbox + stdout relay + heartbeat linger), resolveChildChannel single sync/async branch point, child-mode app-key routing (Esc abort, model/thinking cycle+select, tools expand — follows keybindings.json), degraded overlay native-rendered, compile target 0.83.0. Unit 1113/1113; integration 0 new failures (122 baseline from archived simplify-subagent-params).

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `902cd5b` | (see git log) |
| `edc3fba` | (see git log) |
| `f0347ff` | (see git log) |
| `364a135` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: Fix persistent subagent startup and TUI rendering

**Date**: 2026-08-02
**Task**: Fix persistent subagent startup and TUI rendering
**Branch**: `main`

### Summary

Fixed idle foreground parallel RPC children, restored immediate running tool animation and completion, routed native child components through the real widget TUI to prevent requestRender crashes, added regression coverage, and documented the cross-layer RPC/TUI contracts.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `1a578dd` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete

---

## 2026-08-02 — simplify-subagent-experience archived

- **Result**: Archived `08-02-simplify-subagent-experience` → `archive/2026-08/` (commit `8d70594`).
- **Implementation commit**: `131bac8` `feat(subagents): simplify and unify subagent experience`.
- **Verification**: `npm run test:unit` 1136/1136 pass; `npm run test:integration` 184/184 pass (one initial flaky failure, not reproduced on two reruns).
- **Preserved**: unrelated `.pi/settings.json` worktree change left uncommitted per PRD constraint.


## Session 8: Fix TUI lag while subagents run

**Date**: 2026-08-04
**Task**: Fix TUI lag while subagents run
**Branch**: `main`

### Summary

Researched and fixed periodic TUI lag during subagent runs. Root cause: subagent activity drove high-frequency full-tree TUI re-renders (80ms spinner animation = 12.5fps, 250ms async poller, per-event renders) plus O(transcript) work per frame (getFinalOutput) and per-event messages copies. Fixed: lazy getFinalOutput while running, messages-less per-event snapshots (final keeps them), animation 80->200ms, async tracker poll 250->500ms with widget render throttle (sticky dirty flag), slash child-view rebuild throttle (version-change or <=1/500ms), steer view skips idle requestRender. All 1139 unit tests + async-job-tracker/foreground/slash/render/steer integration suites green. Spec updated with TUI render-frequency contract and strip-mode test conventions.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ffb4ec9` | (see git log) |
| `db2be90` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
