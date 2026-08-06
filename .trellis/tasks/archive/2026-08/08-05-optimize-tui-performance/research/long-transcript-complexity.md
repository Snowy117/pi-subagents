# Long-transcript TUI complexity (current HEAD)

## Conclusion

The decisive extension-owned regression is the child-conversation settings pass. Both child surfaces call `applySettings()` on every render. That method walks every accumulated component, invokes setters even when every value is unchanged, and then invalidates the complete container. Upstream setters rebuild old assistant/user/tool subtrees, and container invalidation clears their newly-created Markdown/Text caches again. Consequently, an editor repaint or child event reparses and rewraps the full child transcript.

Pi TUI itself still materializes and compares the full accumulated line array on every root render, so cached rendering remains O(rendered lines), but the measured constant is small. The unchanged settings pass turns the same operation into full Markdown/component reconstruction and is the first fix boundary.

## Deterministic benchmark evidence

Environment: current checkout, Node `v22.23.1`, `@earendil-works/pi-tui` / `@earendil-works/pi-coding-agent` `0.83.0`, fixed width 100. No repository files were created by the benchmark.

Child benchmark shape:

- Initialize Pi's dark theme and `createChildConversationAssembler()` with a no-op `requestRender` TUI.
- Seed N finalized assistant messages. Every message contains the same deterministic Markdown shape: heading, paragraph with bold/code/link, two-item list, TypeScript fenced block, and a message number.
- Warm once with `assembler.container.render(100)`.
- Measure 10 repetitions of cached `container.render(100)`.
- Separately measure 10 repetitions of the current hot path: `assembler.applySettings(theSameSettings, false)` followed by `container.render(100)`.

Results (mean milliseconds per repetition):

| Messages | Rendered lines | Cached render | Unchanged settings + render | Ratio |
|---:|---:|---:|---:|---:|
| 50 | 650 | 0.114 ms | 9.853 ms | 86.7x |
| 200 | 2,600 | 0.178 ms | 19.801 ms | 111.1x |
| 500 | 6,500 | 0.249 ms | 44.111 ms | 177.3x |
| 1,000 | 13,000 | 0.208 ms | 86.960 ms | 417.9x |

The 1,000-message unchanged-settings pass alone exceeds a 60 Hz frame budget by about 5.4x. Cached component traversal remains below 0.3 ms in this benchmark.

## Post-implementation measurement

The same 1,000-message / 13,000-line fixture was rerun after making equal
settings snapshots idempotent. Five batches measured 100 repetitions each
after warmup. The median cached render was 0.209 ms and the median equal
settings plus render was 0.208 ms, compared with the 86.960 ms baseline above.
The deterministic regression also records zero historical native setter calls
and zero container invalidations for an equal snapshot over 1,000 messages.

Root cached-render comparison:

- Construct a real upstream `TUI` with a no-op terminal (100 columns, 40 rows).
- Add N stable one-line `Text` components, warm with `doRender()`, then measure 30 unchanged `doRender()` calls.

| Stable lines | Full root render + differential comparison |
|---:|---:|
| 1,000 | 0.413 ms |
| 5,000 | 1.229 ms |
| 10,000 | 2.242 ms |
| 20,000 | 4.053 ms |

This confirms a remaining linear root cost, but also isolates cache invalidation/rebuild as the dominant extension-owned cost: 13,000 cached child lines are cheap, while rebuilding 13,000 lines costs 86.960 ms.

## Current-HEAD causal chain

1. Host-editor child mode wraps every widget render with `applySettingsPass()` in `src/tui/steer-view/host-editor-mode.ts:89-99` and `:109-116`. The degraded steer view does the same in `SteerViewComponent.applySettingsPass()` and `render()` at `src/tui/steer-view/steer-view-component.ts:119-122` and `:229-236`.
2. Host editor input requests a root repaint through upstream editor handling; live RPC lines also call `requestRender()` unconditionally in `host-editor-mode.ts:153-186`. Pi coalesces requests to at most roughly one render per 16 ms, but each admitted render still executes the full pass.
3. `createMessageAssembler().applySettings()` iterates all `state.container.children` at `src/tui/child-conversation/assemble-message.ts:149-169`, unconditionally calling settings setters on every Tool, Custom, Bash, Assistant, and User component. It then calls `state.container.invalidate()` at `:170`.
4. Upstream component behavior makes those calls expensive:
   - `AssistantMessageComponent.setHideThinkingBlock()`, `setHiddenThinkingLabel()`, and `setOutputPad()` all call `updateContent(lastMessage)` without equality guards. `updateContent()` clears and recreates all Markdown/Text children (`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js:31-111`).
   - `UserMessageComponent.setOutputPad()` always calls `rebuild()`, replacing its Box and Markdown (`.../components/user-message.js:16-29`).
   - `ToolExecutionComponent.setExpanded()`, `setShowImages()`, and `setImageWidthCells()` always call `updateDisplay()`, recreating renderer output; `invalidate()` calls both child invalidation and `updateDisplay()` (`.../components/tool-execution.js:137-172`). Large expanded tool output is therefore reformatted repeatedly.
   - `Container.invalidate()` recursively invalidates every child, while `Markdown.invalidate()` clears `cachedText`, `cachedWidth`, and `cachedLines` (`node_modules/@earendil-works/pi-tui/dist/tui.js:73-89`; `dist/components/markdown.js:57-73`). Markdown's next render lexes the complete text and rewraps every rendered line (`markdown.js:74-137`).
