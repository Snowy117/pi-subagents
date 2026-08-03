# Subagent tool, wait, builtins, and rendering research

## Scope

Planning-only repository research for the `simplify-subagent-experience` task.
This note covers bundled agent discovery, the public tool contracts, current
sync/async execution, wait/attention semantics, completion transport, and
single-versus-parallel presentation. No implementation or planning artifact
was changed as part of this research.

## Executive findings

1. Bundled agents are not declared in the package manifest. Discovery always
   scans the package-root `agents/` directory, which is published verbatim.
   Deleting the seven non-`delegate` Markdown files is therefore sufficient to
   make `delegate` the only builtin without removing custom/package discovery.
2. Public execution is already `tasks[]`-only, but stale executor branches
   still assume legacy top-level `agent`/`task`. Every nonempty `tasks[]` is
   currently classified as parallel, making one task display and execute as
   `parallel (1)`.
3. The standalone `wait` tool snapshots the current session's active runs,
   supports first-completion/all/specific-id modes, wakes for terminal state or
   attention, and has a 30-minute orchestration timeout. It does **not** cancel
   runs when timeout or abort ends the wait.
4. `executeAsyncSingle` emits the async-start event immediately after spawn;
   `executeAsyncChain` imports that event constant but never emits it. The
   missing chain event prevents the editor-top tracker from appearing at launch
   and leaves later `tool_result` handling as an insufficient fallback.
5. Making synchronous execution “launch async, then wait” cannot safely reuse
   today's short wait summary. The result watcher emits a rich completion
   payload and immediately deletes its file, so sync needs a central,
   race-safe completion broker/cache and conversion back to the normal tool
   result shape.

## 1. Builtin definitions and discovery

### Discovery sources and precedence

- `src/agents/agents/discovery.ts:26` resolves `BUILTIN_AGENTS_DIR` to the
  package-root `agents/` directory.
- `src/agents/agents/discovery.ts:44-94` loads and applies model/settings
  overrides to builtins, loads package/user/project definitions, merges them,
  then filters definitions marked `disabled`.
- `src/agents/agents/discovery.ts:98-160` implements `discoverAgentsAll`; its
  builtin list intentionally retains disabled definitions for inspection.
- `src/agents/agents/discovery.ts:28-41` supports read-only extra user roots via
  `PI_SUBAGENT_EXTRA_AGENT_DIRS`. The normal user roots are legacy
  `~/.pi/agent/agents` and `~/.agents`; nearest project roots are resolved by
  the loading helpers.
- `src/agents/agents/loading.ts:18-43` recursively lists files in deterministic
  name order. `src/agents/agents/loading.ts:45-75` accepts `.md` but not
  `.chain.md`, excludes `.agents/skills`, and ignores definitions missing both
  required frontmatter fields, `name` and `description`.
- `src/agents/agent-selection.ts:3-23` merges in precedence order builtin,
  package, user, then project. Later sources shadow an earlier definition with
  the same runtime name.
- `src/agents/agents/package-discovery.ts:136-162` accepts package agent/chain
  roots under either `"pi-subagents": { "agents": ..., "chains": ... }` or
  `pi.subagents.{agents,chains}`.
- `src/agents/agents/package-discovery.ts:202-270` collects the current project,
  project/user package settings and installed package roots, and global npm,
  with root/path de-duplication.
- `package.json:23-31` publishes `agents/`. The `pi` manifest at
  `package.json:51-61` declares this package's extension, skills, and prompts,
  but does not separately declare subagent agents. The hardcoded builtin root
  is therefore the only source of this package's defaults.

### Current bundled set and required change

The package currently contains:

- `agents/context-builder.md`
- `agents/delegate.md`
- `agents/oracle.md`
- `agents/planner.md`
- `agents/researcher.md`
- `agents/reviewer.md`
- `agents/scout.md`
- `agents/worker.md`

