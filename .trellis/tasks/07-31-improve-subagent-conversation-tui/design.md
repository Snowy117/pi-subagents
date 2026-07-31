# Design: Persistent RPC Execution Children (Option B)

## Status

Approved direction (2026-07-31): every execution child is a persistent Pi RPC
process from launch. This design replaces the one-shot `--mode json -p` child
in both foreground and async runners, then layers the interactive conversation
viewer on top of the retained RPC process.

## 1. Architecture Overview

```
parent Pi (interactive, extension pi-subagents)
 ├─ foreground runner  ── spawn ──▶ pi --mode rpc --session <path> ... child
 ├─ async runner       ── spawn ──▶ pi --mode rpc --session <path> ... child
 └─ child viewer (steer-view)
      ├─ transcript widget mounted above the real host editor
      ├─ `input` handler returns { action: "handled" } for child-routed text
      └─ RPC client per child: prompt / steer / follow_up / get_commands
           └─ extension_ui_request  ──▶ viewer widgets/dialogs
           └─ extension_ui_response ◀── viewer replies
```

Key boundary: the parent never writes a child session file. The RPC child is
the sole writer of its `--session` file for its whole lifetime (spawn through
graceful RPC shutdown). The parent only owns the RPC stdin/stdout channel.

## 2. Child Launch Changes

Current (both engines, verified):

- args: `["--mode", "json", "-p", ...]` (`run-single-attempt.ts:92`,
  `run-single-step-helpers.ts:83-90`)
- stdin: `"ignore"` (`run-single-attempt.ts:219-226`, `run-pi-streaming.ts:37-42`)
- task delivered as positional CLI text (`buildPiArgs` appends `Task: ...`)

New (Option B):

- args: `["--mode", "rpc", ...]` (drop `-p`; harmless but pointless in RPC)
- stdin: `"pipe"` — parent owns the JSONL write side
- task delivered after spawn as RPC `prompt` with the same task string
  (verified: RPC ignores CLI positional messages and rejects `@file` args,
  `dist/main.js:428-430,624-656`)

`buildPiArgs()` needs a mode parameter (`"json" | "rpc"`) that:

- selects `--mode rpc` and omits `-p`;
- skips appending `Task: <text>` when the task is delivered over RPC (keep the
  `@file` path only for large tasks? No — RPC rejects `@file`; large tasks must
  go over the stdin prompt channel instead, so the `@file` branch must not be
  used in RPC mode);
- keeps `--session <path>` (verified supported in RPC mode,
  `dist/main.js:206-232`);
- keeps all extension/tools/skills/system-prompt flags unchanged.

`--no-session` remains valid when the user disabled session persistence; an
RPC child without a session file cannot be reopened later, which the viewer
must surface as "conversation continuity unavailable".

## 3. Completion Semantics: Decouple Logical Completion from Process Lifetime

Verified: `agent_settled` is emitted only by RPC and interactive modes
(`dist/core/agent-session.js:317-318`). `json` mode never emits it. Option B
therefore keys logical completion on `agent_settled` (or the existing
terminal-stop signals for error/timeout/budget/interrupt paths).

### Foreground runner (`run-single-attempt.ts` + `single-attempt-*.ts`)

Today `close` → `finish(code)` → `finalizeSingleAttempt`. With Option B:

1. Spawn RPC child, send initial `prompt` (the task).
2. Stream events as today; keep the existing terminal-stop detection.
3. On `agent_settled` (new event type in the parser): run logical finalization
   (`finalizeSingleAttempt`) exactly as today — result, structured output,
   acceptance, artifacts, metadata, completion guard, notifications — WITHOUT
   closing the process. Record the child as `settled` but resident.
4. The `SingleResult` is produced at `agent_settled`; the process handle is
   parked in a per-run child registry keyed by runId/index.
5. Timeout/turn-budget/tool-budget/interrupt paths remain process-directed
   (RPC `abort` then graceful shutdown), because the run has failed/stopped
   and there is nothing left to converse about.
6. `onDetachedExit` and intercom detach semantics: a detached child keeps its
   RPC channel owned by the intercom consumer; document the handoff.

### Async runner (`run-pi-streaming.ts`, `run-single-step.ts`)

Today `isTerminalAssistantStop` → final drain → SIGTERM → SIGKILL → `close`
resolves the run. With Option B:

1. Replace the final-drain/kill timer logic with `agent_settled` detection.
2. `runPiStreaming` resolves the step result at `agent_settled`; the RPC
   process stays resident and is registered in the async child registry
   (keyed by runId/stepIndex/agent).
3. Timeout/budget/interrupt still terminate the process (RPC `abort` +
   shutdown) — a stopped run has no conversational future.
4. `RunPiStreamingResult.exitCode` semantics: derive success from the settled
   state + error flags as today, not from process exit (the process may not
   exit until eviction).

### Terminal-stop fallback

`agent_settled` should arrive promptly after the final assistant message. If a
residual retry/compaction loop makes `agent_settled` late, keep the existing
`isTerminalAssistantStop`-based drain only as a watchdog that upgrades to
`agent_settled` semantics (treat terminal stop as settled once no retry flag
follows within a bounded window), matching current behavior for
`cleanTerminalAssistantStopReceived`.

