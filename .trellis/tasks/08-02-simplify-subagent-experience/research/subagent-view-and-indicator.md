# Subagent view, transcript scrolling, and async indicator research

## Scope

This note researches the current subagent conversation view, how its transcript rendering and scrolling differ from the main Pi conversation, the editor-top async-run indicator, and the lifecycle/state path that should make that indicator appear after a main-agent async dispatch.

No implementation or planning artifacts were changed as part of this research.

## Executive summary

There are two independent findings:

1. The normal interactive child conversation is not a replacement for the main conversation window. It keeps the host editor mounted and inserts a fixed-height extension widget above it. That widget renders only the newest rows of the child assembler on every frame and has no scroll state or input handling. The read-only degraded overlay does have explicit transcript scrolling, so the current implementation splits the desired behavior: the normal path is editable but unscrollable, while the fallback path is scrollable but not editable.
2. The missing editor-top indicator after normal main-agent async dispatch has a high-confidence root cause: the task-array path launches through `executeAsyncChain`, and that function no longer emits `SUBAGENT_ASYNC_STARTED_EVENT`. The tracker therefore never inserts the run into `state.asyncJobs`; the subsequent `tool_result` handler cannot recover because it renders only when that map is already non-empty. The legacy single-agent path still emits the start event correctly. Git history shows the chain start-event block was removed in commit `0be079a` while now-stale event-related imports and locals remained.

The indicator itself is already mounted in the intended location. `renderWidget` calls `ctx.ui.setWidget` without an explicit placement, and upstream Pi defaults extension widgets to `aboveEditor`. The primary defect is therefore a missing lifecycle transition, not widget placement or repaint timing.

## 1. Interactive child view architecture

### 1.1 Normal child mode is a host editor plus an extension widget

The normal interactive path intentionally keeps the real Pi editor mounted and focused, routes ordinary submissions to a selected child, and mounts a child-conversation widget above the editor:

- `src/tui/steer-view/host-editor-mode.ts:1-22` describes the host-editor routing model, slash ownership, and use of native child renderers.
- `src/tui/steer-view/host-editor-mode.ts:102-119` creates the widget factory and mounts it under `HOST_EDITOR_WIDGET_KEY` with `ctx.ui.setWidget`.
- `src/tui/steer-view/host-editor-mode.ts:134-143` seeds the assembler from the selected child's transcript.
- `src/tui/steer-view/host-editor-mode.ts:150-187` captures the actual widget `TUI` and requests repaints for incoming RPC lines, including streaming assistant and tool updates.
- `src/tui/steer-view/host-editor-mode.ts:233-262` removes the widget and status, unsubscribes output, disposes the assembler, and ends the viewer-side channel on close.
- `src/tui/steer-view/host-editor-mode.ts:267-296` creates and seeds a fresh assembler, mounts the widget, attaches stdout, watches channel closure, and sets a footer status when child mode opens.

The `ctx.ui.setStatus` value at `src/tui/steer-view/host-editor-mode.ts:293-295` is a separate extension status/footer entry. It is not the async-run widget shown above the editor.

The picker/controller chooses this host-editor path whenever it can resolve a conversation channel:

- `src/tui/steer-view/open-view.ts:42-59` filters and displays selectable targets.
- `src/tui/steer-view/open-view.ts:65-134` resolves the child channel and opens host-editor mode.
- `src/tui/steer-view/open-view.ts:97-130` uses the degraded read-only surface only when the channel is unavailable.
- `src/tui/steer-view/open-view.ts:136-157` also uses the read-only overlay when no host-editor integration was configured.
- `src/tui/steer-view/open-view.ts:159-197` owns the picker/view lifecycle.

This means the live interactive child experience is an extension of the parent UI, not a second instance of Pi's main interactive mode.

### 1.2 Native message renderer reuse does not provide main-window behavior

The child assembler deliberately ports the main message-composition pipeline:

