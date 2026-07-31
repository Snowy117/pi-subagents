# Pi RPC Child Command Transport Feasibility

## Question

Can pi-subagents use Pi 0.82.1 RPC mode as a generic transport for direct
multi-turn child conversation and child-owned slash commands, including an
unmodified `../pi-dcp-migrate` `/dcp` command?

## Conclusion

Yes, for commands that exist in the selected child's headless Pi runtime:

- extension commands registered through `pi.registerCommand()`;
- prompt templates; and
- skills.

The parent can send RPC `prompt` with `/name args`; Pi performs command
dispatch before normal prompting. Pi also exposes `get_commands` for those
three command categories. Built-in interactive-only commands such as
`/settings` and `/hotkeys` are not part of RPC and remain parent-TUI commands.

This changes the earlier conclusion in `child-extension-command-routing.md`.
That note is correct for the current `json -p` plus steer transport, but Pi's
built-in RPC mode supplies the generic command dispatcher and serializable UI
bridge that the current transport lacks. No plugin-specific remote-action API
is required for commands whose UI fits the RPC extension-UI protocol.

Generic `//dcp` therefore works without changing `../pi-dcp-migrate`, provided
DCP is loaded in the resumed child runtime. The child executes its own DCP
handler and the parent renders the resulting `ui.notify()` request. DCP does
not currently open a custom component; its command output is notification text
(`../pi-dcp-migrate/commands.ts:20-103`).

## Pi RPC Contract

Pi RPC is bidirectional JSONL over child stdin/stdout. The client must split on
LF only; Node `readline` is explicitly non-compliant because it also treats
Unicode separators as record boundaries
(`node_modules/@earendil-works/pi-coding-agent/docs/rpc.md:20-37`).

### Commands and completion

- `prompt` accepts ordinary text and slash commands. Extension commands execute
  immediately, including while the child is streaming; skills and prompt
  templates expand before enqueue or model submission (`rpc.md:43-76`).
- `steer` and `follow_up` support mid-run queue semantics but deliberately do
  not execute extension commands; remote slash execution must use `prompt`
  (`rpc.md:80-104`).
- `get_commands` returns extension, prompt-template, and skill entries with
  descriptions and source metadata (`rpc.md:793-830`). It excludes built-in
  TUI commands.
- Unknown slash text is not guaranteed to be an error: if it is not a known
  extension/template/skill command, normal prompt processing may send it to the
  child model. The parent must validate `//name` against a fresh or cached
  `get_commands` result and reject unknown commands before sending `prompt`.

### Extension UI proxy

RPC translates supported `ExtensionUIContext` calls into structured events:

- dialogs: `select`, `confirm`, `input`, `editor` require a correlated
  `extension_ui_response`;
- fire-and-forget: `notify`, `setStatus`, string-array `setWidget`, `setTitle`,
  and `set_editor_text` emit requests for the parent to render or apply.

The documented contract is at `rpc.md:1143-1333`; the implementation is in
`dist/modes/rpc/rpc-mode.js:60-190`.

Direct-TUI features degrade rather than cross the process boundary:

- `custom()` returns `undefined`;
- component widgets, custom editor components, header/footer factories,
  autocomplete providers, raw terminal input, working-indicator customization,
  and theme switching are unavailable or no-op;
- `getEditorText()` returns an empty string;
- `pasteToEditor()` degrades to `setEditorText()`.

The viewer must state this boundary truthfully. A command that depends on
`custom()` cannot display its child component in the parent; it may still
complete with an explicit unsupported-UI notice. Arbitrary component instances
must never be transported or evaluated in the parent process.

### DCP case study

DCP registers `dcp` and `dcp-compress` through `pi.registerCommand()` and uses
`execCtx.ui.notify()` for help, stats, context, state changes, and errors
(`../pi-dcp-migrate/commands.ts:17-103`). In RPC mode:

1. the parent validates that `get_commands` contains `dcp`;
2. `//dcp stats` maps to RPC `prompt: "/dcp stats"`;
3. the child invokes DCP against that child session's DCP state;
4. DCP emits `extension_ui_request { method: "notify", ... }`;
5. the parent viewer renders the notification as a child-command result.

No DCP code change is required. If the selected agent uses `extensions: []` or
otherwise does not load DCP, `get_commands` omits `dcp` and the viewer reports
that the command is unavailable. The parent `/dcp` remains unchanged.

## Current Transport Gap

Both foreground and async child execution currently build
`["--mode", "json", "-p"]` arguments
(`src/runs/foreground/execution/run-single-attempt.ts:92` and
`src/runs/background/runner/run-single-step-helpers.ts:83-90`). Both spawn with
stdin ignored (`run-single-attempt.ts:219-226` and
`src/runs/background/runner/run-pi-streaming.ts:37-42`). Foreground state even
types stdin as `null`
(`src/runs/foreground/execution/single-attempt-state.ts:91-95`).

The existing file steer inbox calls `sendUserMessage(..., { deliverAs:
"steer" })` (`src/runs/shared/subagent-prompt-runtime/runtime-registration.ts:57-80`).
That route remains useful for compatibility with one-shot children, but it
cannot execute extension commands because it bypasses command expansion.

