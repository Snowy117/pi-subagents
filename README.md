<p>
  <img src="https://raw.githubusercontent.com/Snowy117/pi-subagents/main/banner.png" alt="pi-subagents" width="1100">
</p>

# pi-subagents

`pi-subagents` is a [Pi](https://github.com/earendil-works/pi) extension that gives your coding agent one delegation tool, a native child-conversation view, and a detached runner for single or parallel subagent work.

The public surface is deliberately small:

- **one tool** — `subagent`;
- **one slash command** — `/subagents`;
- **one bundled agent** — the neutral `delegate` fallback;
- **no packaged prompt templates**.

Everything else — specialized agents, extra commands, prompts — comes from your user config, your project, or other packages.

## Install

```bash
pi install npm:@snowy117/pi-subagents
```

Pi 0.83.0 or newer is recommended for the keybinding and host-editor behavior described below.

Alternatively, the package ships a small installer that clones the repository into Pi's extension directory:

```bash
npx @snowy117/pi-subagents            # install (or `git pull` an existing install)
npx @snowy117/pi-subagents --remove   # remove
```

## Start here

The package includes one neutral fallback agent named `delegate`. Ask naturally:

```text
Use a delegate subagent to inspect this change and report concrete risks.
```

```text
Run two delegates in parallel: one for correctness and one for missing tests.
```

```text
Run a delegate in the background while I continue working.
```

The extension does not install opinionated reviewer, planner, researcher, or implementation roles. Add your own user, project, or package agents when you want specialized behavior — see [Add custom agents](#add-custom-agents).

## Execute work

Execution uses `tasks` for both single and parallel calls.

### Single

Exactly one concrete invocation is `single`:

```js
subagent({
  tasks: [{ agent: "delegate", task: "Inspect the current diff for regressions." }]
})
```

`count: 1` is also single. It is never labeled or rendered as parallel.

### Parallel

More than one concrete invocation is `parallel`:

```js
subagent({
  tasks: [
    { agent: "delegate", task: "Review correctness." },
    { agent: "delegate", task: "Review tests and validation." }
  ],
  concurrency: 2,
  context: "fresh"
})
```

A repeated task expands before mode selection, so `count: 2` is parallel:

```js
subagent({
  tasks: [{ agent: "delegate", task: "Find one concrete issue.", count: 2 }]
})
```

Useful execution fields:

| Field | Meaning |
| --- | --- |
| `tasks` | `{ agent, task, count?, progress?, model?, skill? }[]` |
| `concurrency` | Maximum concurrent children for a parallel call |
| `worktree` | Isolate parallel tasks in git worktrees |
| `context` | `"fresh"` or `"fork"`; an explicit value overrides agent defaults |
| `async` | `true` returns the detached launch receipt; `false`/default waits for the same detached run |
| `artifacts` | Enable or disable run artifacts |
| `includeProgress` | Include full progress in the returned result |

Every public execution uses the same detached runner. There is no separate foreground execution mechanism behind a default synchronous call — a default call launches the detached runner, waits for that exact run, and returns the full result.

## Wait without polling

Waiting is part of the `subagent` tool — there is no standalone `wait` tool:

```js
subagent({ action: "wait" })
subagent({ action: "wait", all: true })
subagent({ action: "wait", id: "run-id-or-unique-prefix" })
```

Semantics:

- no `id`: snapshot active runs owned by the current Pi session;
- default: return on the first snapshotted completion or actionable attention event;
- `all: true`: wait for every snapshotted run unless one needs actionable attention;
- `id`: exact match wins, otherwise one unique prefix is required;
- no active match: return immediately;
- no elapsed orchestration timeout;
- cancelling the parent turn stops only the wait, not the detached runner.

`needs_attention` and pending supervisor `need_decision` or `interview_request` requests wake the wait. Ordinary progress and `active_long_running` do not.

Do not run sleep loops or repeatedly poll status just to wait. Use the integrated wait when the current turn must block; otherwise continue useful work and let the normal completion notification arrive.

## Inspect and control runs

```js
subagent({ action: "list" })
subagent({ action: "status", id: "..." })
subagent({ action: "status", view: "fleet" })
subagent({ action: "status", id: "...", view: "transcript", index: 0, lines: 120 })
subagent({ action: "interrupt", id: "..." })
subagent({ action: "resume", id: "...", index: 0, message: "Continue with this clarification." })
subagent({ action: "steer", id: "...", index: 0, message: "Check the migration path too." })
```

Run IDs accept exact values or unique prefixes. Exact values always win over prefixes.

Opt-in scheduled runs retain their existing actions — `schedule`, `schedule-list`, `schedule-status`, and `schedule-cancel` — and only honor an explicit user request to delay a launch.

## `/subagents`: native child conversation

Run `/subagents` to choose an available child. The child view keeps Pi's real editor mounted and focused, so autocomplete, multiline input, paste, images, slash routing, custom editor wrappers, and user keybindings continue to work.

The selected child's messages and tools use Pi's native message components. The widget contributes the complete rendered child transcript to the TUI root instead of slicing it to a moving viewport tail. Short histories are padded to fill the available chat area; long histories remain available through terminal scrollback.

Foreground-resident, running detached, and reopenable finished children resolve through the same conversation-channel abstraction. The parent never writes a child session file and never opens a second writer for the same session.

### Leave child mode

All normal child-view exits share the same teardown:

- `/subagents exit` or `/subagents close`;
- Pi's canonical `app.exit` binding when the editor is empty;
- submitting `/quit`;
- submitting the legacy `/exit` spelling.

The `app.exit` route uses Pi's live keybinding manager. The default is Ctrl+D, but remaps, multiple bindings, legacy migration, and `[]` removal in `keybindings.json` are honored. With non-empty editor text, the key passes through to the real editor, matching Pi's normal empty-input exit behavior.

Pi's double-Ctrl+C emergency process exit remains host-owned and is not intercepted.

### Child-mode key routing

While child mode is active, app-level keys route to the child (default on, `subagents.childKeyRoute`):

- `Esc` aborts the child stream (streaming only);
- `Shift+Tab` cycles the child's thinking level;
- `Ctrl+P` / `Shift+Ctrl+P` cycle the child's model;
- `Ctrl+L` opens the model picker;
- `Ctrl+O` toggles tool output expansion;
- `Ctrl+T` toggles hidden thinking.

Bindings resolve from defaults merged with your `keybindings.json` remaps. Editor-level keys are never intercepted; main-agent app keys are unavailable while child mode is active.

## Optional picker keybinding

There is no default picker shortcut. Down arrow and every other key pass through unless you configure the extension-owned action in `~/.pi/agent/keybindings.json`:

```json
{
  "subagents.openPicker": "ctrl+down"
}
```

Multiple keys are supported:

```json
{
  "subagents.openPicker": ["ctrl+down", "alt+s"]
}
```

Disable it explicitly with an empty array:

```json
{
  "subagents.openPicker": []
}
```

The value must be one valid Pi key string, an array containing only valid key strings, or `[]`. Invalid values produce no binding. The picker opens only when the editor is empty, a selectable child exists, and this package has no modal open.

Pi ignores unknown extension action IDs, so this adapter reads and matches the namespaced entry itself. It intentionally does not appear in `/hotkeys`, participate in host conflict reporting, or support leader-key prototype patches. Pi `/reload` reconstructs the extension runtime and rereads the file.

## Default `delegate`

The bundled definition contains only neutral identity metadata:

```yaml
---
name: delegate
description: Neutral fallback subagent for delegated work
---
```

It has no bundled body/system prompt, explicit tool restriction, skills, workflow, or default reads. Omitted fields use the loader's neutral delegate defaults: normal available tools, an empty appended prompt, inherited project context, and no inherited skills.

## Add custom agents

Agent discovery still supports user, project, and package definitions. Common locations are:

- `~/.pi/agent/agents/*.md`;
- `~/.agents/*.md`;
- `<project>/.pi/agents/*.md`;
- legacy `<project>/.agents/*.md`;
- installed packages that declare `pi.subagents.agents` or `pi-subagents.agents`.

Example project agent:

```markdown
---
name: code-review
description: Reviews a change for correctness and missing tests
tools: read, grep, find
defaultContext: fresh
---

Inspect the requested change. Report evidence-backed findings with file and line references. Do not edit files.
```

Only `name` and `description` are required. Agent frontmatter can also choose model/thinking, tools, skills, context inheritance, fallback models, budgets, output behavior, and extensions.

Use `subagent({ action: "list" })` to inspect the effective, executable definitions after builtin/package/user/project precedence and disabled overrides are applied.

## Detached lifecycle and results

Every successful launch emits a start event immediately. The status bar shows the number of currently active background subagents. Synchronous launch-plus-wait calls are excluded while the caller still owns the wait; if waiting returns early for attention or parent-turn cancellation and the child keeps running, it is then counted as background work.

The tracker owns queued/running/attention/completion state and polls persisted status. Detailed lifecycle and transcript information remains available through `subagent({ action: "status", ... })`.

Detached run artifacts include the run directory, `status.json`, `events.jsonl`, output logs, session paths when enabled, workflow/output metadata, and final result JSON. Runner-level deadlines and budgets remain valid terminal failures; only the orchestration wait is indefinite.

Fast completion is race-safe. The result watcher caches the normalized full completion before intercom delivery, completion event emission, and result-file unlink. Synchronous ownership suppresses only that run's automatic completion turn; ordinary detached work keeps normal notifications.

Final synchronous results retain available per-child task, output, error, exit code, usage, session, model attempts, artifacts, transcript/truncation data, structured output, workflow/output maps, and aggregate token/cost data. Legacy files without per-child usage use explicit zeros rather than invented allocation.

## Child-safe fanout

Ordinary child sessions do not receive the parent orchestration surface. A child explicitly configured for fanout may receive the child-safe `subagent` tool, still bounded by nesting and spawn limits.

Its wait/status visibility is restricted to the authorized nested run and result roots for its inherited root run. It cannot observe unrelated parent or sibling lifecycle directories. Agent-definition mutation actions remain blocked in child-safe fanout mode.

## Configuration

Extension runtime config lives at:

```text
~/.pi/agent/extensions/subagent/config.json
```

Representative settings:

```json
{
  "asyncByDefault": false,
  "toolDescriptionMode": "full",
  "maxSubagentDepth": 2,
  "maxSubagentSpawnsPerSession": 40,
  "globalConcurrencyLimit": 20,
  "parallel": {
    "concurrency": 4,
    "maxTasks": 16
  },
  "childKeyRoute": true,
  "scheduledRuns": {
    "enabled": false
  }
}
```

`persistentChildren` is a deprecated no-op retained only so older configuration files continue to load. All execution children use persistent Pi RPC transport unconditionally.

The removed standalone wait configuration and environment switch are not supported. Waiting is always available through `subagent({ action: "wait", ... })` wherever an authorized lifecycle root exists.

## Package resources

The published package includes source, the neutral `agents/delegate.md`, skills, README, and changelog. It intentionally sets `pi.prompts` to `[]` and does not publish a `prompts/` resource, preventing Pi's package-directory convention fallback from loading old bundled templates.

## Development

```bash
npm test                # unit tests (Node test runner, native TS stripping)
npm run test:integration
npm run test:e2e
npm run test:all        # unit + integration + e2e
```

Unit tests use Node's test runner with native TypeScript stripping. Integration and E2E use the repository loader and faux/mock Pi providers; no real API key is required for the supported E2E lane.

## License

MIT
