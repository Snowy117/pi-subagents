---
name: pi-subagents
description: |
  Delegate bounded work to configured subagents with single or parallel
  detached execution, integrated waiting, status/control, and native child
  conversation. Use when independent context, review, research, or execution
  can help while one parent session remains responsible for synthesis.
---

# Pi Subagents

This skill is for the parent orchestrator. Do not inject it into ordinary child sessions. The parent owns delegation, sequencing, synthesis, user decisions, and final reporting.

An explicitly configured fanout child may receive the child-safe `subagent` tool for its assigned fanout only. Its lifecycle visibility is restricted to the authorized nested root, and agent-definition mutation stays blocked.

## Core rules

1. Call `subagent({ action: "list" })` before execution. Use only executable, non-disabled agents returned by discovery.
2. Do not assume specialized bundled roles exist. A default installation contains only the neutral `delegate` fallback; users and projects may define any other roles.
3. Keep one writer for a shared cwd/worktree. Parallelize read-only investigation or use intentionally isolated worktrees.
4. Give each child a concrete task, evidence requirements, stop rules, and requested validation.
5. Keep synthesis in the parent. Children contribute bounded results; they do not silently redefine scope or product decisions.
6. Do not sleep or poll in a loop to wait. Use integrated `action: "wait"` only when the current turn must block.
7. Cancellation of a parent wait does not cancel the detached child. Inspect or interrupt the run explicitly if desired.

## Public surface

- Tool: `subagent`
- Built-in slash command: `/subagents`
- Bundled agent: `delegate`
- Packaged prompt templates: none
- Default picker shortcut: none

Use the tool for programmatic orchestration. `/subagents` opens the interactive child picker and conversation view.

## Discover first

```js
subagent({ action: "list" })
```

Discovery merges builtin, package, user, and project definitions. Later scopes can shadow earlier definitions. Read the returned descriptions and defaults instead of guessing a role name.

If only `delegate` is available, make the task itself role-specific:

```js
subagent({
  tasks: [{
    agent: "delegate",
    task: "Act as a read-only correctness reviewer. Inspect the current diff, report only concrete regressions with file/line evidence, and do not edit files."
  }],
  context: "fresh"
})
```

## Execution contract

Execution omits `action` and uses `tasks`.

### Single

Exactly one count-expanded invocation is `single`:

```js
subagent({
  tasks: [{ agent: "delegate", task: "Trace the request path and identify the smallest safe fix." }]
})
```

One task with omitted `count` or `count: 1` must never be described as parallel.

### Parallel

More than one concrete invocation is `parallel`:

```js
subagent({
  tasks: [
    { agent: "delegate", task: "Review correctness. Do not edit." },
    { agent: "delegate", task: "Review tests and missing validation. Do not edit." },
    { agent: "delegate", task: "Review unnecessary complexity. Do not edit." }
  ],
  concurrency: 3,
  context: "fresh"
})
```

One task with `count: 2` is also parallel because count expansion creates two concrete invocations.

### Useful fields

```text
tasks[].agent       required discovered agent name
tasks[].task        required concrete assignment
tasks[].count       repeat this task; mode is computed after expansion
tasks[].progress    request detailed progress when useful
tasks[].model       per-task model override
tasks[].skill       skill override when available
concurrency         parallel concurrency cap
worktree            isolate parallel writers in git worktrees
context             fresh or fork
async               true returns immediately; false/default waits
artifacts           enable/disable debug artifacts
includeProgress     include full progress in final details
```

Every execution launches through the detached runner. `async` controls return policy, not runner mechanism:

- `async: true`: return the launch receipt immediately;
- false/default: claim synchronous ownership, launch the same detached runner, wait for the exact generated run ID, and return the full normal result.

## Choosing context

- `fresh`: independent reading, adversarial review, alternate approaches, external research, and reduced inherited bias.
- `fork`: the child needs the parent's conversation decisions or unresolved reasoning.
- omitted: use the selected agent's configured default, otherwise fresh.

Prefer fresh context for independent validation. Prefer fork only when inherited conversation state is genuinely necessary.

## Safe parallel patterns

### Read-only review fanout

Give distinct angles. Do not ask every child for the same generic review.

```js
subagent({
  tasks: [
    { agent: "delegate", task: "Read-only regression review of the current diff. Return severity, evidence, and smallest fix." },
    { agent: "delegate", task: "Read-only validation review. Identify missing tests and commands needed for confidence." }
  ],
  context: "fresh",
  async: true
})
```

The parent deduplicates findings, decides which are valid, and applies or delegates one coherent fix set.