- `src/tui/child-conversation/assembler.ts:1-11` states that the child transcript uses the same native components as the main view.
- `src/tui/child-conversation/assembler.ts:29-52` creates its own assembler state/container and seeds complete transcript records.
- `src/tui/child-conversation/assembler.ts:54-57` adds an immediate user-message echo for a routed prompt.
- `src/tui/child-conversation/assembler.ts:58-177` consumes streaming message and tool RPC records, including tool-call/result pairing and user-echo deduplication.
- `src/tui/child-conversation/assemble-message.ts:30-140` selects native user, assistant, tool, custom, and bash components and pairs tool results with their calls.
- `src/tui/child-conversation/assemble-message.ts:149-170` reapplies viewer/tool-expansion settings to the assembled components.

This provides strong visual and component-level parity. It does not give the child the main view's root container, history lifecycle, editor ownership, or viewport behavior. The child assembler owns a separate `Container`; the host only sees the rows returned by the extension widget.

### 1.3 The normal child widget is a moving tail, not scrollback

The key behavior is explicit in the widget renderer:

- `src/tui/child-conversation/render.ts:1-10` says the widget returns exactly `terminal.rows - chrome` rows and blank-pads short content to push parent chat into terminal scrollback.
- `src/tui/child-conversation/render.ts:17-19` hard-codes a conservative eleven-row estimate for header, editor, footer, and margin.
- `src/tui/child-conversation/render.ts:31-46` renders the entire assembler, then selects `content.slice(-availableRows)` and returns only that tail.

The component has no `focused` field, `handleInput`, `scrollOffset`, follow mode, or unseen-output state. Older rows still exist inside the assembler's container, but each widget render omits them before the root TUI sees the frame. Therefore:

- the visible child area follows the newest output;
- older child rows cannot be navigated inside the normal child UI;
- terminal scrollback may contain old differential-render frames and the parent transcript, but it is not a stable representation of the child's complete transcript;
- resizing recomputes the tail but does not create history navigation;
- the hard-coded `rows - 11` height is an estimate, not a measurement of the actual editor and surrounding chrome.

The existing tests lock in this tail-only behavior:

- `test/unit/child-conversation-render.test.ts:33-46` asserts the fixed height and blank padding that push parent chat into terminal scrollback.
- `test/unit/child-conversation-render.test.ts:57-66` explicitly asserts that the oldest child message rolls out while the newest stays visible.
- `test/unit/child-conversation-render.test.ts:68-76` checks resize behavior.
- `test/unit/child-conversation-render.test.ts:79-98` checks repeated-render stability and invalidation, not history access.
- `test/unit/host-editor-mode.test.ts:425-552` checks the header, prompt echo, streaming, native tool repaint, deduplication, and render stability. It has no PageUp/PageDown or transcript-history assertion.

The current phrase “full-height widget” is visually accurate but behaviorally incomplete: blank padding makes the current viewport look like a child window, while the renderer still discards every row older than its moving tail.

### 1.4 The degraded view has scrolling but no editor

The no-channel fallback demonstrates that this codebase already has a scroll-owning transcript viewport:

- `src/tui/steer-view/steer-view-component.ts:42-52` defines it as a full-screen, read-only degraded surface and documents PageUp/PageDown/Up/Down scrolling.
- `src/tui/steer-view/steer-view-component.ts:53-72` owns `scrollOffset` and `unseen` state.
- `src/tui/steer-view/steer-view-component.ts:133-169` follows new records at the bottom and increments unseen counts while scrolled away.
- `src/tui/steer-view/steer-view-component.ts:179-205` handles scrolling and clears the unseen count when returning to the bottom.
- `src/tui/steer-view/steer-view-component.ts:208-224` renders a bounded slice of all assembled rows according to `scrollOffset`.
- `src/tui/steer-view/open-view.ts:32` supplies a full-terminal overlay configuration for this surface.

Tests confirm the distinction:

- `test/unit/steer-view-component.test.ts:53-70` verifies the surface is read-only and ignores printable input.
- `test/unit/steer-view-component.test.ts:99-122` verifies the scroll keys and scrolling through a single wrapped message.
- `test/unit/steer-view-component.test.ts:124-143` verifies native message/tool rendering.

