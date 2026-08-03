# Design: simplify and unify subagent experience

## 1. Architecture and boundaries

This change keeps the existing extension architecture and makes four coordinated boundary changes:

```text
Pi host
├─ slash/resources        → only /subagents; no bundled prompt templates
├─ terminal router        → child exit adapter + optional namespaced picker binding
├─ host-editor child view → full assembler history contributes to root scrollback
└─ subagent tool
   ├─ management action: wait
   └─ execution: normalize → canonical mode → detached runner
       ├─ async:true  → launch receipt
       └─ sync policy → exact-run wait → full completion conversion
                         ↑
                  session completion broker
```

The prior host-editor/native-renderer/child-channel design remains authoritative: Pi's real editor stays mounted, child input still routes through `HostEditorConversationHandle`, live foreground and async children still share `ChildConversationChannel`, and the parent never replaces or writes the child's session. Exact replacement of Pi's private root chat container is unavailable through Pi 0.83.0 and is not part of this task.

## 2. Command, prompt, and builtin resource surface

### Slash registration

`registerSlashCommands()` registers exactly one command, `subagents`. Remove the execution, cost/doctor/fleet, prompt-workflow, and profile registration fan-outs from the default registration path. The underlying tool/profile/domain modules may remain when used elsewhere; the requirement removes package slash adapters, not the capabilities behind them.

Keep the prompt-template bridge only as non-command framework plumbing for user/project/third-party integrations. It must not discover or register bundled workflows.

### Packaged prompts

Delete the seven bundled `prompts/*.md` resources, remove `prompts/**/*` from `package.json#files`, and set `pi.prompts` to `[]`. The explicit empty array is intentional: Pi convention-falls back to a package-root `prompts/` directory when the manifest entry is absent. A package-resource regression test must prove that a clean installation contributes no prompt templates.

### Builtin agents

Delete `context-builder`, `oracle`, `planner`, `researcher`, `reviewer`, `scout`, and `worker`. Rewrite `agents/delegate.md` to frontmatter containing only:

```yaml
name: delegate
description: Neutral fallback subagent for delegated work
```

No body or other frontmatter is present. Discovery, precedence, package agents, user agents, project agents, and disabled/override handling do not change.

## 3. Child entry and exit routing

### Shared child exit operation

Extract one idempotent child-view teardown operation used by:

- `/subagents exit` and `/subagents close`;
- canonical `app.exit` while child mode is active and the editor is empty;
- raw submission of `/quit` or legacy `/exit` while child mode is active.

The operation closes host-editor mode, closes a picker/degraded modal if present, clears widget/status/assembler/validator/channel/target state through the existing close paths, and may emit the current informational notice. It never terminates the parent session.

### Canonical exit action

Install a high-priority terminal handler before the existing child app-action route. Resolve the live global `getKeybindings()` singleton and call `matches(input, "app.exit")`. Consume only when:

1. child host-editor mode is active or the package's subagent picker/degraded-view modal is open;
2. `ctx.ui.getEditorText()` is empty;
3. the current input matches the live canonical action.

When the editor is non-empty, pass through so the editor retains delete-char-forward behavior. Remapped, multiple, removed (`[]`), migrated legacy, and runtime-patched bindings follow the host manager automatically.

### `/quit` and legacy `/exit`

Pi handles `/quit` inside the host submit callback before extension `input` events. The adapter therefore observes raw terminal input, resolves `tui.input.submit` through the same live manager, reads current editor text, and consumes/tears down only for the exact trimmed `/quit` or `/exit` text while editable host-editor child mode is active. It clears the editor before closing so the parent cannot submit the text after teardown. Read-only package modals have no slash-submit path. This is an explicit Pi 0.83.0 package adapter, not a claim of a semantic exit hook.

Double-Ctrl+C remains untouched.

### Namespaced picker binding

Retire `tui.openSubagentsOnDown`, `DEFAULT_TUI_CONFIG`, and the hardcoded Down handler. Add a focused keybinding reader for `<agentDir>/keybindings.json`:

- action key: `subagents.openPicker`;
- accepted values: one valid key string, an array of valid key strings, or `[]`;
- absent/invalid value: no binding; malformed file is reported once through the existing UI notification/logging path without crashing Pi;
- no default and no fallback;
- read once when the extension runtime is created; Pi `/reload` reconstructs the runtime and rereads the file, so no watcher is added.

Validate key IDs against the supported Pi TUI key grammar before casting to `KeyId`, deduplicate them, and match with `matchesKey`. Because Pi ignores unknown extension action IDs, this adapter intentionally does not claim native conflict detection, `/hotkeys`, keybinding migrations, or leader-key prototype behavior. Preserve the existing gates: UI available, editor empty, target selectable, package modal closed.

Terminal handler order becomes: shared child exit adapter, configured picker adapter, then child app-action route.

## 4. Complete child transcript in root scrollback

The host editor and existing native assembler remain. Change the widget's render contract from “exact viewport-sized moving tail” to:

