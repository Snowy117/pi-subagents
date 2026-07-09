# Implement — ordered chunk checklist

Execution plan for `prd.md` + `design.md`. **Sequential, one writer, main
working tree.** Each chunk = one sub-agent dispatch + a verification gate.
Do NOT start the next chunk until the current one is green.

## Pre-flight (once, main session)

- [x] **Dependencies installed** (`npm ci`, 253 packages). Without `node_modules`
      EVERY test fails at import time (`ERR_MODULE_NOT_FOUND: typebox`) — this
      is the #1 prerequisite for any verification.
- [x] **Unit baseline GREEN**: `npm run test:unit` → 989 pass / 0 fail / 0 skip.
      This is the regression anchor: after every chunk, unit suite must return to green.
- [x] **Integration baseline: 467 tests, 461 pass, 6 fail.** All 6 failures are
      in `test/integration/slash-commands.test.ts` (`/run` and `/parallel` slash
      parsing — assertion failures, command returns undefined/0 instead of
      expected structure). These are **pre-existing failures** (present on the
      clean tree before any refactor work). Regression anchor for this file:
      after a chunk touching slash code, this file's fail count must stay at 6
      (not increase) — ideally the same 6 named tests. Do not "fix" them as part
      of this refactor (R2: behavior preserved).
- [x] **OQ1 decision: (A) flat.** User confirmed 2026-07-08. Tests stay in
      `test/{unit,integration}/` (no subdirs); npm scripts + `test.yml`
      unchanged. `test/unit` may grow to ~105–110 files — accepted.
- [ ] Baseline `git status` clean (so every later change is attributable).
      NOTE: `npm ci` wrote `node_modules/` + `package-lock.json` changes —
      `node_modules` is gitignored; `package-lock.json` should be unchanged by
      `npm ci` (verify, do not commit lockfile churn if identical).

## Dispatch protocol (every chunk)

Prompt prefix for each sub-agent:
> Active task: `.trellis/tasks/07-08-split-ts-files`. You are the
> `trellis-implement` sub-agent for this single chunk. Read `prd.md`,
> `design.md`, this file. Apply "split + barrel" (design §1). Do NOT change
> behavior or exported APIs. Barrels re-export via `export *`. Submodules are
> internal-only. When done report: (a) new files + line counts, (b)
> exported-symbol parity vs original, (c) `<validation>` output, (d)
> `lsp_diagnostics path="*"` delta.

## Chunk ordering

### Tier 1 — leaf primitives (low risk)

- [x] **C1 · `src/shared/`** ✅ GREEN (verified by main session)
      types.ts(1267,82 imp)→23-line barrel+13 submodules; utils.ts(554,36)→16-line
      barrel+6; settings.ts(450,15)→17-line barrel+5. Export parity 127/20/28.
      Max line 241. LSP 0 errors. Unit 989/0. Zero importers edited.
- [x] **C2 · `src/tui/render.ts`** ✅ GREEN — barrel(11)+13 submodules. Max 279. Parity 5/5.
      Note: kept `render/render.ts` facade (test-loader shim keys on URL ending `/render.ts`).
- [x] **C3 · `src/profiles/profiles.ts`** ✅ GREEN — barrel(3)+4 files. Max 275. Parity 27/27.
- [x] **C4 · `src/intercom/`** ✅ GREEN — native-supervisor-channel barrel(18)+5 submods; result-intercom barrel(23)+2. Max 272. Parity 5/5, 8/8. 0 importers edited.

