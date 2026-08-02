# Implementation Plan: subagent view host parity

Companion to `design.md`. Ordered phases; each ends green (`npm run test:unit`).
Rollback points marked. Runtime target: pi 0.83.0 (+ leader-key extension in
the user's environment, non-code dependency — parity validated by smoke).

## Phase 1 — Streaming render trigger (R1)

- [ ] `src/tui/steer-view/host-editor-mode.ts`:
  - add `let widgetTui: TUI | undefined`; set it inside `ensureWidget`'s
    factory wrapper (alongside the existing `render` wrapper);
  - add `requestRender()` helper (try/catch around `widgetTui?.requestRender()`);
  - call it at the end of `onRpcLine()` (both notify and assembler branches);
  - clear `widgetTui = undefined` in `removeWidget()` and `closeConversation()`.
- [ ] `test/unit/host-editor-mode.test.ts`: mock TUI gains a `requestRender`
  counter; add assertions:
  - streamed `message_update` / `tool_execution_update` increments counter;
  - `response` / `extension_ui_request` lines also increment;
  - after `close()`, emitted lines do not increment;
  - widget render content changes across streamed lines (no user input).
- Validate: `npm run test:unit` (host-editor-mode + child-conversation-render
  + assembler suites green).

## Phase 2 — Key routing parity (R2)

- [ ] `src/tui/child-conversation/child-keybindings.ts` rework:
  - resolution via `options.manager ?? getKeybindings()` (`@earendil-works/
    pi-tui` singleton), `actionForKey` iterates `interrupt` first then the
    remaining six `app.*` ids; `keysFor` reads `manager.getKeys`;
  - `clearCache` becomes no-op; keep `CHILD_APP_DEFAULT_KEYS` (mirror table +
    tests) and the options shape (`agentDir`/`fs` accepted but unused by the
    manager path — kept for source compat, documented);
  - guard: if the manager lacks `matches`, fall back to the default-key-only
    matrix (never crash).
- [ ] `src/tui/steer-view/child-key-route.ts`: confirm it keeps consuming via
  the resolver (`actionForKey`) and that Esc idle pass-through / editing-level
  non-interception remain; adjust only if the rework changed the call shape.
- [ ] `test/unit/child-keybindings.test.ts` rework:
  - construct an isolated pi-tui `KeybindingsManager` from
    `CHILD_APP_DEFAULT_KEYS` + fake keybindings.json (same parser rules); run
    the existing 13-case matrix against the new resolver;
  - new: leader-patch simulation (pending-gated `matches` wrapper) → plain
    `"m"` does not resolve `model.select`, post-leader `"m"` does;
  - new: delegation test — `setKeybindings(...)` then `actionForKey` reads the
    global instance (restore in `finally`).
- Validate: `npm run test:unit` (child-keybindings + child-key-route suites).

## Phase 3 — Read-only degraded surface (R3, Q1=B)

- [ ] `src/tui/steer-view/steer-view-component.ts`:
  - remove `Input` field, `inputFocused`, submit/onEscape wiring, tab-focus
    branch, input footer line, input invalidate;
  - header adds explicit "read-only" marker; footer hint "read-only · Esc back";
  - `handleInput` drops printable/enter handling; keeps esc/scroll/shift+tab.
- [ ] `src/tui/steer-view/open-view.ts` `showChat`:
  - channel undefined → transcript present: mount read-only SteerViewComponent
    overlay (done → picker); no transcript: notify warning + `{kind:"picker"}`;
  - resolver-throw branch follows the same logic (existing try/catch).
- [ ] `test/unit/steer-view-component.test.ts`: rework input-driven cases
  (steer submit, slash close) into read-only assertions (render has no input
  row; printable chars inert; esc/scroll/shift+tab/introspection still work).
- [ ] New unit test: `open-view`/picker flow — "channel undefined + transcript
  ⇒ read-only overlay mounted without Input"; "no transcript ⇒ notify + picker".
- Validate: `npm run test:unit && npm run test:integration`.

## Phase 4 — Regression sweep (R4)

- [ ] Full suite: `npm run test:all` (unit + integration + e2e).
- [ ] Re-verify invariants by targeted tests: `//name` validation, `/subagents
  exit|close`, eviction skipping the active child, reopen race guard, channel
  swap on death (existing suites).
- [ ] README/CHANGELOG: parity matrix update (streaming, key parity, read-only
  degraded surface, leader-key dependency note).

## Manual smoke checklist (user machine — has leader-key + open-tui/zentui)

- [ ] Foreground child: `/subagents` select → host-editor widget; typing
  `m`/`o`/`t` inserts letters (leader intact); ctrl+p cycles child model with
  notify; shift+tab thinking cycle; Esc interrupts only while streaming,
  closes autocomplete when idle.
- [ ] Async running child: same surface, **live streaming** updates
  (tokens/tool output) with zero user input.
- [ ] Async completed child while the runner lingers: read-only transcript
  view ("continuity unavailable"), **no input box**, Esc back to picker.
- [ ] `/subagents exit` restores main-agent keys fully; parent session
  untouched (no stray child-routed messages).
- [ ] Leader flow in child mode: `ctrl+x` → status hint → `o` expands child
  tools; `ctrl+x` → `esc` cancels leader (no child action).

## Risky files / rollback points

- `src/tui/steer-view/host-editor-mode.ts` — additive render trigger;
  rollback = drop the `requestRender()` calls (widget content still renders on
  user input, i.e. pre-fix behavior).
- `src/tui/child-conversation/child-keybindings.ts` — resolution source swap;
  rollback = restore the `matchesKey` loop (old behavior, leader-swallowing
  bug included). Keep the file's interface stable so rollback is contained.
- `src/tui/steer-view/steer-view-component.ts` — Input removal is the point;
  rollback = git revert of this file only (overlay returns, degraded only).
- `src/tui/steer-view/open-view.ts` — failure branches; rollback = restore
  previous overlay invocation (behavior before this task).

## Before start

- [ ] PRD convergence pass done (Q1=B recorded; leader-key facts recorded).
- [ ] Design reviewed: leader/Esc ordering edge flagged as a smoke item (not a
  blocker); singleton-guard fallback defined (§6).
- [ ] AC mapping: AC-1 ← Phase 1; AC-2/AC-3 ← Phase 2; AC-4/AC-5 ← Phase 3;
  AC-6 ← Phase 4.