1. render a child status header plus the assembler's complete rendered history;
2. append blank padding only when total output is shorter than `terminal.rows - chrome`, preserving the current full-height child appearance and pushing the parent tail out of the visible viewport;
3. never apply `content.slice(-available)` or a final viewport clamp.

The TUI root then receives every child row. Its bottom-anchored viewport shows the newest child rows while older rows become stable terminal scrollback, matching the main conversation's root-output model as closely as the extension API allows. No internal scroll offset or PageUp/PageDown interception is introduced; terminal scrollback owns navigation.

Seeding must be complete wherever a complete source is available:

- `createTranscriptTail(...).poll()` already reads the full trusted transcript incrementally and skips malformed lines safely;
- replace the arbitrary fallback `80` argument with an explicit full-history fallback reader for the host-editor seed path;
- read trusted output/session fallback files completely for this host-editor path, incrementally where practical, with no semantic line or byte cap. Keep the degraded read-only fleet view's existing bounded preview contract separate. When a source is inherently only `recentOutput`, seed what exists.

Tests must include enough parent and child history to prove old child rows remain in the root render output and parent rows are not mistaken for child history.

## 5. Canonical execution mode and detached launch lifecycle

### Normalize once

After `count` expansion, compute:

```text
concrete invocation count == 1 → single
concrete invocation count > 1  → parallel
```

Store this `SubagentRunMode` in prepared execution data and reuse it for spawn reservation, nested metadata, launcher selection, status/events, indicator, tool-call label, and final details. Do not infer mode again from `tasks.length`.

One concrete task adapts to `executeAsyncSingle`; multiple concrete tasks adapt to `executeAsyncChain`. Clean up stale undeclared top-level `agent`/`task` branches in `async-path.ts` and the unreachable foreground single flags. The old direct foreground runners cease to be the normal public execution mechanism; shared helpers may remain only where still used by resume/compatibility code.

`async` now controls return policy, not runner mechanism:

- `async:true` launches and immediately returns the launch receipt;
- default/`async:false` claims sync ownership, launches the same detached runner, and waits for the exact generated run ID.

Tool-call `[async]` presentation reflects the resolved caller detach policy (explicit `async` plus configured/forced defaults), never the fact that the internal runner is always detached.

Generate the run ID once during preparation. A successful detached launch always emits its start event before returning. A failed launch emits no start event and clears any ownership claim.

### Start events and indicator

Keep `executeAsyncSingle`'s existing event contract. Restore equivalent post-spawn behavior in `executeAsyncChain`: emit nested start metadata when nested and `SUBAGENT_ASYNC_STARTED_EVENT` with lifecycle version, run ID, PID, current session ID, canonical mode, cwd, async directory, flattened agents, chain/parallel/workflow data, nested route, and applicable budgets/deadline.

The tracker remains the sole indicator-state owner. It inserts the job on start, polls status/attention, retains terminal state under its current policy, and mounts `WIDGET_KEY` above the editor. Sync launches use this same event, so they appear immediately while their wait is active and remain visible if the wait returns for attention or abort.

## 6. Integrated wait contract

Add `wait` to `SUBAGENT_ACTIONS` and `all?: boolean` to the public `SubagentParams` schema/type. Remove `WaitParams`, standalone tool registration, wait enablement config/env, and every `timeoutMs` orchestration branch.

Dispatch `action:"wait"` before generic agent-management actions. Root and child-safe fanout use the same schema and wait primitive. Inject authorized lifecycle roots into the executor: the root runtime observes `ASYNC_DIR`/`RESULTS_DIR`; a fanout child observes only `TEMP_ROOT_DIR/nested-subagent-runs/<rootRunId>` and `RESULTS_DIR/nested/<rootRunId>`. This keeps general wait and default synchronous calls functional inside child-safe fanout without broadening visibility to unrelated runs. If a future runtime cannot resolve an authorized lifecycle root, it returns a clear “unavailable in this subagent context” management result.

The wait primitive preserves subscribe-before-reconcile and poll fallback:

1. resolve active runs owned by the current session;
2. for `id`, prefer exact match, otherwise require one unique prefix;
3. snapshot target IDs;
4. subscribe to completion/control/supervisor events before the next reconciliation;
5. poll persistent status as a missed-event fallback;
6. return on the contract predicate.

Predicates:

- no `id`, `all` omitted/false: first snapshotted run terminal or actionable attention;
- no `id`, `all:true`: all snapshotted runs terminal, unless any requires actionable attention;
- `id`: that exact resolved run terminal or actionable attention;
- no active match: return immediately;
- terminal: complete, failed, or paused;
- actionable: `needs_attention`, pending `need_decision`, or pending `interview_request` scoped to a snapshotted run;
- not actionable: `active_long_running` or `progress_update`.

AbortSignal ends only this tool call. It does not interrupt/kill the detached runner. There is no elapsed orchestration timeout; runner-level deadlines remain terminal failures.

