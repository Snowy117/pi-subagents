# Design: unified native child conversation (host editor + host rendering + async bridge)

Companion to `prd.md`. Decides R0–R7 with the reviewed product decisions
(Q1=B, Q2=A, Q3=A, Q4=settings.json + getToolsExpanded).

## 1. Architecture overview

```
parent pi (interactive, extension pi-subagents, target 0.83.0)
├─ ChildConversationChannel (viewer-only abstraction, see §2)
│   ├─ LocalRpcChannel        —— foreground resident child (ChildProcess stdio)
│   └─ AsyncBridgeChannel     —— async running child (runner bridge, file transport)
│   └─ (reopened child is LocalRpcChannel)
├─ resolveChildChannel(target)  —— the ONLY sync/async branch point
├─ child-conversation widget   —— full-height, native-component assembler (§3)
├─ pi.on("input") routing      —— unchanged semantics, now channel-generic (§4)
└─ runner process (async):
    ├─ conversation relay per child (requests inbox + stdout mirror + heartbeat)
    └─ linger-on-conversation lifecycle (§5)
```

## 2. ChildConversationChannel

```ts
interface ChildConversationChannel {
  readonly key: string;                    // "runId/stepIndex/agent" (or runId/index)
  write(record: RpcOutgoingRecord): void;  // prompt | get_commands | ...
  onStdoutLine(cb: (line: string) => void): () => void;  // raw child RPC JSONL
  readonly settled: boolean;
  readonly closed: Promise<void>;
  lastActivityAt: number;
  close(kind: "graceful" | "force"): Promise<void>;
}
```

- `LocalRpcChannel`: thin wrapper over the existing `PersistentRpcChild`
  (already implements writeLine/closed/settled; `onStdoutLine` = stdout data
  listener with the existing line-buffer).
- `AsyncBridgeChannel`: `write` = atomic append to
  `<asyncDir>/conversation/<stepKey>.requests.jsonl`; `onStdoutLine` = tail
  `<stepKey>.stdout.jsonl` (reuse/extend the transcript-tail line reader;
  TTL-cached); heartbeat interval rewrites `<stepKey>.active`; `closed` =
  bridge EOF / `child_closed` marker / runner pid death.
- `resolveChildChannel(target)` (single branch point, in
  `src/extension/index.ts` or a new `src/tui/steer-view/child-channel.ts`):
  1. foreground: registry → reopen (existing logic);
  2. async running (listAsyncRuns state queued|running): AsyncBridgeChannel
     with bounded retry for bridge boot race (≤ ~2s);
  3. async terminal (complete|failed|paused): wait for runner pid death
     (bounded ~5s) → reopen via reopen-bridge → LocalRpcChannel;
  4. otherwise undefined → degraded surface (§6).
- Re-resolution on channel death: host-editor mode keeps the accumulated
  in-memory conversation; when the active channel's `closed` fires, it
  re-runs `resolveChildChannel`: reopen succeeds → swap channel seamlessly;
  else auto-close with a clear notice (existing behavior preserved).

## 3. Widget surface + native assembler (R2, R3)

### Full-height widget
- Keep `ctx.ui.setWidget(HOST_EDITOR_WIDGET_KEY, factory)` ("aboveEditor").
- The widget component renders exactly `W` lines where
  `W = max(1, tui.terminal.rows - CHROME)` with a conservative
  `CHROME = header(2) + editor(6) + footer(2) + margin(1)` (re-evaluated per
  render; terminal resize safe). Content shorter than W is blank-padded, so the
  parent chat is pushed into scrollback by TUI's bottom-anchored viewport;
  exiting removes the widget and restores the pre-mode viewport (scrollback-
  preserved chat tail).
- Internal scrolling: none (parity with the main view, which relies on
  terminal scrollback); the assembler renders the tail of the item list that
  fits, oldest lines roll into scrollback.
- Widget is non-focusable (editor keeps focus). Status bar shows
  `subagent: <agent> · <runId>:<index> · <status>` while active (existing).
- Last rendered height cached for differential rendering via `invalidate()`.

### Assembler (`src/tui/child-conversation/`)
Port of `InteractiveMode.addMessageToChat` + `renderSessionItems` + the live
event handlers (see research/native-renderer-reuse.md), transport-agnostic:

- Inputs: (a) history — transcript records (full Message objects), (b) live —
  raw channel lines via `onStdoutLine`, (c) settings snapshot.
