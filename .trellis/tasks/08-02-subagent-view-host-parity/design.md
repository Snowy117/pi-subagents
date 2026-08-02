# Design: subagent view fully matches main agent view

Companion to `prd.md`. Three defect fixes on the existing host-editor
architecture (which already is the correct shape: real main-agent editor +
above-editor widget + `pi.on("input")` routing). This design keeps that
architecture and fixes the three gaps: streaming render trigger, key routing
parity, and removal of the self-drawn editor from every path.

## 1. Layered inventory（现状核对）

| Concern | Mechanism (exists today) | Parity gap |
|---|---|---|
| Input surface | host-editor mode keeps the real Pi editor mounted/focused; `pi.on("input")` routes ordinary submissions to the child (`{action:"handled"}`) | ✓ none (editor reuse already correct; open-tui/zentui inherit naturally) |
| Conversation render | widget = `createChildConversationWidget` over `ChildConversationAssembler` (native `UserMessage/AssistantMessage/ToolExecution/...` components) | render is correct but **never re-triggered on child output** (R1) |
| App-level keys | `child-key-route.ts` on `ctx.ui.onTerminalInput`, resolution via hand-written `child-keybindings.ts` (`matchesKey`) | resolution must be **the same function the main agent uses** incl. leader-key patch (R2) |
| Degraded surface | `SteerViewComponent` full-screen overlay with self-drawn `new Input()` | Input must go; keep a read-only transcript view (R3, Q1=B) |

## 2. R1 — streaming render trigger（widget 刷新）

### Change
`src/tui/steer-view/host-editor-mode.ts`:

- Capture the widget TUI handle when the widget factory mounts it:
  ```ts
  let widgetTui: TUI | undefined;
  // inside ensureWidget's factory wrapper:
  component = baseFactory(tui, theme); widgetTui = tui; ...
  ```
- Add a single `requestRender()` helper:
  ```ts
  const requestRender = () => { try { widgetTui?.requestRender(); } catch { /* stale */ } };
  ```
  `TUI.requestRender()` (pi-tui, `tui.d.ts:212`) already coalesces via
  `renderRequested` + ~16ms `MIN_RENDER_INTERVAL_MS` — call it **per RPC line**,
  no self-built throttling.
- Call `requestRender()` at the end of `onRpcLine()` (both the notify branch
  and the `assembler.addRpcLine` branch — every parsed line indicates child
  activity).
- Clear `widgetTui = undefined` in `removeWidget()` / `closeConversation()`
  so a closed mode never triggers rendering (R1 cleanup clause).

### Data flow
RPC stdout (LocalRpcChannel / AsyncBridgeChannel) → `onStdoutLine` →
`onRpcLine` → `assembler.addRpcLine` (components updated:
`AssistantMessageComponent.updateContent` rebuilds content each call;
`ToolExecutionComponent.updateArgs/updateResult` incremental) →
`widgetTui.requestRender()` → TUI render pass → widget component re-renders
`assembler.container.render(width)` (Container has no cache) → latest
tokens/tool output visible without any user input.

### Tests (extend `test/unit/host-editor-mode.test.ts`)
- Extend the mock TUI with a `requestRender` counter; assert:
  - a streamed `message_update` line (and `tool_execution_update`) increments
    the counter;
  - plain `response` / `extension_ui_request` lines also trigger a render;
  - after `close()`, further emitted lines do **not** increment (cleanup);
  - widget render lines change across streamed lines (existing "streams
    follow-up responses into the strip" test extended to assert content delta
    per line).
- `child-conversation-render.test.ts` unchanged (render path unaffected).

## 3. R2 — key routing parity（复用全局 KeybindingsManager）

### Principle
All key-resolution must funnel through the **same function** the main agent
sees — the global `getKeybindings()` singleton from `@earendil-works/pi-tui`,
whose `matches` carries: pi default table (incl. `app.*`), user
`~/.pi/agent/keybindings.json` (loaded + legacy-migrated at startup), and the
**leader-key extension's prototype patch** (pending-state gating of
`leader+<key>`). Hand-written `matchesKey` loops are removed.