`agents/delegate.md:1-18` is a lightweight general delegate that inherits the
parent model, has no default reads, and receives the normal research/editing
tool set plus `contact_supervisor`. Remove the other seven bundled files.
Custom user/project/package definitions and shadowing continue to work because
none of their discovery paths depend on the deleted builtins.

### Tests affected

- `test/unit/agent-discovery.test.ts` covers recursive project loading and
  runtime package identities.
- `test/unit/agent-package-discovery.test.ts:57+` covers both supported package
  manifest forms.
- `test/unit/agent-selection.test.ts:19+` covers builtin/package/user/project
  precedence.
- `test/unit/agent-disabled.test.ts:27-108` uses the bundled `reviewer` in
  disable/override tests; change those builtin-specific cases to `delegate` or
  to an isolated fixture.
- Add a clean-HOME/clean-project regression asserting that
  `discoverAgentsAll(cwd).builtin.map(a => a.name)` is exactly `["delegate"]`
  and runtime discovery exposes exactly that builtin by default.

Fixture names such as `worker`, `reviewer`, or `scout` do not all need global
renaming: tests that construct their own `AgentConfig` or local `.md` fixture
are not testing the published builtin set.

## 2. Public tool schemas and registration

### Existing schemas

- `src/extension/schemas/subagent-params.ts:5-44` defines the public
  `subagent` input. It has management/control fields (`action`, `id`, `index`,
  `view`, `lines`, `message`, `config`), schedule fields, and execution fields
  (`tasks`, `concurrency`, `worktree`, `context`, `async`, `artifacts`,
  `includeProgress`). It has no public execution timeout and no top-level
  execution `agent`/`task`.
- `src/extension/schemas/subagent-params.ts:31` already documents one task as
  single and multiple tasks as parallel.
- `src/extension/schemas/blocks.ts:18-25` requires `agent` and `task` per task;
  optional `count` repeats the task and must be at least one.
- `src/extension/schemas/wait-params.ts:4-17` gives standalone `wait` optional
  `id`, `all`, and positive `timeoutMs`, with a documented default of
  1,800,000ms.
- `src/extension/schemas.ts:1-2` exports both schemas.
- `src/shared/types/constants.ts:49` lists accepted subagent actions and does
  not currently include `wait`.

### Existing registration and call rendering

- `src/extension/registration/tools.ts:1-27` imports both schemas, the wait
  runtime/config, and wait-specific dependencies.
- `src/extension/registration/tools.ts:54-110` registers `subagent`.
- `src/extension/registration/tools.ts:57-63` calculates effective invocation
  count by summing task `count` values.
- `src/extension/registration/tools.ts:74-96` nevertheless sets
  `isParallel = tasks.length > 0`, so a single task is rendered as
  `subagent parallel (1)`. The action branch also reads stale `args.agent`
  rather than the current `id` target.
- `src/extension/registration/tools.ts:112-130` separately registers `wait` and
  embeds first/all/id, 30-minute timeout, attention, and disable-config text.
- `src/extension/tool-description.ts:8-77` describes single as a one-element
  task array, but all async safety guidance tells callers to use standalone
  `wait`; management examples also hardcode builtins that will be removed.

### Recommended replacement contract

Keep one public tool named `subagent` and add integrated management wait:

```text
subagent({ action: "wait" })
subagent({ action: "wait", all: true })
subagent({ action: "wait", id: "run-id-or-prefix" })
```

Concretely:

- add `all?: boolean` to `SubagentParams` and document `id` for `action=wait`;
- add `wait` to `SUBAGENT_ACTIONS` and route it in `action-dispatch.ts` before
  generic agent-management dispatch;
- remove `WaitParams`, its export, the standalone tool registration, and
  `waitTool` config/env behavior;
- do not add `timeoutMs` to the integrated action;
- reject or ignore mixed execution/action fields consistently with other
  management actions.

An explicit action is preferable to overloading `async:false`: callers must be
able to wait for already-running work, including a fleet they did not launch in
the current call, and the existing `action` namespace already owns lifecycle
control.

## 3. Current execution mode and sync/async lifecycle

