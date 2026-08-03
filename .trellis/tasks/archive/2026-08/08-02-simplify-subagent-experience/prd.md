# Simplify and unify subagent experience

## Goal

Make subagent sessions feel like normal agent sessions while simplifying how users enter, leave, configure, and wait on subagent runs.

## Background

- Pi 0.83.0 exposes the canonical `app.exit` action (default Ctrl+D) through the live keybinding manager, including remaps and removals from `~/.pi/agent/keybindings.json` (`research/commands-exit-keybindings.md:180-228`). Pi removed built-in `/exit`; `/quit` is handled by the host before normal extension input and the public API has no cancellable semantic exit event (`research/commands-exit-keybindings.md:135-178`).
- This package currently registers 14 explicit commands and publishes seven slash-invocable prompt templates. Pi conventionally loads a package `prompts/` directory if the manifest prompt entry is absent, so removing only the manifest key is insufficient (`research/commands-exit-keybindings.md:17-89`).
- The interactive child view preserves Pi's real editor, input routing, and native message components, but `src/tui/child-conversation/render.ts:31-46` slices the assembler output to the newest viewport-sized tail. `src/tui/steer-view/host-editor-mode.ts:134-143` also limits fallback history to 80 lines. Pi's public extension API cannot replace or hide the private main chat container, but a widget can contribute the complete child transcript to root output and terminal scrollback (`research/subagent-view-and-indicator.md:19-137`).
- The editor-top async indicator already exists and defaults to `aboveEditor`. The public task-array launcher `src/runs/background/async-execution/chain-execution.ts:105-166` no longer emits `SUBAGENT_ASYNC_STARTED_EVENT`, so the tracker cannot create the job that mounts the indicator; commit `0be079a` removed that event block (`research/subagent-view-and-indicator.md:139-243`).
- Pi's standard keybinding manager ignores unknown extension action IDs and `registerShortcut()` accepts literal keys, not remappable action IDs. A no-default picker binding therefore requires a package-owned parser for `subagents.openPicker` (`research/commands-exit-keybindings.md:302-378`).
- Bundled agents are discovered from the published package-root `agents/` directory. Removing the seven specialized files does not alter user, project, or third-party package discovery (`research/tool-wait-builtins-rendering.md:30-91`).
- The standalone wait currently has snapshot, exact/unique-prefix, first/all, attention, abort, and polling semantics but also a 30-minute orchestration timeout. Normal public `tasks[]` execution is always labeled parallel and synchronous execution still uses a separate foreground path. The result watcher deletes each rich completion file immediately after emitting, so detached launch-plus-wait needs a session-scoped completion broker to return the full synchronous result without a race or duplicate notification (`research/tool-wait-builtins-rendering.md:93-470`).

## Requirements

1. The only built-in slash command exposed by this package is `/subagents`; remove all other package-provided slash commands and stop publishing or loading every bundled prompt template.
2. While the user is viewing a subagent session, route Pi's canonical `app.exit` action, the current `/quit` command, and the legacy `/exit` spelling through one shared `/subagents exit` teardown. The action path must honor the live default or custom exit bindings from `keybindings.json` and preserve the main editor's empty-input exit semantics.
3. Remove the built-in Down-arrow shortcut that opens the subagent picker. Users may configure the extension-owned `subagents.openPicker` action in `~/.pi/agent/keybindings.json` with one key, multiple keys, or `[]`; there is no default entry or fallback key. The extension must re-read this namespaced entry when Pi reloads configuration and retain the current empty-editor, available-target, and no-package-modal safety gates.
4. Remove every built-in subagent definition except a blank `delegate` fallback, so the extension remains usable with zero user configuration. Its definition contains only the required neutral identity metadata: no body/system prompt, specialized role, workflow, explicit tool restriction, skill list, or default reads. Omitted fields use the runtime's neutral `delegate` defaults: normal available tools, appended empty prompt, inherited project context, and no inherited skills.
5. Render a subagent session at full available size while preserving Pi's real host editor. The complete child transcript must participate in terminal scrollback instead of being sliced to a moving viewport tail. Preserve the main editor's autocomplete, image handling, slash routing, custom keybindings, and native input behavior so the child view is observably as close to the main agent view as the public extension API permits.
6. Fold waiting into the `subagent` tool as `subagent({ action: "wait", id?, all? })` and remove the standalone `wait` tool. Waiting has no elapsed-time limit. With no target, snapshot current-session active runs and wake on the first completion or actionable attention event; `all: true` waits for every snapshotted run unless attention intervenes; `id` waits for an exact run or unique ID prefix. A synchronous subagent invocation is semantically a detached asynchronous launch followed by an indefinite wait for its new run ID, returning the full normal result.
7. Determine execution mode from count-expanded invocation cardinality and propagate that canonical mode through tool-call labels, launch metadata, persisted status, active-run indicators, and final results. Exactly one concrete invocation (one task with omitted `count` or `count: 1`) is `single` and must never display `parallel`; `count` greater than one or multiple concrete invocations is `parallel`.
8. Every detached runner launch, including a nominally synchronous call while its integrated wait is active, must immediately show the active-run indicator at the top of the editor and keep the indicator consistent with run attention/completion state. A sync-owned run remains visible and navigable if waiting returns early for attention or cancellation.