The current product behavior can therefore be summarized as:

| Surface | Child input | Live RPC rendering | Native message components | Explicit scroll/history | Full overlay |
| --- | --- | --- | --- | --- | --- |
| Host-editor child widget | Yes | Yes | Yes | No; moving tail only | No |
| Degraded child overlay | No | Transcript polling only | Yes | Yes | Yes |
| Main Pi conversation | Yes | Yes | Yes | Persistent root output/terminal scrollback | Root UI |

Neither child surface currently combines editability and explicit transcript navigation.

## 2. Comparison with the main Pi conversation

The installed upstream interactive mode has separate root containers for chat, status, widgets, and editor:

- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:275-299` constructs the `TUI`, persistent `chatContainer`, widget containers, and editor.
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:482-494` establishes root order: header, resources, chat, pending messages, status, widgets above, editor, widgets below, footer.
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1470-1506` mounts extension widgets and defaults their placement to `aboveEditor`.
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1548-1574` rebuilds the above/below widget containers.
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1674-1725` exposes extension UI APIs for status, widget, custom overlay, editor text/component, and tool expansion. It exposes no API to replace, hide, or reparent the private main `chatContainer`.

At the lower TUI layer:

- `node_modules/@earendil-works/pi-tui/dist/tui.js:96-105` shows that a `Container` concatenates every rendered row from its children.
- `node_modules/@earendil-works/pi-tui/dist/tui.js:955-978` locates the cursor only in the bottom terminal-height viewport.
- `node_modules/@earendil-works/pi-tui/dist/tui.js:980-1004` renders all root lines and treats the bottom terminal rows as the visible viewport before overlay composition.

The main conversation's historical rows participate in the root output and terminal scrollback because messages remain children of the persistent root `chatContainer`. There is no equivalent public extension hook that lets the child assembler become that chat container. The normal child widget instead contributes only the tail it returns for the current frame.

This creates an architectural limit for exact “same as main” behavior. With the current public API, a plugin can:

- place a custom component above the real editor;
- replace the editor component;
- open a full custom overlay;
- listen to terminal input.

It cannot atomically swap the parent chat root for the child chat root. A widget-based solution can add practical scroll state, but parent history remains beneath it in the overall root output. Exact root-history parity likely requires an upstream API for replacing/hiding the chat surface, or a purpose-built full-screen child overlay that owns both transcript navigation and an input/editor surface.

## 3. Async indicator implementation and placement

The async indicator is already an editor-top extension widget:

- `src/shared/types/constants.ts:36-46` defines `WIDGET_KEY = "subagent-async"`, the 250 ms poll interval, and the visible-job limit.
- `src/tui/render/widget-render.ts:12-23` creates the widget component.
- `src/tui/render/widget-render.ts:26-93` lays out active, queued, and finished jobs.
- `src/tui/render/widget-render.ts:99-106` removes the widget for zero jobs or calls `ctx.ui.setWidget(WIDGET_KEY, factory)` for active state.
- Upstream `interactive-mode.js:1473-1475` defaults an omitted widget placement to `aboveEditor`.

Thus `renderWidget` mounts precisely in the requested editor-top area. No placement change is necessary to explain the missing indicator.

The widget has sufficient state to redraw lifecycle/activity changes:

- `src/tui/render/widget-core.ts:11-36` includes status, activity, tool, agent, step, nesting, and progress data in the render key.
- `src/tui/render/widget-core.ts:46-69` computes the displayed job name and activity line.
- `src/tui/render/widget-core.ts:111-116` maps queued/running/complete/paused/failed states to glyphs.
- `src/tui/render/output-target.ts:69-74` maps `needs_attention` to “needs attention” and `active_long_running` to “active but long-running.”
- `src/tui/render/widget-layout.ts` constrains widget rows while preserving active-job visibility.

One semantic detail should be explicit in planning: `needs_attention` remains a running job and is currently expressed in the activity text. It does not receive a distinct warning glyph; the warning square is used for `paused` (`src/tui/render/widget-core.ts:111-116`). If acceptance requires a warning-colored/glyph-level attention state, that is additional product/UI work rather than part of the missing-start regression.

## 4. Intended async lifecycle

For an async execution, the intended data flow is:

```text
main-agent subagent tool call
  -> executor prepares effective async/session state
  -> async launcher spawns runner
  -> SUBAGENT_ASYNC_STARTED_EVENT
  -> tracker inserts queued job and immediately renders widget
  -> poller reads status.json every 250 ms
  -> running/activity/attention/completion redraws
  -> result watcher emits completion
  -> tracker retains terminal state briefly, then removes widget