### Count normalization and unreachable legacy single path

- `src/runs/foreground/executor/budget-resolution.ts:39-55` expands each task's
  `count` into concrete task copies and removes `count`.
- `src/runs/foreground/executor/prepare-execution.ts:65-70` normalizes before
  validation. `prepare-execution.ts:95-102` treats any nonempty task array as
  tasks and validates it; `prepare-execution.ts:154-160` reserves it as
  parallel; `prepare-execution.ts:205` returns literal `hasSingle:false`.
- `src/runs/foreground/executor/types.ts:27-44` represents only the current
  `tasks[]` public execution form. Several executor files nevertheless access
  undeclared legacy top-level fields.
- `src/runs/foreground/executor/create-executor.ts:51-80` takes the async path
  first, otherwise always calls `runParallelPath` for tasks. `runSinglePath`
  requires the never-true `hasSingle` branch.
- `src/runs/foreground/executor/async-path.ts:35-50` defines legacy single as
  no tasks plus `params.agent`; `async-path.ts:79-127` sends every task array to
  `executeAsyncChain` with mode `parallel`. Its `executeAsyncSingle` branch at
  `async-path.ts:130-183` is not reachable from the public schema/validation.
- `src/runs/foreground/executor/mode-helpers.ts:8-12` likewise infers parallel
  from any task array.
- `src/runs/foreground/executor/parallel-path.ts:161-170` records/returns
  `parallel`; `single-path.ts:104` directly awaits `runSync`, which is the old
  in-process synchronous execution path.

There is also a nearby pre-existing defect in
`budget-resolution.ts:58-68`: the invalid-count case loses the concrete error
and returns `{error: undefined, params: undefined}`. It is not required for the
product change, but mode normalization work is likely to touch this function,
so fixing and testing it in the same boundary is low risk.

### Canonical mode rule

Compute invocation count **after** count expansion:

- exactly one concrete invocation => `single`;
- more than one concrete invocation => `parallel`.

Thus one task with omitted `count` or `count:1` is single; one task with
`count:2` is parallel. Use one shared helper for preparation, spawn-limit
accounting, async launch, nested metadata, direct call rendering, result
details, and tracker/widget metadata. Do not independently re-derive mode from
`tasks.length > 0` in each layer.

### Required unified launch lifecycle

`prepare-execution.ts:112` currently computes whether the **caller wants the
result detached** using explicit `async` or `config.asyncByDefault`. Preserve
that public return policy, but decouple it from the execution mechanism:

1. normalize and validate tasks;
2. classify the concrete invocation list as single/parallel;
3. launch through the detached runner for both policies;
4. if effective async is true, return launch details immediately;
5. otherwise, wait specifically for the returned `asyncId` indefinitely and
   return the completed child output/details.

For a single concrete task, adapt the task item into `executeAsyncSingle`
(`agent`, `task`, model/skill/progress/output/context fields as applicable).
For multiple concrete tasks, use `executeAsyncChain` as today. The old direct
`runSync`/foreground-parallel execution path should cease being the normal
public execution route; retain only deliberately needed compatibility helpers
during migration and remove dead top-level `agent` branches.

`asyncByDefault` can remain a caller-return-policy setting: `true` detaches by
default, `false` launches the same runner and performs the integrated wait.

## 4. Async start, tracker, and immediate editor indicator

- `src/runs/background/async-execution/runner-spawn.ts:110-157` writes runner
  config, spawns detached with log/ignored stdio, validates the PID, calls
  `unref`, and returns immediately.
- `src/runs/background/async-execution/single-execution.ts:173-225` emits
  `SUBAGENT_ASYNC_STARTED_EVENT` after a successful spawn and before returning.
  It includes id/PID/session/mode/agent/task/cwd/asyncDir and budget/nested
  metadata.
- `src/runs/background/async-execution/chain-execution.ts:135-164` spawns and
  returns chain launch details. Although the event constant is imported at
  `chain-execution.ts:4`, no async-start event is emitted.