- Output: component tree assembled into the widget's Container:
  user → `UserMessageComponent`; assistant → `AssistantMessageComponent`
  (streaming pattern with message_start/update/end);
  `content[].toolCall` → `ToolExecutionComponent` (toolDefinition undefined =
  generic; paired with `toolResult` by `toolCallId`; `markExecutionStarted`,
  `setArgsComplete`, `updateResult({...result, isError})`, `setExpanded`
  re-applied per settings pass); custom → `CustomMessageComponent` +
  renderer lookup attempt (our own renderer map for types we registered in the
  parent; unknown → labeled generic fallback); bashExecution →
  `BashExecutionComponent`; malformed/truncated → bounded Markdown/Text
  fallback with an explicit label.
- Live streaming: mirror the main view — on `message_start`(assistant) create
  a streaming component + `updateContent` per `message_update` + extract tool
  calls; `tool_execution_start/update/end`, `tool_result_end` update the
  pending map. This replaces the current "whole-message-at-end" strip.
- Duplicate/late record tolerance: the assembler de-dupes by message id where
  the protocol provides one; else by (role, ts) heuristics, keeping byte
  fidelity from the single source at a time (history seed then live).

### Settings (Q4)
`viewerSettings.ts` reads `<agentDir>/settings.json` + `<cwd>/.pi/settings.json`
(deep merge, project wins) with a 500ms TTL cache; exports
`{hideThinkingBlock, outputPad, showImages, imageWidthCells, codeBlockIndent,
hiddenThinkingLabel}`; markdown theme = `{...getMarkdownTheme(), codeBlockIndent}`;
`toolOutputExpanded = ctx.ui.getToolsExpanded()` (fallback: default collapsed if
the API is absent at runtime). Re-applied on each settings pass.

## 4. Input routing + child agent operations (R1, R1b)

### 4.1 `pi.on("input")` (unchanged host-editor semantics, channel-generic)

- active + resident channel found:
  - `!bash` / single `/` → `continue` (parent);
  - `//name args` → validate via `get_commands` (cache/TTL; forwarded through
    the channel; async: request/response cross the bridge) → RPC prompt
    `"/name args"`; unknown → visible "command unavailable"; never an LLM
    prompt;
  - ordinary text → RPC `prompt` with `input.streamingBehavior` and
    `input.images` (forwarded; image paste parity) → `handled`.
- channel gone (dead process / bridge EOF / reopen raced): auto-close mode +
  re-resolve; if the target reopened, continue seamlessly; else `continue`.
- `lastActivityAt` refresh keeps the channel alive (both Local and Bridge).

### 4.2 Agent-level keybinding interception (Q5=A)

