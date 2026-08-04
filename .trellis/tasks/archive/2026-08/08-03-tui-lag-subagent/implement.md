# Implement: TUI lag fixes

Task: 08-03-tui-lag-subagent

Read first: `prd.md`, `design.md`, `research/tui-lag-analysis.md`.

## Ordered checklist

1. **result-render.ts — lazy output while running**
   - `renderSingleCompact`: only compute `getSingleResultOutput` when
     `!isRunning` (no truncation).
   - `renderMultiCompact`: only compute output for non-running rows.
   - Keep expanded single path behavior unchanged (output shown while
     running).
   - Validate: `npm run test:unit` render suites.

2. **attempt-helpers.ts + single-attempt-events.ts — messages-less
   per-event snapshots**
   - Add messages-less snapshot builder (or option) used by
     `emitUpdateSnapshot`.
   - Final snapshots (`finalizeSingleAttempt`, detached exit) unchanged.
   - Validate: foreground execution tests, `foreground-tool-call-compaction`.

3. **tools.ts — animation interval 80 → 200 ms**
   - `ensureSubagentResultAnimation` interval.
   - Validate: animation/registration tests.

4. **tracker.ts — poll 500 ms + render throttle**
   - New tracker default poll interval 500 ms (do not touch shared
     `POLL_INTERVAL_MS`).
   - Throttle widget re-render to ≥500 ms except terminal transitions/job
     set changes.
   - Validate: `async-job-tracker-*` integration tests (injectable timers).

5. **message-renderers.ts — slash rebuild throttle**
   - Version-change immediate; running ≤1/500 ms; completed version-only.
   - Validate: slash tests, `render-widget-*`.

6. **steer-view-component.ts — skip idle requestRender**
   - Track changed-state in `poll()`; render only on change.
   - Validate: steer-view tests, child-key-route tests.

7. **Full validation**
   - `npm run test:unit`
   - `npm run test:integration` (if environment permits)
   - `npm run typecheck` / lint per repo config
   - Review diffs against prd/design acceptance criteria.

## Rollback

Each change is small and independent; revert per-file if a check fails.
No schema/config changes → no migration concerns.
