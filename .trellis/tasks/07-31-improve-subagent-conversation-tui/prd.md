# Improve Interactive Subagent Conversation TUI

## Goal

Make the interactive subagent viewer feel like Pi's main conversation surface:
users can hold an ongoing direct conversation with a selected subagent while
benefiting, wherever Pi's extension architecture permits, from the host's
native editor behavior, slash-command completion, message/tool rendering, and
installed display extensions such as `pi-tool-display` and `pi-zentui`.

## Background / Confirmed Facts

- **Decision (2026-07-31): MVP uses Option B — every execution child is a
  persistent RPC process from launch.** Direct conversation and child slash
  commands are available immediately, including while the initial task is
  streaming. `agent_settled` is the logical completion signal; the process
  stays alive for further prompts until explicitly evicted.
- The previous task added `/subagents`, a full-terminal capturing overlay, a
  live child transcript, direct steer delivery, and semantic child controls.
- The current child-view editor and transcript renderer are extension-owned TUI
  components rather than Pi's complete main conversation/editor stack.
- The current compatibility contract deliberately avoids replacing the host's
  `CustomEditor` and avoids attaching the parent runtime to a child session.
- Pi extensions installed by the user may alter the host's native message/tool
  presentation, so merely copying Pi's default visual primitives is not enough
  to inherit those alterations.
- Pi 0.82.1 does not expose the live editor instance, composed autocomplete
  provider, effective tool definitions, message-renderer registry, or complete
  session-rendering pipeline to `ctx.ui.custom()`.
- Pi does expose a supported alternative to embedding: keep the real editor in
  place, render the selected child transcript above it, and use the extension
  `input` event's `handled` result to route ordinary host-editor submissions to
  the selected child without starting a parent turn.
- In that routing mode, the actual active editor retains installed wrappers
  such as Zentui, slash/path completion, history, multiline editing, paste,
  keybindings, and IME behavior.
- Parent built-in and extension slash commands are dispatched before the
  extension `input` event. Separately, Pi RPC mode accepts prompt requests that
  execute commands registered in the child runtime and proxies several child UI
  operations as structured requests; the current `json -p` child transport does
  not use that facility because stdin is ignored.
- Pi RPC `get_commands` enumerates child extension commands, prompt templates,
  and skills, but not built-in interactive-only commands. RPC `prompt` executes
  a known child extension command even while the child is streaming.
- Verified in Pi 0.82.1 source: `agent_settled` is emitted only by RPC and
  interactive modes (`dist/core/agent-session.js:317-318`), never by `json`
  mode. Option B therefore requires switching child launch args from
  `--mode json -p` to `--mode rpc`.
- Verified: RPC mode rejects `@file` args (`dist/main.js:428-430`), ignores
  CLI positional messages for initial prompting, and loads no task from argv;
  the task must be sent as an RPC `prompt` command over stdin after spawn
  (`dist/main.js:624-656`). The `-p`/`--print` flag is harmless but ignored in
  RPC mode (`resolveAppMode`, `dist/main.js:78-88`).
- Verified: RPC stdin EOF triggers graceful shutdown that disposes the runtime
  and persists the session (`dist/modes/rpc/rpc-mode.js:570-610`); the process
  otherwise stays resident waiting for the next command — the needed
  persistent-child semantics.
- Verified: child stdout/stderr are currently spawned with stdin `"ignore"` in
  both foreground (`run-single-attempt.ts:219-226`) and background
  (`run-pi-streaming.ts:37-42`) runners; Option B must switch stdin to `"pipe"`
  and own the RPC JSONL write side, keeping Pi's strict LF-only framing.
- Verified: `--session <path>` is supported in RPC mode via
  `SessionManager.open` (`dist/main.js:206-232`); the child remains the sole
  writer of its session file, and RPC shutdown disposes the session cleanly.
- RPC proxies `notify`, `select`, `confirm`, `input`, `editor`, string widgets,
  status, title, and editor-text requests. Direct TUI methods such as `custom()`
  and custom editor/component factories are unavailable or degraded.