- `src/extension/index.ts:197-221` creates the result watcher and tracker;
  `index.ts:292-294` subscribes tracker start/complete handlers.
- `src/runs/background/async-job-tracker/tracker.ts:183-227` records a queued
  job, starts polling, and immediately rerenders when `lastUiContext` exists.
  `tracker.ts:229-250` updates terminal state/renders and schedules cleanup.
- `src/extension/index.ts:299-307` renders again on the later `tool_result`, but
  that is only a fallback and cannot make a job visible immediately after
  launch if the start event was omitted.
- `src/tui/render/widget-core.ts:46-52` labels parallel mode literally
  `parallel`; a single job with one agent is named after the agent.

Add the single-equivalent start event to `executeAsyncChain` immediately after
successful spawn, including session ID, mode, agent list/chain metadata, cwd,
asyncDir, PID, nested route, and budgets. Once one-task mode uses
`executeAsyncSingle`, the tracker and widget automatically use the agent name
instead of `parallel`.

## 5. Existing wait semantics

### Target selection

- `src/runs/background/wait/wait.ts:26-42` resolves config enablement and the
  default 30-minute timeout.
- `wait.ts:44-65` lists active current-session runs, resolves exact id before a
  prefix, rejects ambiguous prefixes, and makes an id-targeted wait wait-all
  for that one run.
- `wait.ts:67-90` snapshots the IDs active when waiting begins. New concurrent
  launches cannot satisfy the wait.
- With no id, `all:false`/omitted resolves when the first initially active run
  becomes terminal. `all:true` resolves when every initially active run is no
  longer active.
- `src/runs/background/wait/helpers.ts:200-238` scopes async status reads to
  `state.currentSessionId` and merges remembered foreground-detached runs.

Preserve this behavior under `action:"wait"`; it is useful for rolling fleets
and backward semantic compatibility:

- `{action:"wait"}`: snapshot all current-session active runs, return on the
  first snapshot member's terminal/attention outcome;
- `{action:"wait",all:true}`: return only when all snapshot members are
  terminal, unless attention requires caller action;
- `{action:"wait",id}`: exact ID wins, otherwise require a unique prefix and
  wait for that run, regardless of `all`.

No active match returns immediately with “nothing to wait for.”

### Wake and attention predicates

- `src/runs/background/wait/helpers.ts:68-133` subscribes to async completion,
  control event/intercom, result intercom, and intercom detach channels; it
  subscribes before reconciling state and retains a one-second poll fallback.
  This race-avoidance shape should be preserved.
- `wait/helpers.ts:137-142` scopes blocking supervisor requests to the exact
  initial run IDs and excludes `progress_update`.
- `wait/helpers.ts:200-203` treats only
  `activityState === "needs_attention"` as attention. `active_long_running`
  deliberately remains waitable.
- `src/runs/shared/subagent-control.ts:10-20` defaults to needs-attention after
  60 seconds without observed activity, active-long-running after 240 seconds,
  and attention after three consecutive mutating-tool failures.
- Foreground attention is produced by
  `src/runs/foreground/execution/single-attempt-control.ts:20-114`, repeated
  failure tracking in `single-attempt-events.ts:151-179`, and the completion
  guard in `single-attempt-finalize.ts:121-142`.
- Background equivalents live in
  `src/runs/background/runner/ops/runner-ops-activity.ts:49-88,140-191`,
  `runner-ops-step-updates.ts:95-145`, and the parallel/sequential completion
  guards at `runner-step-parallel.ts:209-228` and
  `runner-step-sequential.ts:173-191`.
- `src/intercom/native-supervisor-channel/request-lifecycle.ts:136-192`
  requires the current orchestrator session, a pending/unexpired request, and
  an active run. `need_decision` and `interview_request` expect replies;
  `progress_update` does not.

Integrated wait should resolve on:

- targeted run terminal (`complete`, `failed`, or `paused`);
- targeted run `needs_attention`;
- a pending actionable `need_decision` or `interview_request` for a targeted
  run.