## 4. Persistent Child Registry and Eviction

New module `src/runs/persistent/rpc-child-registry.ts` (parent side):

```ts
interface PersistentRpcChild {
  key: string;                 // runId + index (or async runId + stepIndex + agent)
  sessionFile?: string;
  proc: ChildProcess;          // stdio pipe
  writeLine(line: string): void;   // LF-only JSONL, backpressure-aware
  settled: boolean;
  lastActivityAt: number;
  pendingDialogs: Map<requestId, ...>;
  close(kind: "graceful" | "force"): Promise<void>;
}
```

Rules (R4/R7):

- At most one registry entry per child key; opening a viewer target for the
  same key reuses the resident process (no second writer, no reopen).
- Eviction triggers: viewer close, target switch (park old child), parent
  session shutdown, idle expiry, run finalization timeout, registry cap.
- Graceful close: drain pending dialogs (cancel), write any pending JSONL,
  close stdin (EOF → Pi shutdown → session persist, verified
  `rpc-mode.js:570-610`), await exit with a bounded grace, then SIGTERM/SIGKILL
  escalation.
- Idle expiry default: configurable, propose 15 min (open option at review).
- Registry cap: configurable max resident children; overflow evicts
  least-recently-active settled children first (never an active/streaming one).
- Parent session shutdown (`session_shutdown` event) closes all resident RPC
  children gracefully before parent teardown completes.

## 5. Interactive Conversation Viewer (R1, R2, R3, R5)

Keep the existing steer-view overlay as the entry and rollback surface, then
upgrade it to the host-editor routing mode:

1. `/subagents` picker → select child → activate child-conversation mode.
2. Resolve the selected child's `PersistentRpcChild` (resident process if the
   run is live/settled; if evicted, reopen via `--session` bridge only when no
   resident writer exists — with Option B this is the rare path).
3. Mount the read-only transcript widget above the real host editor via
   `ctx.ui.setWidget()` (verified public, `types.d.ts:91-98`); do NOT replace
   or reparent the editor.
4. `pi.on("input")` handler: when child mode is active and the text is
   ordinary (no leading `/`), send to the child via RPC (`prompt` with
   `streamingBehavior: "steer"` while streaming) and return
   `{ action: "handled" }` (verified `types.d.ts:621-640`,
   `docs/extensions.md:885-923`). Parent gets no message and no turn.
5. `//name args` (R6): validate against the child's `get_commands`; execute
   via RPC `prompt: "/name args"`; render `extension_ui_request` in the
   viewer; unknown → visible "command unavailable", never sent as LLM prompt.
6. Single `/name` stays parent-owned (parent dispatch runs before `input`);
   `!bash` stays parent-owned (`interactive-mode.js:2228-2243`).
7. Explicit exit/switch commands: e.g. `/subagents exit`, `/subagents target
   <n>`, or a viewer keybinding — never overload Escape (closes autocomplete).
   Editor text and focus are untouched on exit (widget removal only).
8. While the parent is streaming, child-mode submissions still route to the
   child; tests must prove the parent queue display is undisturbed.

Rendering (R3): RPC does not expose Pi's effective renderer registry. Use the
existing hybrid: exported native `UserMessageComponent` /
`AssistantMessageComponent` / `ToolExecutionComponent` for standard messages;
explicit generic fallbacks for tool/custom messages; same-realm prototype
patches from pi-tool-display/pi-zentui remain opportunistic. Document the
boundary truthfully (see `pi-native-editor-renderer-feasibility.md`).

## 6. Child Command Routing (R6)

- `get_commands` at viewer open and refreshed on demand; cache with TTL.
- `//name` dispatch sequence: check cache → (refresh if unknown) → RPC
  `prompt: "/name args"` → stream `extension_ui_request` events to the viewer.
- Supported UI relay (serializable contract, verified `rpc.md:1149-1333`):
  `notify` (toast/notice), `select`/`confirm`/`input`/`editor`
  (correlated dialogs with `extension_ui_response`), `setStatus`/`setWidget`/
  `setTitle`/`set_editor_text`.
- Unsupported: `custom()` and component factories (return `undefined` in RPC);
  the viewer shows an explicit unsupported-UI notice and never transports
  component instances.
- DCP: unmodified DCP registers `dcp`/`dcp-compress` via `registerCommand`
  and uses `ui.notify()` (`../pi-dcp-migrate/commands.ts:17-103`); it works
  through RPC unchanged. No DCP code change. Parent `/dcp` unchanged.
- Unknown/unloaded command: visible "child command unavailable" (verified
  `get_commands` lists only extension/template/skill commands; built-in TUI
  commands excluded). Never fall through to an LLM prompt.

## 7. Parent-Session Safety (R4)

- Parent never writes child session files; the RPC child is sole writer.
- `input` handler returns `handled` only in active child mode; otherwise
  `continue` — zero parent behavior change when mode is off.
- Widget mount/removal does not touch editor, widgets of other extensions,
  status, or the parent session.
- `setWidget` with a component factory (not the 10-line string-array widget)
  is the transcript surface; removal restores the prior layout.