### Change — `src/tui/child-conversation/child-keybindings.ts`
Keep the external interface (`actionForKey`, `keysFor`, `clearCache`,
`CHILD_APP_DEFAULT_KEYS`, options object) so `child-key-route.ts` and the
existing test surface stay stable, but reimplement resolution:

```ts
const ACTION_IDS: Record<ChildAppAction, string> = { /* app.interrupt, app.thinking.cycle,
  app.model.cycleForward, app.model.cycleBackward, app.model.select,
  app.tools.expand, app.thinking.toggle */ };
// resolution order: interrupt first, then the rest (matches main-agent
// CustomEditor priority; no default key overlaps exist except user conflicts)

actionForKey(data) {
  const manager = options.manager ?? getKeybindings();   // ← global singleton in prod
  for (const action of ORDER) {
    if (manager.matches(data, ACTION_IDS[action])) return action;
  }
  return undefined;
}
keysFor(action)  { return getKeysWithFallback(manager, ACTION_IDS[action]); }
clearCache()     { /* no-op: the global manager is authoritative and live */ }
```

- `options.manager` (pi-tui `KeybindingsManager`) is the test injection point;
  production omits it and uses the global.
- `CHILD_APP_DEFAULT_KEYS` is retained as the mirror table for tests and
  documentation; a unit test asserts it matches `manager.getKeys()` for the
  predefined case (defaults parity check).
- legacy-name migration / invalid-value handling / removal (`[]`) are all owned
  by the pi runtime manager; our file no longer re-implements them (the
  migration assertions move to tests that construct an isolated manager from a
  fake keybindings.json — same parser, same rules).

### Interaction with the leader-key extension
- Production path uses the **same singleton instance** the editor uses, so the
  leader-key prototype patch applies identically: typing `m`/`o`/`t` never
  resolves `app.model.select`/`app.tools.expand`/`app.thinking.toggle`
  (patched `matches` returns false when not pending) — fixes the current
  "typing letters gets swallowed" bug by construction.
- Ordering of `onTerminalInput` listeners is extension-load dependent; the
  design tolerates both orders (analysis):
  - leader-key listener first: it consumes `ctrl+x` (pending), then lets the
    next key through; keyRoute sees it and the patched `matches` resolves.
  - keyRoute first: non-binding keys fall through to leader-key; binding keys
    (e.g. `ctrl+p`) route to the child before leader state starts.
- Edge to verify in real-TUI smoke: **Esc during streaming while leader is
  pending** — keyRoute consumes Esc (interrupt) only when streaming; when idle
  it passes through so leader-key cancels leader mode; when streaming the
  interrupt wins and pending leader state is left set (a following key could
  resolve a leader binding against the stale pending state). Mitigation if the
  smoke test observes a problem: keyRoute consumes-level check using
  `matchesKey(data, "escape")` is unchanged; acceptable divergence matches
  main-agent behavior where Esc cancels leader first (documented; not a
  regression for the 7 intercepted actions if Esc is mapped to interrupt).
  Record outcome in implement checklist.

### Tests — `test/unit/child-keybindings.test.ts` (rework, keep matrix)
- Construct an isolated `KeybindingsManager` (pi-tui) with:
  - definitions = `CHILD_APP_DEFAULT_KEYS` mirror table;
  - userBindings parsed from a fake keybindings.json via the same load logic
    (defaults / remap / legacy migration / both-names / invalid value / `[]`
    removal / multiple keys).
- Assert the same 13 cases as today against the **manager-backed** resolver
  (parity with the old matrix).
- New: "typing a plain letter does not resolve a leader-bound action" —
  simulate the leader-key patch (wrap the manager's `matches` with pending
  gating like the real extension) and assert `actionForKey("m")` is undefined
  while `actionForKey("m")` after a synthetic leader press resolves
  `model.select`; pins the "no hand-written matchesKey" contract.
- New: delegation test — `setKeybindings(new KeybindingsManager(...))` (with
  try/finally restore) proves production path reads the global instance.
- `child-key-route.test.ts` stays (routing matrix, consume gating, idle-Esc
  pass-through) — only construction of the keybindings source changes if its
  harness references it.