It should **not** resolve for `active_long_running` or `progress_update`.

### Indefinite means no orchestration timeout

- `wait.ts:91-119` currently returns an error on AbortSignal or elapsed wait
  timeout; in both cases runs remain detached.
- Internal runner timeout infrastructure is distinct. For example,
  `single-execution.ts:95` converts internal `params.timeoutMs` to a runner
  deadline, and `runner-finalize.ts:103-163` emits a failed terminal result for
  a timed-out run.
- The current public subagent schema does not expose execution timeout.

Remove the elapsed/deadline/`timeoutMs` branches from orchestration wait. Keep
AbortSignal cancellation: it represents cancellation of the current tool
call/turn, not a time budget, and must leave the detached run alive. Internal
runner deadline plumbing may remain; if a runner times out, its failed terminal
result resolves integrated wait normally.

Also remove `src/runs/background/wait/config.ts`,
`PI_SUBAGENT_WAIT_TOOL_ENABLED`, `ExtensionConfig.waitTool`
(`src/shared/types/options-types.ts:117-123`), and `WaitToolConfig`
(`src/shared/types/control-types.ts:52-56`). Required synchronous semantics
cannot be conditionally disabled.

## 6. Completion transport needed by synchronous calls

### The current deletion race

- `src/runs/background/runner/runner-finalize.ts:103-163` atomically writes a
  rich result JSON: run identity/mode/state/summary, full child outputs and
  errors, sessions/models/artifacts/structured output, workflow graph,
  exit/duration/token/cost data, cwd/asyncDir/session ownership, and timeout or
  budget status.
- `src/runs/background/result-watcher/helpers.ts:20-48` types only a subset of
  that payload but retains the fields needed to identify and normalize it.
- `src/runs/background/result-watcher/watcher.ts:46-110` reads only the owning
  session's file, deduplicates, normalizes child/nested results, and performs
  result-intercom delivery.
- `result-watcher/watcher.ts:112-133` emits the normalized
  `SUBAGENT_ASYNC_COMPLETE_EVENT` and immediately unlinks the result file.
- `src/shared/types/result-types.ts:104-229` shows that normal foreground tool
  results need `Details` plus `SingleResult[]`, including output/usage/session/
  artifact information. Today's management wait summary is insufficient.

A sync waiter that subscribes only after launch can miss a very fast
completion event; one that reads `results/*.json` directly races the existing
watcher's unlink. Do not add a second file watcher or return the short wait
summary as the synchronous execution result.

### Recommended completion broker

Add a central parent-session completion broker owned by `SubagentState` (or a
separate runtime object referenced from it):

- `completed: Map<runId, NormalizedAsyncCompletion>` with bounded/TTL cleanup;
- `awaited: Set<runId>` or an ownership record distinguishing a synchronous
  execution waiter from general `action:"wait"` observers;
- result watcher stores the normalized full completion **before** emitting the
  event and before deleting the file;
- waiter first checks the cache/persistent terminal status, then subscribes,
  then reconciles again (subscribe-before-check race protection), retaining
  the existing poll fallback;
- session reset/dispose prunes unrelated entries; TTL can align with the
  existing ten-minute completion dedupe horizon, with a size cap as defense.

For sync execution:

1. mark/subscribe for the generated run ID before or atomically with launch;
2. launch;
3. on launch error, unmark and return the launch error immediately;
4. wait specifically for that ID;
5. if complete/failed/paused, convert the cached completion into the standard
   `AgentToolResult<Details>` with canonical mode, child results, content,
   workflow/output/cost metadata, and `isError` where appropriate;
6. if attention/supervisor request occurs while the runner remains active,
   return an actionable nonterminal result containing `runId`/`asyncId` and
   status/reply instructions; the detached run continues;
7. on AbortSignal, return an aborted tool result while the run continues.