## Constraints

- Preserve user-configured exit shortcuts by matching the live shared `app.exit` action rather than hard-coding Ctrl+D or recognizing slash-command text.
- Pi's double-Ctrl+C emergency process exit remains host-owned and is not reimplemented or intercepted by the package.
- The `/quit` and legacy `/exit` adapters are package-only raw-submit interception because Pi 0.83.0 does not expose a cancellable exit hook. They must resolve the live `tui.input.submit` binding and act only while child mode is active.
- Existing unrelated user changes in the worktree must not be overwritten.
- User, project, and third-party package agent/prompt configuration remains supported; only this package's opinionated built-ins are removed.
- Exact replacement of Pi's private main chat container is not required; host-editor behavior and complete, scrollable child history are required.
- Cancelling the main tool call/turn may abort its wait, but must leave the detached subagent run alive.
- `needs_attention` and pending actionable supervisor decision/interview requests wake an integrated wait; ordinary progress and `active_long_running` do not.
- With no `id`, integrated wait snapshots only runs active at call start. With an `id`, exact match wins over a unique prefix; ambiguity is an error, and no active match returns immediately.
- Automatic background completion notification is suppressed only while a synchronous integrated wait owns that run's result, preventing duplicate output; independently detached work retains normal completion notification behavior.
- Sync-owned completions are cached before event emission/file unlink in a bounded, TTL-pruned, session-scoped broker. Attention or abort releases synchronous ownership without stopping the detached runner.
- Package-owned picker binding parsing accepts only valid string, string-array, or empty-array shapes. Because the host ignores this unknown action ID, it intentionally uses raw key matching and does not promise host conflict reporting, `/hotkeys` display, or leader-key prototype patches.
- The `delegate` fallback keeps the established loader defaults for omitted fields: empty appended system prompt, inherited project context, no inherited skills, and Pi's normal available toolset.
- Preserve the host-editor/native-renderer/child-channel architecture established by `.trellis/tasks/archive/2026-08/08-01-subagents-native-view-parity/design.md`; this task changes history contribution, exit/entry routing, and execution lifecycle rather than replacing that architecture.

## Acceptance Criteria

- [ ] `/subagents` is the only package-provided slash entry that remains registered, loaded, and documented; a default installation exposes no package prompt templates.
- [ ] Triggering any configured `app.exit` binding with an empty editor, submitting `/quit`, or submitting legacy `/exit` while focused on a subagent returns to the parent view through the same subagent-exit teardown rather than terminating the parent process; non-empty-editor key behavior matches Pi's main editor.
- [ ] Down arrow and all other keys pass through by default; `subagents.openPicker` accepts a string, string array, or `[]` in `keybindings.json`, updates after configuration reload, and opens only when the existing safety gates pass.
- [ ] `delegate` is the only built-in subagent definition discovered on a default installation; its file has only required neutral identity metadata and loads with no body, explicit tools, skills, or default reads.
- [ ] The subagent transcript uses the available terminal viewport, keeps Pi's real editor active, and exposes complete child history through terminal scrollback instead of dropping older rendered rows.
- [ ] Child mode retains main-editor autocomplete, images, slash routing, custom keybindings, input submission, and live native message/tool rendering.
- [ ] The standalone `wait` tool is absent; `subagent({ action: "wait", id?, all? })` preserves current-session snapshot, exact/unique-prefix targeting, first/all, attention, and abort-without-cancellation semantics without an orchestration timeout.
- [ ] Synchronous subagent execution uses the same launch path as asynchronous execution and then applies the integrated wait behavior.
- [ ] One task with omitted `count` or `count: 1` is consistently `single` everywhere and never displays `parallel`; one task with `count > 1` and multiple concrete invocations are consistently `parallel`.
- [ ] Every detached launch, including sync launch-plus-wait, immediately displays the editor-top active-run indicator; attention/completion transitions update or remove it correctly, and sync ownership does not produce a duplicate completion turn.
- [ ] Fast completion before wait subscription/file unlink still returns normalized full child task/output/error/exit/usage, status, sessions, model attempts, artifacts, structured output, workflow/output metadata, and available token/cost totals; legacy results with unavailable per-child usage use explicit zero values rather than invented allocation.
- [ ] Relevant automated tests and user-facing documentation are updated.

## Out of Scope

- Adding a new Pi host keybinding action/API, replacing Pi's private `chatContainer`, or implementing a package-owned custom editor.
- Intercepting Pi's double-Ctrl+C emergency exit path.
- Removing user, project, or third-party prompt/agent discovery, or removing the internal prompt-template event bridge when it exposes no package slash entry.
- Redesigning attention glyphs/colors, terminal scrollback controls, persistent RPC child transport, or the child conversation bridge.
- Removing runner-level deadlines/budgets; a runner deadline remains a normal failed terminal completion that wakes integrated wait.

