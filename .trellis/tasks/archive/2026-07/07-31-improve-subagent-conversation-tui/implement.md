# Implementation Plan: Persistent RPC Execution Children

Companion to `design.md` (Option B). Ordered phases; each phase ends with a
green test suite before the next begins. Rollback point after phase 2: the
`subagents.persistentChildren` toggle restores the legacy json path.

## Phase 1 — RPC child launch plumbing (shared, no behavior change yet)

Goal: `buildPiArgs` can emit `--mode rpc` args and a spawn can deliver the task
over RPC stdin, without changing what any runner does today.

- [ ] `src/runs/shared/pi-args.ts`: add `mode: "json" | "rpc"` input; RPC mode
      emits `--mode rpc` (no `-p`), skips positional task text, keeps
      `--session`/`--no-session`/flags; ensure `@file` path never used in RPC.
- [ ] New `src/runs/persistent/rpc-protocol.ts`: LF-only JSONL writer/reader
      (NOT `readline`; verified `rpc.md:20-37`), request-id correlation,
      bounded write queue with `drain` backpressure.
- [ ] New `src/runs/persistent/rpc-child-registry.ts`: registry keyed by
      runId+index / asyncRunId+stepIndex+agent; one entry per key; resident
      child handle type with `writeLine`, `settled`, `close()`.
- [ ] `src/shared/child-transcript.ts`: tolerate `response`, `agent_settled`,
      `extension_ui_request`, `queue_update`, `compaction_*`, `auto_retry_*`
      records (discriminate from agent events, no crash, minimal records).
- [ ] Unit tests: pi-args mode selection; rpc-protocol framing/backpressure;
      registry invariants; transcript tolerance for new record types.
- [ ] Validate: `npm run test:unit`.

## Phase 2 — Foreground runner: settle-driven completion with resident child

Goal: a foreground child finishes at `agent_settled`, keeps its process, and
the existing `SingleResult` finalization is unchanged.

- [ ] `run-single-attempt.ts`: switch default launch to RPC mode; send initial
      task prompt over stdin after spawn; wire RPC response/event parsing.
- [ ] `single-attempt-state.ts` + `single-attempt-events.ts`: add
      `agent_settled` handling → mark settled, park process in registry,
      run `finalizeSingleAttempt` without closing the process.
- [ ] `single-attempt-process.ts`: keep close-handler I/O flush; make
      finalization conditional on settled state; timeout/budget/interrupt
      paths call RPC `abort` then graceful child close (run failed).
- [ ] `single-attempt-finalize.ts`: no behavioral change (already pure given
      state); verify it runs at settled time.
- [ ] `run-sync.ts`: accept `persistentChildren` toggle; expose `sessionFile`
      on result as today; when toggle off, legacy json path unchanged.
- [ ] Integration tests: foreground RPC child completes → settled → result
      correct → process resident → ordinary prompt reaches child → parent
      untouched → evict → session valid.
- [ ] Validate: `npm run test:unit && npm run test:integration`.

## Phase 3 — Async runner: settle-driven completion with resident child

Goal: async children also persist; step results resolve at `agent_settled`.

- [ ] `run-pi-streaming.ts`: RPC mode spawn (stdin pipe); replace
      final-drain/SIGTERM/SIGKILL completion with `agent_settled` + bounded
      terminal-stop watchdog; resolve `RunPiStreamingResult` at settled.
- [ ] `run-single-step.ts` + helpers: launch RPC; keep timeout/budget/interrupt
      as process-abort paths; registry entry per step; finalization unchanged.
- [ ] `runner-finalize.ts` / async status: no change to result semantics;
      resident child cleaned at run finalization when no viewer holds it.
- [ ] Tests: async RPC child settle semantics; timeout/budget still terminate;
      existing async suite green via toggle default.
- [ ] Validate: `npm run test:unit && npm run test:integration && npm run test:e2e` (e2e as feasible).

## Phase 4 — Interactive viewer: host-editor routing over the resident child

Goal: selected child conversation uses the real host editor + RPC child.

- [ ] `src/tui/steer-view/`: keep overlay entry; add child-conversation mode
      that mounts a read-only transcript widget above the host editor
      (`ctx.ui.setWidget` component factory) instead of the capturing overlay.
- [ ] `pi.on("input")` handler (extension index): gate on active child mode;
      ordinary text → RPC prompt (steer while streaming) → `{ handled }`;
      single `/` stays parent; `!bash` stays parent; else `continue`.
- [ ] `//name` routing: `get_commands` cache + validation; RPC prompt execution;
      `extension_ui_request` rendering (notify toast; select/confirm/input/
      editor correlated dialogs); unsupported `custom()` → explicit notice.
- [ ] Exit/switch: `/subagents` subcommands (exit, target <n>) + viewer
      keybinding; no Escape overloading; editor text/focus preserved.
- [ ] Compatibility spike: Zentui fixed-editor compositor + widget coexistence.
- [ ] Tests: input-routing unit tests; integration test for handled/continue
      matrix; widget mount/removal; DCP `//dcp` + unavailable-DCP case.
- [ ] Validate: `npm run test:unit && npm run test:integration`.

## Phase 5 — Eviction, shutdown, crash recovery, docs

- [ ] Eviction: idle expiry, registry cap, target switch parking, parent
      `session_shutdown` handler; graceful close (cancel dialogs → stdin EOF →
      bounded grace → SIGTERM/SIGKILL).
- [ ] Crash recovery: RPC child crash mid-conversation → recoverable viewer
      error, session preserved, read-only fallback.
- [ ] Reopen: evicted settled child reopened via `--session` bridge guarded by
      registry; no concurrent writers; session branch validity test.
- [ ] Config: `subagents.persistentChildren` (default true) + eviction
      settings; backward-compatible defaults.
- [ ] Docs: README/CHANGELOG; truthful extension-compatibility matrix
      (renderers, widgets, custom editors, whole-surface TUI replacements).
- [ ] Validate: full `npm run test:all`; manual TUI smoke with DCP + zentui.

## Risky files / rollback points

- `src/runs/shared/pi-args.ts` — launch args for every child; toggle must be
  honored before any RPC args are constructed.
- `src/runs/foreground/execution/run-single-attempt.ts` + `single-attempt-*.ts`
  — settle-vs-close completion; rollback = toggle off.
- `src/runs/background/runner/run-pi-streaming.ts` — drain/kill replacement.
- `src/extension/index.ts` (input handler) + `src/tui/steer-view/` — viewer.
- `src/runs/persistent/rpc-child-registry.ts` — new module; the single owner
  of child lifecycle.

## Decided scope notes

- Intercom detach (2026-07-31): MVP keeps the detach path terminating the RPC
  child (abort + graceful shutdown); no RPC-channel handoff to the intercom
  consumer. Documented, deferred to a future iteration.
- Decided at review (2026-07-31): idle eviction default 15 min,
  `subagents.eviction.idleMs`; resident-child cap default 4,
  `subagents.eviction.maxResidentChildren`; keep `subagents.persistentChildren`
  toggle (default true). All keys are config-file-adjustable with
  backward-compatible defaults.

## Validation commands

- `npm run test:unit` — after every phase.
- `npm run test:integration` — phases 2+.
- `npm run test:e2e` — phases 3+ (subset if environment-bound).
- Manual: `/subagents` picker → child conversation → steer → `//dcp` →
  target switch → exit → parent editor intact; then shutdown with resident
  children and verify session files parse cleanly.

## Follow-up before `task.py start`

- Confirm open options in design.md (idle window, cap, toggle, detach).
- AC mapping: each phase must cite which ACs it closes (AC1–AC9).