While child mode is active a terminal-input interceptor
(`ctx.ui.onTerminalInput`, same pattern as entry-shortcut's Down hook) maps
app-level actions to the **child**, so the child is operated "like the main
agent". The editor keeps focus; editor-level keys are never intercepted.

**Key resolution (no hard-coded keys):** the extension builds an effective
key map for the 7 app actions from the public default table (`dist/core/
keybindings.js`: interrupt=escape, thinking.cycle=shift+tab,
model.cycleForward=ctrl+p, model.cycleBackward=shift+ctrl+p,
model.select=ctrl+l, tools.expand=ctrl+o, thinking.toggle=ctrl+t) merged
with user overrides from `<agentDir>/keybindings.json` (same file and merge
direction Main uses; apply the legacy-name migration for these names).
`KeybindingsManager` is exported from the package root only as a type in
0.83.0, so the merge is reimplemented in a small `child-keybindings.ts`
(key resolver + `matchesKey`), stable because the defaults+migration are a
small fixed contract; TODO switch to `KeybindingsManager.create()` if pi
later exports the value. Cache with TTL; unchanged/empty bindings are skipped.

**Action → child mapping (through the same ChildConversationChannel):**

| app action | child command(s) | notes |
| --- | --- | --- |
| interrupt | `abort` | only when the child is streaming (locally tracked: prompt→…→agent_settled); else pass through (Escape closes autocomplete as in the main view) |
| thinking.cycle | `cycle_thinking_level` | response `{level}` → status bar |
| model.cycleForward | `cycle_model` | response `model` → status bar |
| model.cycleBackward | `get_available_models` + `set_model(prev)` | |
| model.select | `get_available_models` → `ctx.ui.select` → `set_model` | viewer-side picker; not a byte-identical ModelSelectorComponent |
| tools.expand | (local) toggle child-view `expanded` | assembler re-applies `setExpanded` |
| thinking.toggle | (local) toggle child-view `hideThinkingBlock` | |

Intermediates render feedback through the widget status line / notify; agent
state (`get_state`: model/thinkingLevel/isStreaming) may be polled on render
for the status line.

While child mode is active these keys act on the child and cannot operate the
main agent (documented expectation). Registration is scoped to child-mode
active; exiting restores main semantics. Interceptor runs in registration
order together with other extensions' terminal listeners; it returns
`{ consume: true }` only when it routes a key.

## 5. Runner bridge + lifecycle (async)

Runner (`run-subagent.ts` + `run-pi-streaming.ts`) additions:

1. `ensureConversationDir(asyncDir)` at run start; per persistent child with
   `conversation` enabled (persistentChildren true): append every parsed child
   stdout line to `<stepKey>.stdout.jsonl` (single writer; line framing reused
   from the existing buffer); append `child_ready` / `child_settled` /
   `child_closed` markers.
2. Watch `<stepKey>.requests.jsonl` (offset-cursor, like steer inbox): forward
   `prompt`/`get_commands` records verbatim to the child's RPC write;
   `ping` → appended `pong`-style lives in relay.
3. Heartbeat: `<stepKey>.active` fresh (TTL 30s) ⇒ child is "conversing":
   excluded from eviction loops (idle/cap) and, at finalize, not closed.
4. `finalizeRun` still writes results/status/notifications immediately; the
   runner lingers (max 10 min) while ≥1 child has a fresh heartbeat; when all
   expired/removed → `closeAll("graceful")` → exit. Bridge dir remains for
   reopen; parent clears heartbeats on viewer close / target switch /
   `session_shutdown`.
5. Relay cap 20 MiB: truncate + `relay_reset` marker (viewer resyncs).
6. Runner eviction loop mirrors the parent extension timer
   (`evictIdle`/`evictOverflow` with `except` = conversing keys, same config
   `subagents.*` keys).

Open/reopen guard: parent reopens only when the runner pid is dead (ESRCH on
`process.kill(pid, 0)`) — bounded wait; single-writer invariant holds.

## 6. Degraded surface

Only when `resolveChildChannel` yields nothing (no resident, no bridge, no
reopenable session — e.g. `--no-session`): the existing `SteerViewComponent`
overlay becomes the explicit degraded surface:
- header clearly states "conversation continuity unavailable";
- transcript rendered with the SAME native assembler (no more self-drawn
  Markdown/Text message lines or `▶ tool` strings), read-only + file steer;
- no host-editor promise (clear notice).

## 7. Compatibility & rollout

- Compile target bump: repo `node_modules/@earendil-works/pi-coding-agent`
  → 0.83.0 (matches runtime; type-check must pass; new public API
  `getToolsExpanded` used). Check the lockfile/package.json peer range.
- Existing config keys unchanged (`subagents.persistentChildren`,
  `subagents.eviction.*`); new keys only if needed with backward-compatible
  defaults (heartbeat TTL / linger max / relay cap,
  `subagents.childKeyRoute` default true).
- Fallback matrix:
  | child | channel | surface |
  | --- | --- | --- |
  | foreground resident | LocalRpcChannel | host-editor widget |
  | foreground evicted + session | reopen → LocalRpcChannel | host-editor widget |
  | async running | AsyncBridgeChannel | host-editor widget |
  | async terminal + session | reopen → LocalRpcChannel | host-editor widget |
  | no-session / none | — | degraded native-rendered overlay |
- Tests: unit (channel abstraction, assembler pairing/settings, bridge
  protocol, routing matrix), integration (foreground + async RPC children,
  bridge round-trip, runner linger/finalize, reopen race), e2e smoke as
  feasible; full suite green.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Bridge boot race (runner starts bridge after viewer opens) | bounded retry on open; degraded fallback with clear notice |
| Reopen while runner still closing children | wait on runner pid death (bounded); registry one-writer guard |
| Runner lingers indefinitely (parent crash) | heartbeat TTL 30s + max linger 10min; session_shutdown clears heartbeats |
| Relay file growth | 20MiB cap + relay_reset marker |
| Widget height overflow with Zentui tall editor | conservative CHROME; re-evaluate per render; manual smoke |
| Settings drift at runtime (/settings while child open) | 500ms TTL re-read + re-apply setExpanded |
| message ids absent in transcript records | de-dupe by (role, ts) heuristics; single-source seeding |
| 0.83.0 compile bump breaks other code | type-check + full suite; isolated dep bump commit |

## 9. Rollback

- `subagents.persistentChildren: false` restores legacy one-shot json children
  wholesale — and disables the runner conversation bridge (it follows
  `persistentChildren`) — so async reverts to the degraded surface while
  foreground host-editor stays as-is when separately enabled.
- `subagents.childKeyRoute: false` restores main-agent key semantics wholesale
  (no interception).
- The assembler is additive: swap widget content without touching routing.
- (Note: an independent `subagents.conversationBridge` switch was proposed;
  the implementation gates the bridge on `persistentChildren` instead — a
  single existing switch — see README.)