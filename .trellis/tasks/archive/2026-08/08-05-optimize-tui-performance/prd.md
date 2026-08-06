# 优化 TUI 响应性能

## Goal

Keep the TUI responsive as the parent conversation, child transcript, and
rendered output grow. The primary reported symptom is progressive degradation:
short sessions are generally responsive, while long conversations or large
outputs become severely laggy.

## Requirements

- Treat transcript/output length as the primary performance dimension, rather
  than optimizing only the idle refresh cadence.
- Preserve the current foreground, background, child-conversation, steer, and
  completion behavior and rendered information.
- Avoid work on an unchanged historical transcript during animation ticks,
  status refreshes, input renders, scrolling, and incremental child events.
- Keep live progress and streaming useful; optimizations may coalesce purely
  visual updates but must not lose terminal state, control notices, or final
  output.
- Add automated performance-regression coverage based on operation counts or
  bounded render/rebuild work for short versus long transcripts. Wall-clock
  assertions alone are not sufficient.
- Do not change public tool/RPC schemas or subagent execution semantics unless
  further research demonstrates that such a change is required.

## Acceptance Criteria

- [ ] The identified hot path is demonstrated to grow with transcript/output
      length and is documented with concrete source references and a repeatable
      baseline.
- [ ] Unchanged historical messages are not rescanned or reassembled on every
      foreground animation tick, background refresh, or unrelated root render.
- [ ] Incremental live updates process only new/changed transcript data where
      the current contracts permit it.
- [ ] Long-transcript regression tests fail on the current pathological behavior
      and pass after the implementation, using deterministic counters/fakes or
      another stable complexity-oriented assertion.
- [ ] Foreground and background completion, child conversation rendering,
      steer controls, scrolling, expanded/collapsed output, and control notices
      remain behaviorally correct.
- [ ] Project unit tests, integration tests, and TypeScript diagnostics pass.

## Notes

- User-selected reproduction profile: option 4 — the UI becomes progressively
  slower as the conversation or output grows; short sessions are mostly normal.
- Previous task `08-03-tui-lag-subagent` reduced refresh frequency and several
  avoidable rebuilds, but did not establish a long-transcript complexity gate.