## 4. R3 — read-only degraded surface（消灭自绘 Input）

### `src/tui/steer-view/steer-view-component.ts`
- Remove `private readonly input = new Input()`, `inputFocused`,
  `input.onSubmit/onEscape`, `handleInput`'s tab/input branches, the
  `this.input.render(...)` footer line, and `invalidate()`'s input call.
- Keep: transcript polling+assembly (native components), scroll keys
  (pgup/pgdown/up/down), `shift+tab` thinking cycle, Esc → `{kind:"picker"}`.
- Header notes "read-only · continuity unavailable" (existing label + add
  explicit "read-only" and "Esc back" hints in the footer line that replaces
  the input row).
- `submit()` is removed; `handleInput` ignores printable characters (nothing
  is entered).

### `src/tui/steer-view/open-view.ts` — `showChat`
- channel resolved → host-editor mode (unchanged).
- channel **undefined**:
  - `target.transcriptPath` present → mount the read-only
    `SteerViewComponent` overlay (no Input); its `done` returns to the picker.
  - no transcript at all → `ctx.ui.notify("... continuity unavailable (no
    resident process, no persisted session, no transcript)", "warning")` and
    return `{ kind: "picker" }` (stay in picker).
- resolver throw → same two branches (try/catch already present).
- Picker filter (`active || resident || sessionFile`) stays — read-only view
  now gives every listed target a sensible outcome instead of a chat
  dead-end; no prefilter tightening needed (lowest-risk option, matches
  Q1=B's "read-only fallback" intent).

### Tests
- `steer-view-component.test.ts`: rework the two input-driven cases
  (steer submission, slash close) — remove/replace with read-only assertions
  (no input row in render output; printable chars do nothing; Esc/scrolling/
  shift+tab still work). Keep focus-propagation and bounds tests.
- `open-view` behavior covered via existing picker-flow tests where present;
  add a unit test for "channel undefined + transcript → read-only overlay
  mounted; no Input in render".
- `child-conversation-render.test.ts` untouched.

## 5. Contract & safety regressions (R4)

Unchanged invariants re-verified:
- `pi.on("input")` returns `handled` only while child mode is active; parent
  session stays authoritative; single writer per child session (reopen still
  registry-guarded); channel-death re-resolve + swap path untouched.
- `//name` validation, `/subagents exit|close`, eviction (skips the actively
  conversed child), async bridge heartbeat/linger, foreground
  resident/reopen — none touched by the three changes; full regression below.

## 6. Risks / rollback

| Risk | Mitigation / rollback |
|---|---|
| `getKeybindings()` singleton not initialized when keyRoute first runs | In practice pi initializes the manager at startup, before extensions register listeners; guard `manager.matches` behind a `typeof getKeybindings().matches === "function"` check, fall back to `CHILD_APP_DEFAULT_KEYS`-only matching if absent (never crash). |
| leader/Esc ordering edge (see R2) | Real-TUI smoke checklist item; divergence documented if observed; intercepted-action correctness unaffected. |
| Removing Input breaks steer flow for unresolved targets | By design (Q1=B): those targets are read-only; steer remains available in host-editor conversations (`//name` / ordinary submissions) and via the control-routing used elsewhere. |
| SteerViewComponent test rework misses a behavior | Reworked cases listed in §4; full suite must stay green. |
| Global-singleton delegation makes unit tests order-dependent | Injection point (`options.manager`) keeps tests isolated; only the delegation test touches the global and restores it. |

## 7. Validation commands

- Per change: `npm run test:unit`.
- Integration: `npm run test:integration` (host-editor + async bridge paths).
- Full: `npm run test:all`.
- Manual TUI smoke (user machine, has leader-key + open-tui/zentui):
  1. foreground child → `/subagents` select → host-editor widget, typing
     `m`/`o`/`t` inserts letters (leader semantics intact), ctrl+p cycles
     child model with notify, Esc interrupts only while streaming.
  2. async running child → same surface, live streaming updates.
  3. async completed child (runner lingering) → read-only transcript view with
     "continuity unavailable", no input box, Esc back to picker.
  4. exit child mode → main-agent keys fully restored.