The runner's `StepResult` (`src/runs/background/runner/types.ts:61-90`) does not
carry foreground `Usage`; its result file carries aggregate token/cost data.
The converter should map all available data faithfully and use explicit
zero/default usage only where the legacy `SingleResult` type requires it,
rather than inventing per-child usage.

### Completion notification ownership

`src/runs/background/notify.ts:99-115` always sends background completion with
`triggerTurn:true`, and `notify.ts:159-221` listens to the same completion
event. Without coordination, a synchronous call will both return the output
and inject a second parent turn for that output.

Use the broker's awaited ownership to suppress the automatic completion
notification for runs actively owned by a synchronous execution wait. General
`action:"wait"` should remain an observer and should not consume notifications
for independently launched async work. Ordering must be explicit: mark awaited
before launch; result watcher caches; notifier checks ownership; waiter consumes
and clears ownership/cache at completion (with finally/TTL cleanup on abort or
attention).

## 7. Single versus parallel presentation

- Direct call presentation is wrong at
  `src/extension/registration/tools.ts:82-89`; use expanded invocation count.
  Suggested labels: one invocation `subagent <agent>`; more than one
  `subagent parallel (N)`. Preserve `[async]` only when the caller's return
  policy is detached.
- `src/tui/render/result-render.ts:160-180` handles launch/management results
  with no children. `result-render.ts:180-275` uses the single-special UI only
  for `details.mode === "single" && results.length === 1`; otherwise it uses the
  multi renderer. Correct canonical completion details therefore fix result
  display without another heuristic.
- `src/tui/render/widget-core.ts:46-52` similarly displays the sole agent for a
  single job and literal `parallel` for parallel mode.

Normalize mode once and propagate it. One task with `count:1` must never carry
parallel mode in launch events, status, result details, nested events, widget,
or call text; `count>1` and multiple tasks remain parallel.

## 8. Related slash/view evidence

Although the assigned topic is tool/wait/builtins/rendering, two nearby facts
matter to integration planning:

- `src/slash/commands/registration.ts:12-65` currently registers `/run`,
  `/parallel`, `/subagent-cost`, `/subagents-doctor`, `/subagents-fleet`,
  `/subagents`, prompt workflow commands, and profile commands. Satisfying “only
  `/subagents`” requires registering only the `/subagents` handler and removing
  documentation for the rest; it is independent of the tool schema.
- Full-height/history parity is already substantially implemented:
  `src/tui/child-conversation/render.ts:3-32` renders exactly terminal rows minus
  11 chrome lines, blank-pads short content, and relies on terminal scrollback;
  `src/tui/steer-view/host-editor-mode.ts:220-350` retains the real host editor,
  routes child prompts, mounts/removes the widget, and restores the parent view.
  The reviewed earlier design is recorded at
  `.trellis/tasks/archive/2026-08/08-01-subagents-native-view-parity/design.md:53-72`.
  This area should be regression-tested rather than redesigned solely as part
  of the wait/tool change.

## 9. Concrete test plan

### Schema and registration

- `test/unit/schemas.test.ts:143-176`: assert integrated `all`, wait-oriented
  `id` description/action, no public wait schema export, and no timeout field.
- `test/unit/schemas-validation.test.ts:260+`: accept
  `{action:"wait"}`, `{action:"wait",id:"..."}`, and
  `{action:"wait",all:true}`; reject any obsolete timeout input if additional
  properties are made strict.
- `test/unit/index-child-registration.test.ts:74-111`: add one task and
  `count:1` call-render tests with no `parallel`; retain current multi/count>1
  assertion. Replace `index-child-registration.test.ts:114-158` wait-config
  coverage with an assertion that only `subagent` is registered and no `wait`
  tool exists.

### Integrated wait

Refactor `test/unit/wait.test.ts:65-490` around the internal primitive and
`action:"wait"` dispatch:

- keep empty, all, first-completion, current-session scoping, initial-ID
  snapshot, exact/prefix/ambiguity, initial/later needs-attention, event wake,
  poll fallback, AbortSignal, and foreground-detached cases;