- An unmodified DCP is a valid generic RPC case: `/dcp` is a registered child
  extension command and its `ui.notify()` output becomes an RPC UI request.
- Pi supports reopening a persisted session by explicit `--session` path
  (`dist/main.js:206-232`). With Option B this is the recovery path for an
  already-evicted settled child (registry guards against a second writer); it
  is not the primary continuation mechanism, which is the resident RPC
  process.
- Effective tool/custom-message renderer lookup remains private even when the
  real editor or RPC command dispatcher is reused.
- Reusing a child session through `switchSession()` remains out of scope unless
  new evidence proves it safe for a live externally-written child session and
  for preservation of the parent subagent orchestrator runtime.

## Requirements

### R1 — Direct multi-turn child conversation

- Keep a selected child conversation open across repeated user submissions and
  child responses; users must not need to route each follow-up through the
  parent agent.
- Preserve the existing target identity, live status, transcript following,
  steer delivery, and semantic-control behavior.
- With Option B, ordinary submissions route through the live RPC child
  (`prompt` with `streamingBehavior: "steer"` while the child is streaming),
  replacing the file-inbox steer for persistent children; the file-inbox steer
  remains the fallback for one-shot/legacy child launches.

### R2 — Native editor behavior where architecturally possible

- Prefer a supported host-editor routing mode: keep Pi's actual active editor
  mounted and focused, show the child transcript in an above-editor read-only
  surface, and intercept ordinary submissions for the selected child.
- The desired behavior includes slash completion, command discovery, history,
  keybindings, multiline editing, IME/focus behavior, and compatibility with
  editor-related extensions.
- Do not clone `getEditorComponent()` or globally call `setEditorComponent()`;
  those paths create or replace editors and do not expose a safely reroutable
  host-wired instance.
- Retain the isolated composer as a rollback fallback if the required Pi input
  ordering fails a focused integration prototype.

### R3 — Host rendering and display-extension compatibility

- Investigate whether child transcript records can flow through Pi's real
  message/tool rendering pipeline so installed extensions such as
  `pi-tool-display` and `pi-zentui` affect the child view automatically.
- Prefer shared host render pipelines or explicit extension points over copied
  styles and private reimplementations.
- Define truthful behavior for extensions that register message renderers,
  tool renderers, widgets, custom editors, or whole-surface TUI replacements.

### R4 — Parent-session safety

- The parent session remains authoritative and continues orchestrating runs.
- Opening or closing the child view must not tear down the parent runtime,
  mutate its conversation, corrupt a child session file, or discard third-party
  extension state.
- Do not create concurrent writers for a Pi session file.

### R5 — Graceful compatibility and fallback

- Preserve `/subagents` as a reliable entry and preserve a way to return to the
  parent session without losing editor contents or focus.
- Clearly indicate when ordinary host-editor input is routed to a child, and
  provide reliable switch/exit commands that do not overload Escape.
- Unsupported native integrations must degrade explicitly to a documented
  fallback rather than silently breaking completion or plugin rendering.
- Existing configurations and subagent control paths remain backward
  compatible unless a reviewed migration is part of the final plan.
- Persistent-child lifecycle settings (enabled toggle, idle eviction window,
  resident-child cap) are adjustable through the extension config file with
  backward-compatible defaults and are documented in README.

### R6 — Generic child command routing

- In selected-child mode, `//<name> [args]` requests command dispatch in the
  selected child's own Pi runtime; it must not become a literal steer message or
  execute the parent's same-named command.
- With Option B the child is already a live RPC process, so `//<name>`
  validates against that process's `get_commands` and executes via RPC
  `prompt: "/<name> <args>"` with no session-reopen step.
- Prefer Pi's existing RPC prompt and extension-UI protocol over a new
  plugin-specific action registry.
- Initial no-plugin-change compatibility case: `//dcp [args]` invokes DCP
  registered in the selected child and relays its `ui.notify()` result to the
  parent viewer.
- Relay RPC extension UI methods that have serializable contracts
  (`notify`, `select`, `confirm`, `input`, `editor`, status/widget/title/editor
  text as applicable). Clearly reject or degrade unsupported direct-TUI methods
  such as `custom()`; arbitrary child component instances are never transported.