5. The widget then renders the complete accumulated assembler container, with no viewport/tail bound, in `src/tui/child-conversation/render.ts:36-45`. `SteerViewComponent.render()` similarly renders the complete container before slicing the visible body (`steer-view-component.ts:229-241`).
6. Finally, upstream `TUI.doRender()` calls `this.render(width)` for the entire root and linearly compares `newLines` with `previousLines` (`node_modules/@earendil-works/pi-tui/dist/tui.js:980-1004` and `:1090-1109`). Differential terminal output reduces writes, not component traversal or line-array comparison.

The existing unit test currently codifies the problematic behavior: `test/unit/child-conversation-assembler.test.ts:222-232` asserts that unchanged `applySettings()` re-applies `setExpanded()` to every tool.

## Related boundaries, not the first fix

- Foreground streaming snapshots already omit `messages` via `snapshotResult(..., false)` (`src/runs/foreground/execution/single-attempt-events.ts:30-45`; `attempt-helpers.ts:64-73`), avoiding a full transcript array copy per event. `fireUpdate()` still calls `getFinalOutput(messages)` (`single-attempt-events.ts:48-52`), whose reverse scan can be history-dependent in the worst case, but it was not implicated by the decisive render benchmark.
- Slash live rendering is versioned and throttles time-label rebuilds to 500 ms while running (`src/extension/registration/message-renderers.ts:48-75`). `applySlashUpdate()` clones the bounded result/progress arrays, not a growing message transcript (`src/slash/slash-live-state.ts:188-221`). Keep this outside the first patch.
- Final inline subagent output is capped only during finalization at 200 KiB / 5,000 lines (`src/shared/types/constants.ts:21-24`; `src/shared/types/output-truncation.ts:23-61`). Child conversation transcript/tool components are not viewport-bounded, so very large historical outputs amplify both the invalidation bug and the residual root O(lines) cost.

## Narrowly prioritized fix and test proposal

### P0: make settings application change-driven

Boundary: `src/tui/child-conversation/assemble-message.ts` plus the two callers that invoke the pass.

- Retain the last applied `ViewerSettings` and expansion value.
- Return immediately when all effective values are unchanged.
- When values differ, call only setters affected by the changed field (assistant hide/label/pad, user pad, custom pad/expanded, tool expanded/images/width, bash expanded).
- Remove the unconditional final `state.container.invalidate()`. The affected upstream setters already rebuild/invalidate their own content. A real width/theme reset can use a separate explicit invalidation path.
- Preserve per-render TTL settings reads if desired; the important boundary is that an unchanged read must perform O(1) comparison and no historical component mutation.

Expected result: ordinary editor input and live child updates reuse old Markdown/tool caches. Work becomes approximately O(number of components traversed by cached render + rendered lines for root diff), rather than O(total historical Markdown/tool content reconstruction).

### P0 regression tests

1. Replace the test at `child-conversation-assembler.test.ts:222-232` with an idempotence test: after one applied snapshot, applying an equal snapshot must call no historical component setter and must not invalidate the container.
2. Add field-diff tests proving that changing one setting touches only relevant component classes and applies exactly once.
3. Add deterministic operation-count instrumentation around `Markdown.render`, `AssistantMessageComponent.updateContent`, `UserMessageComponent.rebuild`, and `ToolExecutionComponent.updateDisplay`: after warming a 1,000-message fixture, an unchanged settings pass plus render must produce zero old-message rebuilds/Markdown cache misses. Prefer counts over wall-clock assertions for CI stability.
4. Keep the fixed-shape benchmark above as an optional performance check across 50/200/500/1,000 messages. Report cached render and settings+render separately; do not make absolute milliseconds the correctness gate.

### P1: measure the residual upstream/root line cost before virtualizing

After P0, rerun both benchmarks and profile real editor keystrokes with 5k/10k/20k rendered lines. If the residual 2-4 ms root traversal is still user-visible with real Markdown/images, pursue a viewport/tail-aware child surface or an upstream retained/prefix line cache. Do not combine virtualization with P0: it is a larger scrolling/resize/Kitty-image correctness boundary and is unnecessary to remove the measured 86.960 ms regression.