- delete disabled-config tests;
- replace `wait.test.ts:311-333` timeout expectation with a test that advancing
  a virtual clock arbitrarily never resolves the wait, then terminalize or
  signal attention to finish the test;
- retain `test/unit/wait-supervisor-request.test.ts:78+` and
  `wait-supervisor-cross-protocol.test.ts:50+` semantics for pre-existing and
  event-boundary blocking requests, exact snapshot IDs, and later launches;
- explicitly assert `active_long_running` and `progress_update` do not resolve.

### Launch and completion lifecycle

- Add an `executeAsyncChain` regression asserting exactly one
  `SUBAGENT_ASYNC_STARTED_EVENT` after successful PID and no event on spawn
  failure; validate session/mode/agents/asyncDir metadata.
- `test/integration/async-job-tracker-lifecycle.test.ts:110-198`: with a main UI
  context present, assert the chain start event makes the editor-top widget
  visible before `tool_result`; then assert attention/complete transitions and
  cleanup.
- Extend `test/integration/result-watcher-delivery.test.ts:32-158` to assert the
  normalized full payload is cached before event delivery/unlink and is
  retrievable by a waiter after a fast completion.
- Add executor integration cases for:
  - default/`async:false` single task => detached single launch, specific wait,
    full normal output;
  - default/`async:false` parallel => same launch/wait path and multi result;
  - `async:true` => immediate launch return only;
  - completion occurring before the wait subscription (cache race);
  - failure, paused/interrupt, and internal runner timeout terminal results;
  - needs-attention and blocking supervisor request returning actionably while
    the run remains alive;
  - AbortSignal ending the tool call but not the runner;
  - sync-owned completion does not trigger a duplicate parent turn, while a
    normal async completion still does.

### Builtins and presentation

- Add the clean-install builtin-only-`delegate` discovery assertion described
  in section 1 and update `agent-disabled.test.ts` builtin cases.
- `test/integration/render-widget-layout.test.ts:87+` and
  `render-widget-detail.test.ts:87+`: assert one-task start metadata produces
  the delegate/agent name, while expanded count/multi produces `parallel`.
- Existing `render-fork-badge-single.test.ts` and result-render tests should
  continue exercising `mode:"single"` plus one child.

## 10. Documentation and cleanup inventory

- `README.md:101-120` lists all eight builtins; reduce to `delegate` and explain
  user/project/package definitions.
- `README.md:599-601` documents standalone wait; replace with
  `subagent({action:"wait",...})` and indefinite behavior.
- `README.md:1212+` documents orchestration configuration, including
  `asyncByDefault`; remove the `waitTool` option while explaining that
  synchronous calls use launch-plus-wait.
- `skills/pi-subagents/SKILL.md:724,741-743` refers to standalone `wait`,
  `config.waitTool`, and `PI_SUBAGENT_WAIT_TOOL_ENABLED`; migrate all examples
  and remove disable fallback guidance.
- `src/runs/background/async-execution/start-helpers.ts:10-17` tells callers to
  call `wait()` three times; replace with the integrated action contract.
- Update the tool descriptions' removed builtin examples (`reviewer`, etc.),
  async guidance, and the action list.
- Remove stale standalone wait schema/config/barrel exports and update the
  changelog with the breaking tool/config migration. Historical archived task
  artifacts do not need rewriting.

## Recommended design decision summary

Adopt `subagent({action:"wait", id?, all?})`, preserving the current targeting
and attention semantics but with no orchestration timeout. Make every execution
use the detached async runner; `async:true` returns launch details, while the
default synchronous policy waits for its exact run ID and reconstructs the
normal output through a race-safe, session-scoped completion broker. Canonical
mode is based on count-expanded invocation cardinality. The broker must also
own sync-awaited notification suppression. Finally, emit chain start events at
spawn time so the main editor indicator is immediate.

This is the smallest design that satisfies all relevant PRD constraints while
preserving rolling-fleet waits, current attention behavior, full synchronous
results, and async notifications without duplicate turns.