- Command availability is taken from the selected child runtime. An unknown or
  unloaded command produces a visible result and must not silently fall through
  to a child LLM prompt.
- The existing parent `/dcp` behavior remains unchanged.

### R7 — Child conversation process lifecycle

- Preserve the existing foreground and async definition of completion: the
  original delegated task produces its result, lifecycle artifacts, and
  notifications without waiting for the user to close an interactive viewer.
- Never attach a second writer to a child session while the original child is
  still active.
- Option B lifecycle: the execution child is the persistent RPC process;
  `agent_settled` marks logical completion while the process remains resident
  for further turns and commands. Eviction is explicit (viewer close, target
  switch, parent-session shutdown, idle expiry, or run finalization timeout)
  and performs a graceful RPC shutdown that persists the session.
- Foreground and async completion semantics must be separated from process
  lifetime: result finalization, structured output, acceptance evaluation,
  artifact/metadata writes, completion-guard evaluation, and run
  notifications fire at logical completion (`agent_settled`) or on the
  existing terminal-stop path, not only at process close.
- Closing the child mode, switching target, parent-session shutdown, bridge
  crash, or idle expiry must leave a valid persisted session and restore normal
  parent input routing.
- Intercom detach (decided 2026-07-31): a detached child's RPC process is
  terminated (abort + graceful shutdown) rather than handed off; continued
  conversation with a detached child is deferred. The existing detach result
  semantics (exitCode -2, `onDetachedExit` cleanup) are preserved.

## Acceptance Criteria

- [ ] AC1: A technical feasibility report identifies, with Pi API/source and
      installed-extension evidence, which native editor and rendering surfaces
      are public/reusable, private but adaptable, or unavailable.
- [ ] AC2: The reviewed design provides direct multi-turn conversation with one
      selected child and defines target switching, terminal-state behavior, and
      return-to-parent behavior.
- [ ] AC3: While child conversation mode is active, the actual installed host
      editor—including Zentui/custom wrappers, slash/path completion, history,
      multiline editing, paste, keybindings, and IME—remains mounted and focused;
      ordinary submissions reach only the selected child.
- [ ] AC4: Child messages and tool calls use the host's effective rendering
      pipeline—including compatible installed display extensions—or the plan
      states precisely which extension categories cannot be inherited and why.
- [ ] AC5: The parent session receives no ordinary child-routed user message or
      model turn; its editor, widgets/status, and extension state survive mode
      activation, target switching, parent slash commands, and exit.
- [ ] AC6: Existing foreground and async steer/control behavior and its tests do
      not regress.
- [ ] AC7: New editor/render integration boundaries have focused unit or
      integration coverage, and the complete project test suite passes.
- [ ] AC8: With unmodified DCP loaded in the selected child, `//dcp` and agreed
      DCP subcommands execute through the child's command dispatcher, use that
      child's state, and relay supported extension UI requests to the parent;
      without DCP, the UI reports that the child command is unavailable.
- [ ] AC9: The child conversation lifecycle has one authoritative writer per
      session, does not delay or duplicate normal run completion, cleans up RPC
      processes and pending dialogs deterministically, and can reopen a
      completed child for another turn without corrupting its session.

## Out of Scope

- Reimplementing every Pi editor or renderer feature inside pi-subagents when a
  supported shared surface does not exist.
- Depending on undocumented concurrent writes to parent or child session files.
- Making arbitrary third-party plugins compatible when they replace private Pi
  internals without exposing a composable contract; such gaps should instead
  be documented and, where useful, proposed upstream.
- Reflectively accessing Pi's private command registry or transporting arbitrary
  child TUI component instances across processes.
- Modifying `../pi-dcp-migrate` as part of this task; DCP is an unmodified
  compatibility case for the generic transport.

## Open Questions

- None blocking. Resolved 2026-07-31: MVP converts every execution child into a
  persistent RPC process (Option B). Remaining product/scope decisions (default
  idle eviction window, resource limits for retained children, whether to keep
  a config escape hatch back to one-shot json children) are captured as open
  options in `design.md` and will be finalized at review.