## 7. Completion broker and synchronous result reconstruction

### Broker ownership

Add a focused completion-broker module owned by `SubagentState`, with:

- normalized full completions keyed by run ID;
- synchronous ownership records keyed by run ID and session ID, including canonical mode and the concrete task descriptors needed to reconstruct `SingleResult` fields;
- bounded entry count and TTL timestamps;
- methods to claim, cache-before-publish, inspect/wait, release ownership, reset for session, and dispose.

Initialize it in both root and child-safe state constructors. The root result watcher feeds it from `RESULTS_DIR`; child-safe fanout starts the same watcher against its authorized nested-results root. Session start drops entries from other sessions and prunes expired data. Runtime/session shutdown disposes waiters and ownership without affecting runners.

### Result watcher ordering

Expand `ResultFileData`/child types to faithfully model the rich payload written by `runner-finalize.ts`, including child output/error/status, task, exit code, usage, session, model attempts, cost, artifacts, truncation, transcript, structured output, output map, workflow graph, aggregate tokens/cost, timestamps, duration, and run metadata. Extend `StepResult`/finalization to persist actual `task`, `exitCode`, and `usage` values already known by the runner; do not derive those per-child values from aggregate run totals.

The result watcher must:

1. parse and validate session ownership;
2. normalize nested/child results;
3. cache the full normalized completion in the broker;
4. deliver result intercom if configured;
5. emit completion;
6. unlink the result file.

This ordering makes fast completion safe even when a synchronous executor has not yet begun awaiting the event.

### Sync result conversion

The exact-run sync wait returns:

- full normal `AgentToolResult<Details>` after complete/failed/paused, reconstructed from the cached completion;
- an actionable nonterminal management/receipt result with run ID and reply/status instructions if attention wakes the wait while the runner remains active;
- an aborted result if the parent turn is cancelled, while the runner continues.

Map all available result fields faithfully and reuse existing result-output formatting helpers so synchronous content remains equivalent to the old normal result, not merely a metadata receipt. For legacy completion files without persisted per-child `Usage`, use an explicit zero usage object, retain aggregate token/cost data in the available details/result metadata, and never synthesize per-child values from an aggregate.

### Notification suppression

`registerSubagentNotify` consults broker ownership when handling completion. Suppress automatic `triggerTurn:true` only for a run still sync-owned at notification time. Ordinary `action:"wait"` is an observer and never claims ownership, so independently async launches retain normal notification behavior.

On completion, attention, abort, launch failure, session reset, and TTL expiry, ownership is released. Completion cache retention is independent and bounded so a waiter can still recover a fast terminal result.

## 8. Compatibility, documentation, and spec migration

This is intentionally breaking for package-owned conveniences:

- removed slash commands and prompt templates have no compatibility aliases;
- removed builtin roles are not redirected to `delegate`;
- `tui.openSubagentsOnDown`, `waitTool`, and `PI_SUBAGENT_WAIT_TOOL_ENABLED` are removed rather than deprecated runtime shims;
- standalone `wait` calls must migrate to `subagent({ action: "wait", ... })`;
- callers relying on foreground in-process execution observe detached runner internals but retain default synchronous return behavior.

Update README, `skills/pi-subagents/SKILL.md`, tool descriptions, start-helper guidance, and CHANGELOG. Update `.trellis/spec/typescript/schema-and-type-safety.md` so one task is canonical `single`, and rewrite the stale entry/view/execution portions of `.trellis/spec/typescript/subagent-interactive-control.md` to specify the no-default picker action, shared exit adapter, host-editor complete-history output, detached-unified runner, integrated wait, completion broker, and immediate indicator. Historical archived task artifacts remain unchanged.

## 9. Operational risks and rollback

| Risk | Mitigation / rollback seam |
| --- | --- |
| Raw `/quit` interception drifts from Pi | Isolate in a small adapter pinned by Pi 0.83.0 tests; removing the adapter falls back to canonical `app.exit` without touching teardown. |
| Invalid picker key consumes ordinary input | Strict grammar validation, no default, raw matcher tests, and pass-through on every failed gate. |
| Full history creates very large render frames | Preserve trusted-path/malformed-line defenses; use byte-safe fallback reads and test large histories. If performance regresses, optimize assembler/root contribution without reintroducing semantic line truncation. |
| Fast completion is lost or duplicated | Claim before launch, cache before emit/unlink, subscribe-before-reconcile, and notification ownership tests. |
| Sync ownership leaks | Bounded/TTL broker plus explicit finally/session-dispose cleanup. |
| Mode differs across layers | One helper and cross-layer assertions from call label through event/status/result. |
| Chain event metadata regresses | Producer-level event contract test and producer-to-tracker/widget integration test. |

Rollback can be staged by boundary: resource removals; terminal adapters; full-history renderer; integrated wait/schema; unified execution/broker. Do not roll back by restoring duplicate foreground and detached semantics partially: executor, broker, notification, and wait changes form one lifecycle contract.
