# Design: TUI lag fixes

Task: 08-03-tui-lag-subagent

## Context

pi's TUI `requestRender()` renders the whole component tree (differentially
output); cached tree renders are cheap (~0.05 ms), invalidated/rebuild work
is not. The extension triggers full renders at high frequency while
subagents run and does O(transcript) work inside each. Fixes target the
per-frame hot paths and periodic render/poll drivers without changing
behavior.

## Change 1 — Foreground result render hot path

### 1a. Skip `getFinalOutput` while running (result-render.ts)

`renderSingleCompact` computes `output = r.truncation?.text ||
getSingleResultOutput(r)` up front, but the running branch never uses
`output` (`resultGlyph` with `running=true` returns `runningGlyph`, and the
running branch returns before `resultStatusLine`/`firstOutputLine`).

- Compute `output` lazily: only when `!isRunning` (and no truncation).
- Same in `renderMultiCompact` row loop: compute `output` only for
  non-running rows (`resultGlyph(r, output, ...)` with `rRunning=true` does
  not use it).
- `renderSubagentResult` expanded single path keeps computing output while
  running (the expanded running view displays it) — unchanged.

Result: the 12.5 fps rebuild loop stops scanning the child transcript.

### 1b. Drop messages from per-event snapshots (attempt-helpers.ts)

`snapshotResult(result, progress)` copies `result.messages` (full child
transcript) into every `onUpdate` payload.

- Add an `includeMessages` option (default `true` for backward-compat at
  call sites) — or a dedicated `snapshotProgressResult` used by
  `emitUpdateSnapshot` that omits messages.
- `emitUpdateSnapshot` (per child event) uses the messages-less snapshot.
- Final paths (`finalizeSingleAttempt`, `onDetachedExit`,
  `single-attempt-finalize` final onUpdate) keep the full snapshot — the
  final result must still include messages.

### 1c. Throttle spinner animation (tools.ts)

`ensureSubagentResultAnimation`: interval 80 ms → 200 ms. The frame counter
cycles 0..9 (2 s cycle at 200 ms) — same glyph set, still smooth. Reduces
the sustained full-render loop from 12.5 fps to 5 fps. Timer cleanup
unchanged (`clearLegacyResultAnimationTimer` on non-running).

## Change 2 — Async job tracker (tracker.ts)

- Poll interval: `options.pollIntervalMs ?? POLL_INTERVAL_MS` — introduce a
  tracker default of 500 ms (new const, e.g. `JOB_TRACKER_POLL_INTERVAL_MS =
  500` in tracker or helpers; do NOT change the shared `POLL_INTERVAL_MS`
  used by the runner's control channel).
- Widget re-render throttle: keep `lastWidgetRenderAt`; render immediately
  if the job transitioned to a terminal state (`complete`/`failed`/`paused`)
  or the set of jobs changed; otherwise at most every 500 ms.
- Keep the single-status-read shape (`reconciliation.status ?? readStatus`).

## Change 3 — Scrollback child view (message-renderers.ts)

`createSlashResultComponent.render()`:

```ts
container.render = (width) => {
    const snapshot = getSlashRenderableSnapshot(details);
    const running = isSlashResultRunning(snapshot.result);
    const now = Date.now();
    if (snapshot.version !== lastVersion || (running && now - lastRebuildAt >= 500)) {
        lastVersion = snapshot.version;
        lastRebuildAt = now;
        rebuildSlashResultContainer(container, snapshot.result, options, theme);
    }
    return Container.prototype.render.call(container, width);
};
```

- Version change → immediate rebuild (data actually changed).
- Running with no change → rebuild at most every 500 ms (keeps live
  durations "tool 12s" ticking at 2 fps).
- Completed → rebuild only on version change (no periodic rebuilds).

## Change 4 — Steer view (steer-view-component.ts)

`poll()` currently ends with an unconditional `this.tui.requestRender()`.
Skip the render when nothing changed:

- Track whether new transcript records were fed, a reset happened, pending
  action responses were consumed, or the notice/thinking state changed;
  only then requestRender.

Careful: `render()` applies the settings pass each render. Skipping idle
renders means settings changes land on the next activity/input — acceptable
for the modal view (key handling still calls requestRender).

## Change 5 — (deferred, optional) Runner status-write coalescing

`updateStepFromChildEvent` writes status.json on every child event. A
~250 ms debounce per run (flush on terminal transitions and finalize) would
cut disk churn and parent wakeups. Deferred: higher risk, and the poller
throttle (Change 2) already bounds the parent-side cost.

## Files touched

- `src/tui/render/result-render.ts` — lazy output for running rows
- `src/runs/foreground/execution/attempt-helpers.ts` — messages-less
  snapshot for per-event updates
- `src/runs/foreground/execution/single-attempt-events.ts` — use
  messages-less snapshot in `emitUpdateSnapshot`
- `src/extension/registration/tools.ts` — animation interval 200 ms
- `src/runs/background/async-job-tracker/tracker.ts` — poll 500 ms +
  render throttle
- `src/extension/registration/message-renderers.ts` — slash rebuild throttle
- `src/tui/steer-view/steer-view-component.ts` — skip idle requestRender

## Testing strategy

- Unit: existing render tests (`render-widget-*`, `render-fork-badge-*`,
  `child-conversation-render`, `foreground-tool-call-compaction`) still
  pass; add/extend tests for: messages omitted from per-event snapshot but
  present in final; lazy output while running; tracker poll interval +
  throttle behavior (injectable timers exist); slash rebuild throttle
  (injectable clock); steer-view no-idle-render.
- Integration: `async-job-tracker-*`, `foreground-rpc-child`,
  `completion-*`, `slash-live-state` suites.
- Manual smoke: foreground + async subagent, watch TUI responsiveness.

## Compatibility / rollout

- All changes are internal to this extension; no config surface changes.
- Per-event snapshot omitting messages is an internal optimization — the
  final result contract is unchanged.
- Animation interval change is visual only.