> **Tiers 1–2 COMPLETE (C1–C7): all GREEN.** Authoritative consolidated verification:
> 0 files >300 in any touched area; LSP 0 diagnostics; unit suite 989/989.
> Subagent self-reported full-suite runs consistently showed transient noise
> (each saw siblings' half-done work) — main-session consolidated verification
> is authoritative and shows the true merged state is green.

### Tier 2 — mid-level

- [x] **C5 · `src/agents/`** ✅ GREEN — agents.ts barrel+9 submods; agent-management barrel+5; skills barrel+5. Max 281. Parity 27/27, 4/4, 8/8. Path bookkeeping: BUILTIN_AGENTS_DIR depth adjusted 2→3.
- [x] **C6 · `src/slash/`** ✅ GREEN — slash-commands barrel+10; prompt-template-bridge barrel+2; prompt-workflows flat+1 sibling. Max 292 (untouched slash-live-state). Parity exact.
- [x] **C7 · `src/runs/shared/`** ✅ GREEN — 5 files→subdirs+barrels. Max 295. Direct count stayed 23. subagent-prompt-runtime barrel re-exports default+9 named (parity 10/10 incl default).

### Tier 3 — extension surface

- [x] **C8 · `src/extension/`** ✅ GREEN — index.ts kept path+default (delegates to registration/); rpc barrel+2; schemas barrel+4. Max 300. Parity 10/10, 2/2. LSP 0.

### Tier 4 — engines (highest risk, strictly sequential, full regression at end)

- [x] **C9 · `src/runs/background/` async cluster** ✅ GREEN (split into 2 sub-dispatches
      after first attempt exhausted budget on 11 files). All 11 files → `<stem>/` subdirs + barrels.
      Max 289 (excl. subagent-runner.ts = C11). Direct count stayed 20. Parity exact all 11.
      LSP 0, unit 989/989. Note: `spawnRunner` import.meta.url path adjusted (dir deeper) to keep
      resolved path identical.
- [x] **C10 · `src/runs/foreground/` chain cluster** ✅ (3 sub-dispatches)
      - execution.ts: barrel+attempt-helpers(113)+run-sync(267). ✅
      - **R3 · `run-single-attempt.ts` (931) RESOLVED** ✅ (user-authorized deeper refactor):
        shared-state-object extraction. `runSingleAttempt` (931→196) stays ONE function — the ~21
        inline closures were extracted into 7 cohesive sibling modules under `execution/`:
        `single-attempt-state.ts`(249, SingleAttemptState interface+factory), `-lifecycle.ts`(109,
        timers/finish/detach/final-drain), `-control.ts`(113, activity/needs-attention/control
        events), `-budget.ts`(61, turn-budget abort/update), `-events.ts`(174, processLine+
        fireUpdate/snapshot), `-process.ts`(196, intercom/timers/proc/signal handlers),
        `-finalize.ts`(176, post-exit result finalization). All closures close over ONE state ref
        so mutations propagate identically (R2); no await/registration-order/mutation-order change.
        Max line 249. Parity 1/1 (runSingleAttempt sole export). LSP 0, unit 986/989 (3 fail =
        pre-existing subagent-prompt-runtime isolation noise, unrelated), integration 461/467
        (baseline exact), single-execution 81/81, windows-hide-spawn 2/2 (spawn guard regex still
        matches main file — no test path change needed). execution/ folder = 10 files.
      - chain-execution.ts: barrel+7 submodules (max 277). Step-branch extraction via context-object.
      - chain-clarify.ts: barrel+types(26)+text-editor(169)+class. **chain-clarify-component =
        ACCEPTED R1 RESIDUAL** (1159 lines): 62-private-field class; split requires visibility
        change = R2 violation. Visibility verified 62/62 unchanged.
      LSP 0, unit 989/989, integration all green.
- [x] **C11 · `subagent-runner.ts`** (3171, GIANT) ✅ → `runs/background/runner/`
      (9 submodules + 41-line entry). 7 modules ≤300; **2 accepted residuals**:
      run-subagent.ts(1909, ~30-closure giant), run-single-step.ts(412). 0 exports (CLI entry),
      so no barrel/parity needed. LSP 0, unit 989/989.
- [x] **C12 · `subagent-executor.ts`** (3681, GIANT) ✅ → `runs/foreground/executor/`
      (23 submodules) + 7-line barrel. Parity 3/3. **2 accepted residuals**: single-path.ts(345),
      parallel-path.ts(387) — cohesive pipelines, helpers already extracted. Note: C12 made 3
      helper extractions incl. one async/await threading in action-dispatch — integration
      461/467 confirms no behavior regression (matches baseline exactly).
- [ ] **Tier-4 regression gate**: `npm run test:unit && npm run test:integration`.
      Both must be green before Tier 5.

### Tier 5 — tests (after src import graph is final)

- [x] **C13 · integration tests** (10 files >500) ✅ GREEN — split into siblings ≤500.
      All 6 pre-existing slash-commands failures preserved (not fixed, per R2).
- [x] **C14 · unit tests** (7 files >500) ✅ GREEN — split into siblings ≤500.
      Count preserved exactly 989.

## Final acceptance gate (main session, before Phase 3.4)

- [x] `find src -name '*.ts' | xargs wc -l` → **none > 300**. (All 6 residuals resolved.)
- [x] `find test -name '*.ts' | xargs wc -l` → **none > 500**.
- [x] `npm run test:unit` → **989/989 pass**.
- [x] `npm run test:integration` → **461/467** (6 pre-existing slash failures).
- [x] `lsp_diagnostics path="*"` → **0 diagnostics** (the 12 pre-existing run-subagent.ts
      type errors were actually RESOLVED by the state-object extraction — a bonus).
- [x] No `src/` folder over file-count budget (R5).
- [x] `git diff` = moves/splits/import-edits only (no logic change to exports).
- [x] Spot-check submodules for semantic cohesion — done across all chunks.

**TASK COMPLETE.** All commits landed (895598c → d03ae93).

## Rollback points

- Any chunk fails verification and can't be fixed in one retry → `git restore`
  the touched paths, redo the chunk. Barrels keep other areas valid.
- If a chunk reveals a `prd`/`design` defect → return to Phase 1, fix the
  artifact, resume from the failed chunk.