- Extension state (tool-display config, zentui compositor) untouched; the
  widget coexists with Zentui's fixed editor compositor (compatibility spike
  required, see below).

## 8. Fallback and Degradation (R5)

- If the RPC spawn fails (e.g. unsupported flag), fall back to the current
  `json -p` one-shot child launch for that run and mark the run as
  "conversation continuity unavailable". A config toggle
  (`subagents.persistentChildren: true|false`, default true) restores the old
  behavior wholesale. Existing tests exercise both paths.
- If the RPC process crashes mid-conversation: show a recoverable viewer
  error, preserve the session file, fall back to read-only transcript/steer.
- If the child was launched with `--no-session` or no `sessionFile`, the
  viewer reports continuity unavailable and falls back to steer-only.

## 9. Data Flow (ordinary submit, child mode active)

```text
host editor Enter
  → Pi AgentSession.prompt() (parent)
  → parent slash dispatch (single /)  [parent-owned]
  → pi-subagents "input" handler
  → child mode active && text is ordinary / `//cmd`?
  → yes: RPC write to selected child's stdin
  →      return { action: "handled" }
  → no:  return { action: "continue" } (parent as today)

child RPC stdout
  → response { id, success }  → update pending-request map
  → agent events (message_* / tool_* / turn_*) → transcript widget + artifacts
  → agent_settled → mark settled, finalize run result, keep process
  → extension_ui_request → viewer dialog/notice
  → queue_update / compaction_* / auto_retry_* → viewer status line
```

## 10. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| RPC mode changes event shape vs json mode | Add `response`/`agent_settled`/`extension_ui_request`/`queue_update` to the parser and transcript writer; existing agent-event handling reused verbatim |
| `agent_settled` latency under retry/compaction loops | Terminal-stop watchdog bounded window (section 3) |
| Resident children consume memory/extensions | Registry cap + idle expiry + explicit eviction; default conservative cap (propose 4, open option) |
| Completion guard / acceptance run at `agent_settled` instead of `close` | Refactor finalize to a pure function invoked at settled; keep `close`-time flush only for process I/O |
| Interrupt/timeout semantics change | Keep process-directed RPC `abort` for failed runs; only successful settles retain the process |
| Backpressure on RPC stdin | Queue writes per child, pause on `drain` events, bounded buffer |
| Parent shutdown ordering | `session_shutdown` handler evicts all resident children before returning |
| Second writer risk | Registry invariant: one entry per key; reopen path guarded by registry check |
| Foreground/async tests coupling to process exit | Keep one-shot json path behind the config toggle; add new RPC-path fixtures |

## 11. Focused Prototype Gate (before full implementation)

1. Fixture RPC child with a fixture extension command using `notify`,
   `select`, `confirm`, `input`, `editor`, `custom()`; prove `get_commands`,
   multi-turn prompts, mid-stream steer/follow-up, command execution, UI
   correlation, `agent_settled`, graceful shutdown.
2. Prove `--mode rpc` child completes a real task and stays resident;
   then an ordinary viewer submit reaches it (prompt → response → message
   events) and the parent receives nothing.
3. Run unmodified DCP: `//dcp`, `//dcp stats`, unavailable-DCP behavior.
4. Reopen semantics: evict a settled child, then reopen its session via
   `--session` bridge; parse the session to prove a single valid branch, no
   concurrent writes.
5. Stress: stdout fragmentation, LF framing, invalid JSON, backpressure,
   child crash, pending-dialog cancellation, idle expiry, target switching,
   parent shutdown.
6. Existing foreground/async suite (json path) still green; new integration
   coverage for the RPC child path and the bridge-to-viewer boundary.

## 12. Out of Scope (unchanged from PRD)

- Reimplementing Pi editor/renderer internals; concurrent session writers;
  arbitrary third-party plugin compatibility; reflective command registry
  access; transporting child TUI components; modifying `../pi-dcp-migrate`.

## Open Options for Review

1. Default idle eviction window: **decided 2026-07-31 — 15 minutes,
   configurable** via `subagents.eviction.idleMs` (or equivalent config key).
2. Default resident-child cap: **decided 2026-07-31 — 4 settled children,
   configurable** via `subagents.eviction.maxResidentChildren`.
3. Config escape hatch: **decided 2026-07-31 — keep
   `subagents.persistentChildren` (default true)**; when false the legacy
   one-shot json child launch is used wholesale.
4. Detached (intercom) child RPC handoff semantics: **decided 2026-07-31 —
   document and defer.** MVP keeps the detach path terminating the RPC child
   (`abort` + graceful shutdown, process not retained); continued conversation
   with a detached child is out of scope for this task. The registry's idle
   expiry / parent-session shutdown still guarantee eventual cleanup. An
   explicit RPC-channel ownership handoff protocol (registry entry, pending
   dialogs, stdin ownership transfer to the intercom consumer session) is a
   future iteration.

All eviction settings live in the existing extension config surface (the same
config file that already holds `subagents.*` TUI/steer settings) with
backward-compatible defaults; they take effect without a parent restart where
the config is read dynamically, and are documented in README.