### Multiple writers

Do not launch several writers into the same dirty worktree. Either:

- keep one writer and parallelize read-only analysis;
- use `worktree: true` for genuinely separable tasks;
- sequence dependent work in the parent.

Always report the worktree/cwd used, files changed, validation run, failures, and residual risks.

## Async and integrated wait

Launch detached work when the parent can continue independently:

```js
subagent({
  tasks: [{ agent: "delegate", task: "Investigate the flaky integration test and report the root cause. Do not edit." }],
  async: true,
  context: "fresh"
})
```

When the current turn has no useful work left and must block:

```js
subagent({ action: "wait", id: "run-id-or-unique-prefix" })
```

Other forms:

```js
subagent({ action: "wait" })
subagent({ action: "wait", all: true })
```

Wait behavior:

- snapshots only current-session active runs at call start;
- exact ID wins over a unique prefix;
- default returns on the first snapshotted terminal result or actionable attention;
- `all: true` waits for all snapshot members unless attention intervenes;
- no active match returns immediately;
- no orchestration timeout;
- abort ends only the wait, never the runner;
- `needs_attention`, `need_decision`, and `interview_request` wake;
- `active_long_running` and `progress_update` do not wake.

An observer wait does not consume ordinary completion notifications. Only the synchronous owner created by a default execution call suppresses that run's duplicate completion turn.

## Status and control

```js
subagent({ action: "status", id: "..." })
subagent({ action: "status", view: "fleet" })
subagent({ action: "status", id: "...", view: "transcript", index: 0, lines: 120 })
subagent({ action: "interrupt", id: "..." })
subagent({ action: "resume", id: "...", index: 0, message: "Continue after this clarification." })
subagent({ action: "steer", id: "...", index: 0, message: "Also inspect the rollback path." })
```

Use status for one-shot inspection, not polling. Interrupt is an explicit control decision. Resume supplies a follow-up to a live or reopenable child. Steer queues non-terminal guidance when the target supports it.

If a child requests a supervisor decision or interview, surface that request to the user rather than guessing. Ordinary progress updates are informational and should not stop orchestration.

## Interactive child conversation

`/subagents` is the only package-provided slash command. It opens a picker for available children.

The child view keeps Pi's real host editor, native input behavior, autocomplete, images, slash routing, and custom keybindings. The complete rendered child transcript participates in terminal scrollback; it is not sliced to a moving tail.

Leave child mode through the shared teardown:

- `/subagents exit` or `/subagents close`;
- the live canonical `app.exit` binding with an empty editor;
- submitted `/quit`;
- submitted legacy `/exit`.

Non-empty editor behavior remains host-owned. Double-Ctrl+C emergency exit remains host-owned.

There is no default Down-arrow picker binding. Users may configure `subagents.openPicker` in `~/.pi/agent/keybindings.json` as one key, a key array, or `[]`. The package matches this namespaced entry itself; it is intentionally absent from `/hotkeys` and host conflict reporting.

## Result contract

Synchronous launch-plus-wait returns the full normalized result, not a short receipt. Preserve and report available:

- task, output, error, status, and exit code;
- per-child usage and session path;
- model and model-attempt history;
- artifact and transcript/truncation metadata;
- structured output;
- output maps and workflow graph;
- aggregate tokens and cost.

Legacy completion files without per-child usage use explicit zeros. Never invent a per-child allocation from aggregate totals.

Fast completion is handled by a session-scoped completion broker. The result watcher caches before intercom delivery, completion event emission, and file unlink, so a waiter cannot lose a result that finishes before subscription.

## Definition guidance

The bundled `delegate` is intentionally blank beyond required identity metadata. Specialized behavior belongs in user, project, or package definitions.

Typical project definition:

```markdown
---
name: security-review
description: Read-only security review with concrete evidence
tools: read, grep, find
defaultContext: fresh
---

Inspect the requested surface for exploitable behavior. Return severity, evidence, and the smallest safe mitigation. Do not edit files.
```

Do not assume names from older package releases still exist. Always discover first.

## Completion checklist

Before reporting parent-level completion:

- [ ] Every executed agent came from current discovery.
- [ ] One-task/count:1 runs were treated as single.
- [ ] Parallel children had non-overlapping tasks or isolated worktrees.
- [ ] No sleep/status polling loop was used for waiting.
- [ ] Attention and supervisor requests were handled explicitly.
- [ ] Child results were synthesized rather than copied blindly.
- [ ] Changed files, verification commands, failures, and residual risks are reported.
- [ ] Detached runs still alive after an aborted/attention-returned wait are called out.
