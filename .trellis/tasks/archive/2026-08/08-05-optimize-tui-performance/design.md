# Design: long-transcript TUI responsiveness

Task: `08-05-optimize-tui-performance`

## Context

The reported degradation correlates with accumulated conversation/output size.
The previous TUI-lag task reduced several refresh rates and avoided copying
`messages` in per-event snapshots, but it did not add a complexity gate for
long child transcripts.

Current-HEAD measurement isolates a dominant extension-owned path: both child
conversation surfaces call `assembler.applySettings()` on every render. The
method mutates every historical native component and recursively invalidates
the entire container even when all effective settings are unchanged. At 1,000
synthetic Markdown messages / 13,000 rendered lines, a cached render takes
0.208 ms while an unchanged settings pass plus render takes 86.960 ms.

A separate foreground update path calls `getFinalOutput()` on every significant
child event. That function normally scans all accumulated assistant messages
and runs report-detection regular expressions over their text, although the
running compact result only needs a live placeholder/recent progress summary.

## Design goals

- Make unchanged child-view renders reuse historical component caches.
- Make foreground event updates independent of accumulated transcript length.
- Preserve settings propagation, native child-component rendering, streaming,
  final output extraction, and all control/completion behavior.
- Establish deterministic regression gates based on rebuild/scan counts rather
  than unstable wall-clock thresholds.

## Change 1: change-driven child settings propagation

### Boundary

`createMessageAssembler()` remains the owner of effective settings already
applied to assembled components. `applySettings(next, nextExpanded)` compares
the new primitive fields with the current state before mutating anything.

### Contract

1. If every effective `ViewerSettings` field and expansion value is equal,
   return immediately. Do not walk `container.children`, call native setters,
   or invalidate the container.
2. If values differ, compute field-level change flags and visit historical
   children once. Call only setters affected by changed fields:
   - `ToolExecutionComponent`: expanded, showImages, imageWidthCells.
   - `CustomMessageComponent`: expanded, outputPad.
   - `BashExecutionComponent`: expanded.
   - `AssistantMessageComponent`: hideThinkingBlock,
     hiddenThinkingLabel, outputPad.
   - `UserMessageComponent`: outputPad.
3. Update `state.settings` and `state.toolOutputExpanded` consistently so newly
   appended components use the latest values.
4. Remove the unconditional `state.container.invalidate()`. Native setters
   rebuild their affected component; callers already request the root repaint.
5. A `codeBlockIndent` change is special because existing Assistant/User
   components captured a Markdown theme at construction and expose no theme
   setter. Preserve correctness by rebuilding/reseeding the assembled history
   only if research during implementation finds an existing safe retained-data
   path. Otherwise keep a narrowly scoped explicit invalidation/reconstruction
   fallback for this rare setting change, documented and tested. It must not run
   when the setting is unchanged.

The caller-side per-render settings read may remain because it is TTL-cached;
the crucial property is that an equal snapshot is O(1) before component work.

## Change 2: constant-cost foreground running updates

`single-attempt-events.ts` must not call `getFinalOutput(messages)` for ordinary
running updates. Build update `content` from already bounded live state, such as
the latest non-empty `progress.recentOutput` line or the existing
`"(running...)"` fallback. No full `messages` scan or copy occurs.

Finalization remains authoritative and unchanged: final snapshots include the
message list where required and final output/report extraction still uses the
existing semantic helpers. Timeout/turn-budget terminal content that has
already been captured in `result.finalOutput` remains available immediately.

This is an internal partial-update optimization; the final tool result contract
does not change.

## Change 3: render-driver guard

The 200 ms foreground glyph animation still causes full root renders whose
cached cost grows with total rendered lines. Prefer an event-driven running
glyph (derived from progress/tool counts and child events) and remove the
sustained timer if visual behavior remains understandable. If compatibility
requires animation, gate it behind a much lower cadence and stop it when the
result is not visible/running where the available renderer contract permits.

Implementation must first add a deterministic timer/invalidation-count test.
The preferred outcome is zero periodic invalidations during an otherwise quiet
foreground run. Progress events and terminal transitions still repaint
immediately. This change is independent and can be rolled back without undoing
Changes 1 or 2.

## Measurement and tests

- Replace the current test that expects unchanged settings to reapply every
  setter with an idempotence regression test.
- Spy on native component setters/update paths: equal settings over a long
  fixture cause zero historical setter calls and zero recursive invalidation.
- Add field-diff tests proving one changed field reaches only relevant classes.
- Add a deterministic foreground-event fixture with many historical messages;
  an ordinary running event must not call the final-output extractor/full scan,
  while finalization still returns the same output.
- Add timer/invalidation-count coverage for the foreground animation decision.
- Keep the research microbenchmark as a repeatable manual diagnostic, not an
  absolute CI timing assertion.

## Compatibility and risk

- No public schema, persisted format, or RPC protocol changes.
- Native child components and rendered content remain the source of truth.
- The principal risk is missing a real settings transition. Field-diff tests
  cover each setting and expansion flag, including repeated equal snapshots.
- Removing decorative animation changes motion but not status information. It
  is preferred when needed to protect long-session input responsiveness.

## Deferred work

- Viewport virtualization or prefix-line caching for the residual upstream
  O(rendered lines) root traversal.
- Changes to upstream pi TUI internals.
- Broad runner status-write coalescing or unrelated background I/O cleanup.
- Truncating child conversation history, which would change visible behavior.

After the P0 fixes, rerun the benchmark. Only pursue virtualization if cached
root traversal remains user-visible in real 5k/10k/20k-line sessions.
