# PRD: Fix TUI lag while subagents run

Task: 08-03-tui-lag-subagent

## Problem

When a subagent is running, the pi TUI becomes laggy periodically
(input/render jank while typing or scrolling). The lag appears while the
subagent runs and goes away when it finishes.

Root cause (see `research/tui-lag-analysis.md`): subagent activity drives
high-frequency full TUI re-renders and per-frame work that grows with the
child transcript, plus periodic main-thread fs churn:

1. **Foreground spinner animation**: an 80 ms `setInterval` invalidates the
   running tool result, rebuilding the result component and re-rendering the
   whole TUI at 12.5 fps for the entire subagent run. Each rebuild re-scans
   the full child transcript (`getFinalOutput`) even though the running
   compact view never displays that output.
2. **Per-child-event work**: every child event (`tool_execution_start/end`,
   `message_end`, `tool_result_end`) copies the full `messages` array into
   the `onUpdate` payload and triggers a full render.
3. **Async poller**: polls status.json every 250 ms (sync reads) and
   re-renders the widget on every status change; the runner rewrites
   status.json on every child event.
4. **Scrollback child view**: the slash result component rebuilds its whole
   result on *every* render pass while running, even with no data change.
5. **Steer view**: requests a full render every 250 ms even when nothing
   changed.

## Goals

- The TUI stays responsive (typing/scrolling) while a subagent runs.
- Subagent progress display (spinner, durations, tool info, widget, child
  view) remains useful and live.
- No behavioral/UX regressions: completion, control notices, async widget
  updates, steer view, child conversation view all keep working.
- Preserve the subagent view ≈ main-agent-view experience: the child
  conversation view is assembled from pi's native components
  (`AssistantMessageComponent`, `ToolExecutionComponent`, `UserMessageComponent`,
  `BashExecutionComponent`, `CustomMessageComponent` in
  `src/tui/child-conversation/assemble-message.ts`). Fixes must not change
  what the child view renders or how it streams (only how often it
  re-renders/rebuilds when nothing changed).

## Non-goals

- Eliminate the inherent cost of streaming a child's live output into the
  root scrollback (event-driven streaming renders are unavoidable while a
  child emits text).
- Change pi upstream (`requestRender` semantics, `Loader` cadence).
- Change subagent execution semantics (progress event content beyond
  payload size).

## Requirements

### R1 — Foreground result render hot path
- The per-frame rebuild of a *running* result must not do O(child
  transcript) work (`getFinalOutput` / `getSingleResultOutput`). The output
  is only needed for the completed view; skip it while running.
- Per-event `onUpdate` snapshots must not carry the full `messages` array
  (only the final/terminal snapshot includes messages).
- Spinner animation must remain smooth but must not drive a 12.5 fps full
  TUI re-render loop; slow the tick to ≤ 200 ms.

### R2 — Async job tracker
- Reduce poll frequency from 250 ms to 500 ms.
- Throttle widget re-renders to at most ~2/sec (500 ms) except immediate
  render on terminal state transitions and completion events.
- Keep one status read per tick (no redundant reads added).

### R3 — Scrollback child view (slash result)
- `createSlashResultComponent` must not rebuild the result on every render
  pass while running; rebuild on version change or at most ~1/500 ms while
  running (keeps live duration updates, bounds cost).

### R4 — Steer view
- `poll()` must not request a full render when nothing changed (no new
  records, no pending action responses).

### R5 — Regression safety
- Existing unit/integration tests pass (`npm run test:unit`,
  `npm run test:integration` where applicable).
- Render outputs for completed results, widget, control notices, child
  conversation view are unchanged.
- No new timers that outlive their purpose (all timers cleaned up).

## Acceptance criteria

- [ ] AC-1: Running compact subagent results no longer call
      `getFinalOutput`/`getSingleResultOutput` per frame (verified by code
      inspection / test).
- [ ] AC-2: Per-event `onUpdate` snapshots omit `messages`; final snapshot
      still includes them (existing finalize tests pass).
- [ ] AC-3: Spinner animation interval is ≤ 200 ms; timer cleared on
      completion (existing animation tests pass).
- [ ] AC-4: Async tracker default poll interval is 500 ms; widget renders
      throttled to ≤ 2/sec except terminal transitions.
- [ ] AC-5: Slash result rebuilds at most 1/500 ms while running with no
      version change.
- [ ] AC-6: Steer view skips idle requestRender.
- [ ] AC-7: `npm run test:unit` green; relevant integration tests green.
- [ ] AC-8: Manual smoke: run a foreground subagent and an async subagent;
      TUI typing stays responsive; spinner/widget/child view still update.