The stdout event parser and child transcript writer already understand Pi
agent events. RPC adds response records, queue/state events, `agent_settled`,
and `extension_ui_request`; parsers must discriminate those records rather than
treating every JSON object as an agent event. The structured transcript can
continue recording full finalized messages and tool identities
(`src/shared/child-transcript.ts:150-197`).

## Lifecycle Options

### Option A: on-demand RPC session bridge (recommended)

Keep current foreground/async execution unchanged. A normal child finishes,
persists its session, and exits exactly as today. When the user selects a child
for continued conversation, start one RPC process with the same child launch
configuration plus `--session <absolute-session-file>`. Pi supports opening a
specific session path (`dist/main.js:154-187`; `docs/quickstart.md:140`).

The bridge owns that session file exclusively while open. It remains alive
across RPC `agent_settled` events, accepts more prompts and child commands, and
exits when the user closes child-conversation mode, switches target, the parent
session shuts down, or an idle timeout expires. Before exit it must resolve or
cancel pending extension dialogs and wait for stdout backpressure/flush.

Benefits:

- preserves current run completion, notifications, async artifacts, and
  process-exit semantics;
- no permanent process per completed subagent;
- no concurrent writer because the original child has already exited;
- rollback is isolated to the interactive bridge and viewer.

Trade-off: a child that is still actively running cannot be reopened on its
session file safely. During that interval ordinary messages continue through
the existing steer path; child slash commands become available after the run
settles, or require Option B.

### Option B: make every execution child a persistent RPC process

Replace the current one-shot process with RPC from launch. Treat
`agent_settled` as logical task completion while retaining the process for
future viewer prompts.

Benefits:

- direct conversation and child slash commands are available immediately,
  including while the initial task is streaming;
- one process owns the session from start to finish.

Costs and risks:

- current foreground and async runners resolve on process close and force
  termination shortly after a terminal assistant message
  (`src/runs/background/runner/run-pi-streaming.ts:235-284` and the equivalent
  foreground final-drain path);
- completion notification, result finalization, timeout, turn/tool budgets,
  interrupt/detach, scheduled work, and runner cleanup must be separated from
  process lifetime;
- every retained child consumes memory and extension resources until explicit
  eviction;
- rollback affects both execution engines rather than only interactive mode.

This is feasible but is not the conservative MVP.

## Recommended MVP Data Flow

```text
completed child selected
  -> validate trusted absolute .jsonl session path and original child config
  -> spawn `pi --mode rpc --session <path> ...child flags...`
  -> request `get_commands`
  -> mount child transcript widget above the real host editor

ordinary host-editor submit
  -> RPC `prompt` (or `steer` / `follow_up` while streaming)
  -> return `{ action: "handled" }` to the parent input event

`//name args`
  -> validate `name` against child `get_commands`
  -> RPC `prompt` with `/name args`
  -> render `extension_ui_request` in the child viewer

close/switch/shutdown/idle expiry
  -> cancel pending child dialogs
  -> stop RPC bridge
  -> remove widget and restore parent-only input routing
```

Single `/name` remains owned by the parent Pi command dispatcher because parent
extension commands execute before the `input` event. `//name` is reserved for
the selected child. A separate explicit escape is needed if literal text that
begins with `/` must be sent to the child model.

## Safety and Validation

- Accept targets only from the existing run registry/status projections; do
  not accept arbitrary session paths from editor text.
- Require an absolute, existing, regular, non-symlink `.jsonl` path under the
  trusted session root already associated with that child.
- Maintain at most one writer/bridge per child session and one active selected
  target per parent session. Target switching closes or parks the old bridge
  before opening the new one.
- Correlate every RPC command and dialog by unpredictable request ID. Reject
  duplicate, unknown, stale, or wrong-target responses.
- Bound stdin queues and pause writes on backpressure. Use Pi's strict LF-only
  JSONL framing, not `readline`.
- Never let an unknown `//command` fall through to an LLM prompt.
- On bridge crash, preserve the session file, show a recoverable viewer error,
  and fall back to the current read-only transcript/steer behavior.

## Focused Prototype and Tests

Before full implementation:

1. Spawn a fixture RPC child on a temporary persisted session with a fixture
   extension command that calls `notify`, `select`, `confirm`, `input`,
   `editor`, and `custom()`.
2. Prove `get_commands`, ordinary multi-turn prompts, mid-stream steer/follow-up,
   command execution, UI correlation, `agent_settled`, and clean shutdown.
3. Run unmodified DCP and prove `//dcp`, `//dcp stats`, and unavailable-DCP
   behavior.
4. Reopen a completed fixture session, append one turn, close, then parse the
   session to prove a single valid branch and no concurrent writes.
5. Exercise stdout fragmentation, LF framing, invalid JSON, backpressure,
   child crash, pending-dialog cancellation, idle expiry, target switching,
   and parent-session shutdown.
6. Verify the existing foreground/async execution suite remains unchanged for
   Option A, then add integration coverage for the bridge-to-viewer boundary.

## Residual Rendering Boundary

RPC solves child command dispatch and serializable child UI requests. It does
not expose Pi's effective message/tool renderer registry. Standard child
messages can reuse exported Pi message components, while exact tool/custom
message rendering still needs explicit fallbacks or an upstream rendering
delegate, as documented in `pi-native-editor-renderer-feasibility.md`.