```

The concrete code path is:

- `src/runs/foreground/executor/prepare-execution.ts:112-113` computes `effectiveAsync`.
- `src/runs/foreground/executor/prepare-execution.ts:187-203` creates foreground control state only for non-async execution.
- `src/runs/foreground/executor/create-executor.ts:39-67` prepares execution, runs the async path first, and immediately returns its result.
- `src/runs/foreground/executor/async-path.ts:17-37` gates the async path.
- `src/runs/foreground/executor/async-path.ts:73-120` sends every task-array dispatch to `executeAsyncChain`, even when the array has one task.
- `src/runs/foreground/executor/async-path.ts:123-166` uses `executeAsyncSingle` only for the legacy internal `agent`/`task` shape.
- `src/extension/registration/bridges.ts:27-30` only collapses tool rendering before delegating to the executor; it does not create indicator state itself.

The public schema now exposes task arrays as the execution contract:

- `src/extension/schemas/subagent-params.ts:5-43` defines management fields plus `tasks`, `concurrency`, `worktree`, `context`, `async`, and artifact/progress options.
- `src/extension/schemas/subagent-params.ts:30-41` contains the execution fields and no top-level public `agent`/`task` execution pair.

Consequently, the task-array/chain launcher is the normal main-agent dispatch path for both one-child and multi-child requests.

## 5. Root cause of the missing indicator

### 5.1 The normal task-array launcher never emits the start event

`executeAsyncChain` still imports event and nested-start dependencies, builds event-oriented metadata, and successfully spawns the runner, but it never publishes the start transition:

- `src/runs/background/async-execution/chain-execution.ts:1-10` imports `SUBAGENT_ASYNC_STARTED_EVENT`, lifecycle versioning, nested-event helpers, and turn-budget helpers.
- `src/runs/background/async-execution/chain-execution.ts:16-46` prepares the chain launch and async directory.
- `src/runs/background/async-execution/chain-execution.ts:58-88` builds runner steps and retains `eventChain` and `initialTurnBudget`.
- `src/runs/background/async-execution/chain-execution.ts:105-155` spawns the runner and checks errors.
- `src/runs/background/async-execution/chain-execution.ts:157-166` jumps directly from successful spawn to formatting the tool result.

There is no `ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, ...)` between spawn success and return.

The legacy single launcher demonstrates the intended contract:

- `src/runs/background/async-execution/single-execution.ts:173-208` publishes nested lifecycle state after a successful PID.
- `src/runs/background/async-execution/single-execution.ts:209-223` emits `SUBAGENT_ASYNC_STARTED_EVENT` with id, pid, session id, mode, agent, cwd, async directory, budgets, and nested route.
- `src/runs/background/async-execution/single-execution.ts:225-228` then returns the asynchronous start result.

A repository search finds the active start-event emit only in `single-execution.ts`, while the public path goes through `chain-execution.ts`.

### 5.2 The tracker has no job to render and tool_result cannot repair it

The extension wires start/completion events directly into the tracker:

- `src/extension/index.ts:291-296` subscribes `handleStarted` and `handleComplete`.
- `src/extension/index.ts:299-308` records the latest UI context on a subagent `tool_result`, but renders and starts polling only if `state.asyncJobs.size > 0`.
- `src/extension/index.ts:321-350` resets and restores persisted active jobs at session start, not immediately after each same-session launch.

The start handler is the state-creation transition:

- `src/runs/background/async-job-tracker/tracker.ts:178-217` validates session ownership, inserts a queued `AsyncJobState`, starts the poller, and immediately renders with `state.lastUiContext`.
- `src/runs/background/async-job-tracker/tracker.ts:51-176` polls status, reconciles activity and step data, rerenders when `widgetRenderKey` changes, and schedules terminal cleanup.
- `src/runs/background/async-job-tracker/tracker.ts:219-240` updates an existing job on completion and schedules retention cleanup.
- `src/runs/background/async-job-tracker/tracker.ts:243-275` resets or restores jobs for session lifecycle.

Without the chain start event, the map remains empty. The tool result therefore does not render, and no poller is created for the newly spawned run. A later session restart may restore the queued/running run from disk, but that is not an immediate same-session indicator and does not satisfy the dispatch behavior.

The completion path also does not reconstruct a missing job. `handleComplete` looks up the id and mutates it only if found (`tracker.ts:219-236`), although it still rerenders and schedules cleanup (`tracker.ts:237-240`). A fast run whose start transition was missed can therefore complete without the indicator ever existing.

### 5.3 Git history identifies the regression

Commit `0be079a` (`feat(api): simplify subagent params — remove chain, acceptance, clarify, share, budget/timeout/cwd overrides`) removed approximately 93 lines from `chain-execution.ts`. The removed block, formerly immediately after the spawn error check, did all of the following:

- derived first-step and flattened agent names;
- built `parallelGroups` and chain metadata;
- emitted the nested async-start record;
- emitted `SUBAGENT_ASYNC_STARTED_EVENT` with the session id, pid, mode, agents, chain shape, workflow graph, cwd, async directory, and budget metadata.

The current file retains imports and locals used by that block (`SUBAGENT_ASYNC_STARTED_EVENT`, lifecycle version, nested event helpers, `eventChain`, `initialTurnBudget`) but has no replacement event emission. That combination, plus the working single-launch behavior, makes accidental removal during API simplification the most likely explanation.

Root-cause confidence: **high**. The missing state transition is directly observable in the only public async launch path and fully explains why neither the immediate start handler nor the `tool_result` fallback mounts the widget.

## 6. Activity, attention, and completion propagation after a valid start

Once a job has been inserted, the rest of the lifecycle is present:

- `src/runs/background/runner/run-subagent.ts:37-46` writes initial status and checks activity once per second while running.
- `src/runs/background/runner/ops/runner-ops-activity.ts:140-194` computes per-step activity, promotes `needs_attention`/`active_long_running` into run status, writes control events, and persists status changes.
- `src/runs/background/runner/ops/runner-ops-step-updates.ts:117-129` also escalates repeated mutating-tool failures to `needs_attention`.
- `src/runs/background/async-job-tracker/tracker.ts:103-153` copies status, activity, current tool/path, counts, steps, nesting, and terminal state into the widget job and detects render-key changes.
- `src/tui/render/widget-core.ts:11-36` includes those fields in the render key.
- `src/tui/render/output-target.ts:69-74` turns activity state into user-visible text.
- `src/runs/background/result-watcher/watcher.ts:45-68` accepts only results belonging to the current session and deduplicates them.
- `src/runs/background/result-watcher/watcher.ts:102-140` optionally delivers intercom results and emits `SUBAGENT_ASYNC_COMPLETE_EVENT`.
- `src/runs/background/async-job-tracker/tracker.ts:219-240` renders completion/failure and schedules cleanup.
- `src/runs/background/async-job-tracker/tracker.ts:39-49` removes the retained terminal job and rerenders; default retention is ten seconds (`tracker.ts:26-27`).

The tracker poll interval is 250 ms, while the runner's idle/activity derivation runs once per second. Those intervals are consistent with prompt status updates after the initial event exists.

Session scoping is deliberate and should be preserved in any correction:

- `src/runs/background/async-job-tracker/tracker.ts:178-182` ignores a start event if its session id does not match the active session.
- `src/runs/background/async-job-tracker/tracker.ts:219-223` applies the same rule to completion.
- `src/runs/background/async-job-tracker/tracker.ts:259-275` restores only jobs for the current session.

Any restored chain start payload therefore needs the current `sessionId`; omitting it would still cause the tracker to reject the event when session scoping is active.

## 7. Planning implications for the child view

The code supports two plausible directions, each with a different parity ceiling.

### Direction A: add scroll state to the host-editor widget

The child widget could retain a `scrollOffset`, intercept PageUp/PageDown while child mode is active, render a historical slice rather than an unconditional tail, track unseen output, and return to follow mode at the bottom. `SteerViewComponent` already provides a local model for that state machine.

Advantages:

- preserves the real host editor and current prompt/slash routing;
- reuses the live child channel and existing assembler;
- smaller architectural change.

Limits/risks:

- the child remains an extension widget above the parent editor, not the main chat root;
- the parent chat remains beneath it in root/terminal scrollback;
- terminal key interception must avoid conflicting with editor history/navigation and other extension listeners;
- `terminal.rows - 11` remains a brittle approximation when editor height or other widgets change;
- behavior can be practically useful but not literally identical to main root-history behavior.

### Direction B: use a full custom interactive overlay/surface

A full-terminal custom component could own transcript viewport state, explicit input routing/editor behavior, focus, follow/unseen state, and resizing as one surface. The existing degraded overlay already supplies transcript scrolling; it would need a real editable input surface and live channel integration.

Advantages:

- clean ownership of the visible transcript and scroll keys;
- no parent transcript mixed into the visible child surface;
- height is based on the actual overlay rather than a hard-coded root chrome estimate.

Limits/risks:

- recreating or embedding editor-equivalent behavior is more work than reusing the host editor;
- built-in parent slash, autocomplete, image, and editor semantics need deliberate routing;
- a custom overlay still is not the upstream main `chatContainer`; exact reuse may need new upstream API.

### Exact parity boundary

If “same as the main agent window” means identical root transcript/terminal-scrollback semantics, neither current extension surface can provide it cleanly. The public UI context has no chat-container replacement/hide operation (`interactive-mode.js:1674-1725`). Planning should either:

- define parity behaviorally (editable, native rendering, full transcript navigation, follow/unseen, resize), allowing a widget or overlay implementation; or
- explicitly include an upstream Pi API change that permits replacing/hiding the main chat surface.

This is a product/architecture decision; the research evidence does not justify silently choosing one.

## 8. Likely tests

### 8.1 Async start-event regression tests

Highest-value regression coverage is an end-to-end assertion from the public task-array contract to widget state:

1. Add a direct `executeAsyncChain` test with a stubbed successful runner spawn and captured event bus. Assert exactly one `SUBAGENT_ASYNC_STARTED_EVENT` after a PID is returned, with:
   - `id`, `pid`, `sessionId`, `mode`, `cwd`, and `asyncDir`;
   - flattened `agents`;
   - `chain`, `chainStepCount`, and `parallelGroups`;
   - `workflowGraph` and relevant optional budget/timeout/nested fields.
2. Assert no start event when directory creation, validation, spawn, or spawn-result error fails.
3. Cover both one-task and multi-task arrays. This is essential because one public task still uses `executeAsyncChain` (`src/runs/foreground/executor/async-path.ts:73-120`).
4. Add an executor/extension integration test using the public `tasks` shape. Capture the start event and assert that it reaches `handleStarted`, inserts the job, and calls `setWidget("subagent-async", factory)` immediately rather than relying on session restore.
5. Keep the legacy single-launch assertion so both launchers continue to satisfy the same lifecycle contract.

Existing useful tracker coverage:

- `test/integration/async-job-tracker-lifecycle.test.ts:81-107` provides a widget/render-request harness.
- `test/integration/async-job-tracker-lifecycle.test.ts:110-132` covers completion retention and removal.
- `test/integration/async-job-tracker-lifecycle.test.ts:134-224` covers restoring active session-scoped jobs.
- `test/integration/async-job-tracker-lifecycle.test.ts:238-263` covers start/completion session filtering.
- `test/integration/async-job-tracker-lifecycle.test.ts:296-322` covers flattened start-event agents and initial parallel-group state, but calls `handleStarted` directly rather than proving the launcher emits it.
- `test/integration/async-job-tracker-lifecycle.test.ts:376-428` covers redraw only for changed polled status.
- `test/integration/async-job-tracker-lifecycle.test.ts:430-462` covers cleanup when polling observes completion without a completion event.

The missing coverage is specifically the producer-to-consumer join: public task dispatch -> chain launch -> start event -> tracker state -> widget mount.

### 8.2 Activity/attention/completion widget tests

Add or extend tests around `test/integration/render-widget-detail.test.ts`, `test/integration/render-widget-layout.test.ts`, and the tracker lifecycle suite to assert:

- queued -> running -> `needs_attention` activity text -> complete/failed -> removal;
- a status-file `activityState` change alters `widgetRenderKey` and requests a redraw;
- “needs attention” is visible while the job remains `running`;
- active jobs remain represented when the adaptive row budget hides older finished jobs;
- completion is retained for the configured duration and then clears `WIDGET_KEY`.

If product acceptance expects a warning glyph/color for attention, add a renderer assertion for that separately; current behavior guarantees attention text, not a status-glyph change.

### 8.3 Interactive child transcript tests

The current tail-loss assertion at `test/unit/child-conversation-render.test.ts:57-66` should be replaced or complemented according to the selected architecture. Behavioral coverage should include:

- older transcript rows remain reachable after enough output to overflow the viewport;
- PageUp/PageDown (and any chosen line keys) move through wrapped rendered rows, not merely message records;
- new live output follows automatically at the bottom;
- new output while scrolled up preserves the historical position and surfaces an unseen count/marker;
- returning to the bottom clears unseen state and resumes following;
- terminal resize clamps the offset without dropping history;
- prompt submission and RPC streaming continue while the view is at the bottom;
- tool-call/result components remain paired while navigating history;
- opening/closing/switching child targets resets or deliberately preserves the right viewport state;
- parent input does not receive child-routed prompts or intercepted scroll keys;
- teardown removes terminal listeners, widget/overlay state, and repaint callbacks.

Useful existing seams:

- `test/unit/steer-view-component.test.ts:99-122` is the existing wrapped-row scroll model.
- `test/unit/host-editor-mode.test.ts:425-552` is the existing live interactive rendering model.
- `test/integration/steer-view-entry.test.ts:123-205` verifies picker-to-host-editor activation and can be extended to assert that the selected live child receives the new full interactive surface.

An integration-level viewport test should use enough parent and child history to detect accidental mixing: scrolling the active child must expose older child rows, not the parent conversation that happens to sit beneath the widget in root output.

## 9. Recommended implementation order for later planning

Without editing code here, the evidence suggests this dependency order:

1. Restore the chain launcher's start-event contract and add producer-to-widget regression coverage. This is a bounded lifecycle regression with high confidence and is independent of the view architecture choice.
2. Define “main-equivalent scrolling” behaviorally versus literally. Decide whether preserving the real host editor is more important than owning a clean full-screen transcript surface.
3. Implement one child viewport state machine shared where practical between normal and degraded paths, including offset, follow mode, unseen output, resize clamping, and teardown.
4. Add interactive history/navigation integration coverage before removing the current tail-only assumptions.
5. Decide separately whether `needs_attention` text is sufficient or requires warning-level glyph/color treatment.

## 10. Open product decisions, not unanswered code questions

The repository evidence resolves the missing indicator cause and the current scrolling limitation. The remaining choices are product intent:

1. Does “same as main” require identical terminal/root scrollback, or the observable behaviors of full transcript access, native rendering, live updates, input, and resize?
2. Should child mode preserve the exact host editor/autocomplete/slash experience even if the transcript remains an extension widget, or should a clean full-screen child surface take precedence?
3. Is “needs attention” activity text sufficient, or must attention have a distinct warning glyph/color and stronger visual priority?

These decisions materially affect architecture and should be resolved in planning rather than inferred during implementation.
