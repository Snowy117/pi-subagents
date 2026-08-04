# Research: TUI lag while subagents run

Date: 2026-08-03
Task: 08-03-tui-lag-subagent

## Summary

The extension keeps the pi TUI render loop hot while subagents run, and each
render does more work than necessary. Measured costs are small individually
(sub-ms), but the *frequency* is high (up to 12.5 full re-renders/sec
sustained), the per-frame work grows with the child transcript, and sync fs
ops block the TUI thread. In real sessions (long transcripts, expanded
results, scrollback child views, syntax-highlighted code) the aggregate
saturates the TUI process event loop → periodic input/render lag.

## Key facts (verified in code + measurements)

### pi TUI render model
- `TUI.requestRender()` coalesces to a min 16ms interval, then `doRender()`
  renders the **whole component tree** and diffs previous/new lines; only
  changed lines are written to the terminal.
- Cached tree render is cheap: **0.04–0.06 ms/frame** for a 150–400 message
  conversation (measured with real pi-tui `Markdown` caching).
- **Invalidated** tree render (markdown re-parse) is expensive: **~100 ms**
  for 150 messages. Anything that invalidates large parts of the tree per
  frame is a lag source.
- `ToolExecutionComponent.invalidate()` = `super.invalidate()` +
  `updateDisplay()`, which **rebuilds the whole result component**
  (calls `renderResult` again) + `ui.requestRender()` (full tree render).
- Tool result `context.invalidate()` (pi's ToolRenderContext) = component
  invalidate + `ui.requestRender()` — no partial render possible.

### Driver 1 — foreground spinner animation (MOST AGGRESSIVE)
`src/extension/registration/tools.ts` `ensureSubagentResultAnimation`:
- While a foreground result is running: `setInterval(80ms)` →
  `context.invalidate()` → **full result rebuild + full TUI render every
  80 ms = 12.5 fps sustained** for the whole duration of the subagent run
  (minutes). Introduced by 273510d "animate foreground subagent spinner
  between child events" (80ms matches pi's own `Loader` cadence).
- Per-frame rebuild includes `getSingleResultOutput(r)` →
  `getFinalOutput(r.messages)` — an O(child transcript) scan executed on
  every frame even though the running compact view never displays the
  output (verified: `output` is unused in the `isRunning` branch of
  `renderSingleCompact`).
- `snapshotResult` (attempt-helpers.ts) also copies the **full messages
  array into every `onUpdate` payload** (every child event).

### Driver 2 — per-child-event full render (foreground)
`single-attempt-events.ts` `processLine` → `fireUpdate()` on every
`tool_execution_start` / `tool_execution_end` / `message_end` /
`tool_result_end`:
- `getFinalOutput(state.result.messages)` (O(transcript), twice per event:
  once in fireUpdate, once in the render) + `snapshotResult` (copy all
  messages) + `onUpdate` → pi `updateResult` → `updateDisplay` (rebuild) +
  `ui.requestRender()` (full render). Tool-activity bursts → render bursts.
- Per-event sync fs: `transcriptWriter.writeChildEvent` uses
  `appendFileSync` on the TUI thread.

### Driver 3 — async job tracker poller
`src/runs/background/async-job-tracker/tracker.ts`:
- Polls every **250 ms** (POLL_INTERVAL_MS) while async jobs exist. Per tick
  per job: `emitNewControlEvents` (openSync+fstatSync+readSync events.jsonl,
  JSON.parse up to 2MB window), `reconcileNestedDescendants`,
  `reconcileAsyncRun` (**sync `fs.readFileSync` + JSON.parse of status.json**),
  then **another `readStatus`** (second sync read), then
  `widgetRenderKey(job)` = `JSON.stringify` of the whole job state.
- Re-renders widget + `ctx.ui.requestRender()` whenever the key changed.
- Runner rewrites status.json on **every child event**
  (`runner-ops-step-updates.ts` `updateStepFromChildEvent` →
  `writeStatusPayload` → atomic write) + every ~1s activity timer when the
  output log mtime moves. So during active async work the parent re-renders
  up to 4×/sec and blocks on sync status reads 4×/sec.

### Driver 4 — steer view (when open)
`src/tui/steer-view/steer-view-component.ts` `poll()` (250 ms):
- **Unconditionally calls `this.tui.requestRender()` every 250 ms even when
  no new transcript records arrived**; `render()` re-assembles the full
  child transcript each pass (`applySettingsPass()` + assembler render).

### Driver 5 — scrollback child-view rebuild on every render
`src/extension/registration/message-renderers.ts`
`createSlashResultComponent.render()`:
- `if (snapshot.version !== lastVersion || isSlashResultRunning(...))` →
  **rebuilds the whole subagent result container on every render pass while
  running**, even when nothing changed (every render from ANY source —
  typing, animation, pollers — triggers it). The rebuild calls
  `renderSubagentResult` which for expanded/multi results re-runs
  `getFinalOutput` per result row.

### Measurements (real pi-tui components, synthetic data)
- Cached full-conversation render: 0.04–0.06 ms/frame (150/400 msgs)
- Invalidated full-conversation render: ~100 ms/frame (150 msgs)
- `getFinalOutput` over 20–400 msg pairs (38–761 KB): 0.04–0.22 ms
- Compact running result rebuild + render: 0.05–0.09 ms/frame
- Expanded running result rebuild + render: 0.8–1.1 ms/frame
- Line-diff pass over 1650 lines: 0.007 ms

### Non-issues (ruled out)
- The 1s activity timers (`runner` activityTimer, foreground
  `startActivityTimer`) only fire updates on activity-state *transitions*,
  not every second.
- `slash-live-state`, `child-transcript` file watching, result watcher
  (fs.watch) are event-driven; no TUI-thread polling.
- Cached full-tree renders are cheap; the render frequency only matters
  because of the per-frame *rebuild* work (Driver 1/2/5) and sync fs
  (Driver 3).

## Fix directions (ranked by impact/risk)

1. **Throttle the foreground spinner** (tools.ts): 80 ms → 250 ms. Cuts the
   sustained 12.5 fps → 4 fps re-render loop (~70% reduction) for the whole
   run duration. Low risk.
2. **Make per-frame rebuild cheap** (result-render.ts / attempt-helpers):
   skip `getFinalOutput` while running; cache output extraction on
   message_end; drop full `messages` from per-event `onUpdate` snapshots
   (only include in final result). Removes O(transcript) work from the hot
   path. Low risk.
3. **Throttle slash-result rebuild** (message-renderers.ts): rebuild only on
   version change or ≤1×/500 ms while running. Low risk.
4. **Async poller** (tracker.ts): poll 250→500 ms; single status read per
   tick; min-interval (500 ms) throttle on widget re-render. Low risk.
5. **Steer view** (steer-view-component.ts): skip `requestRender` when no
   new records/state. Low risk.
6. (Optional) **Runner status-write coalescing** (runner-ops-step-updates):
   debounce `writeStatusPayload` per run (~250 ms), flush immediately on
   terminal transitions. Medium risk — reduces disk churn + parent wakeups.
