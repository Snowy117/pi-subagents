# Interactive Subagent Control Contracts

> Executable contracts for parent-TUI control of headless Pi child processes.
> These rules are load-bearing across the TUI, foreground/async execution,
> filesystem control channels, and temporary transcript lifecycle.

## Scenario: Interactive child chat and semantic control

### 1. Scope / Trigger

Apply this contract whenever code:

- exposes a new parent-to-child control action;
- changes foreground or async child control directories or environment wiring;
- renders a live child transcript in the parent TUI;
- changes `/subagents`, its Down-key entry, or the full-terminal child overlay;
- changes temporary live-transcript retention or cleanup.

The child is a headless Pi process. Parent keyboard input must be translated to
a semantic action; it must not be treated as a literal child TUI key event.
The parent session remains authoritative and must never be replaced or attached
to the child session file.

### 2. Signatures

Control channel:

```ts
requestControlAction(
  targetDir: string,
  action: string,
  input?: { payload?: unknown; source?: string },
  deps?: ControlActionChannelDeps,
): ChildControlActionRequest;

consumeControlActionResponses(
  targetDir: string,
  deps?: ControlActionChannelDeps,
): ChildControlActionResponse[];

registerControlActionInbox(
  pi: ExtensionAPI,
  deps?: ControlActionInboxDeps,
): void;
```

Live transcript:

```ts
resolveLiveTranscriptPath(input: {
  persistentPath?: string;
  runId: string;
  index: number;
}): string;

retainLiveTranscript(path?: string, deps?: LiveTranscriptDeps): () => void;
markLiveTranscriptTerminal(path?: string, deps?: LiveTranscriptDeps): void;
```

TUI entry:

- `/subagents` is the reliable command entry.
- Empty-editor Down is a convenience listener only.
- The child chat is a capturing overlay opened through `ctx.ui.custom()`.

### 3. Contracts: requests, responses, environment, and lifecycle

#### Action request

```ts
interface ChildControlActionRequest {
  version: 1;
  type: "action";
  id: string;       // non-empty, unique per request
  ts: number;       // finite, non-negative epoch milliseconds
  action: string;   // non-empty semantic action name
  payload?: unknown;
  source?: string;  // non-empty when present
}
```

#### Action response

```ts
interface ChildControlActionResponse {
  version: 1;
  type: "action_response";
  requestId: string;
  ts: number;
  status: "applied" | "rejected";
  action: string;
  result?: unknown; // allowed only for applied
  error?: string;   // required only for rejected
}
```

The parent correlates responses by `requestId`. A transcript notice is audit
information, not acknowledgement authority.

#### Directory and environment contract

```text
<run>/control/
├─ steer-targets/<index>/
└─ action-targets/<index>/
   ├─ requests/
   └─ responses/
```

- `PI_SUBAGENT_STEER_INBOX` points to the child steer inbox.
- `PI_SUBAGENT_ACTION_CONTROL_DIR` points to that child's action target
  directory containing `requests/` and `responses/`.
- Action files must never be written to `steer-targets`; the steer consumer
  removes JSON files that are not valid steer requests.
- Foreground run roots live below the per-user runtime root and are registered
  before child spawn. Async steps receive deterministic per-step directories.
- JSON files are written atomically. Consumers claim files before parsing or
  applying non-idempotent actions.

#### `cycleThinking` contract

- Determine supported levels from the child model metadata and the shared Pi
  0.82 compatibility layer.
- Do not hard-code a loop containing unsupported `off`, `xhigh`, or `max`.
- Call the public child `getThinkingLevel()` / `setThinkingLevel()` APIs and
  return the actual post-set level.
- No model, a non-reasoning model, an invalid payload, an unknown action, or an
  exception produces a `rejected` response.
- Replaying a request ID must return or preserve its authoritative response;
  it must not cycle thinking a second time.

#### Live-transcript lifecycle

- If persistent transcript artifacts are enabled, use the artifact path.
- Otherwise use `<TEMP_ROOT_DIR>/live-transcripts/<runId>/<index>.jsonl`.
- A view retains a temporary transcript with a lease and releases it on every
  close/dispose/error path.
- `markLiveTranscriptTerminal()` removes the temporary transcript only after
  the child is truly terminal and no leases remain.
- A detached foreground receipt is not child termination.
- One host session shutdown must not recursively delete the global live-
  transcript root; other sessions or detached/async runs may still own files.
- Transcript output represents finalized message/tool events, not token deltas.

#### TUI and plugin compatibility

- Use a capturing overlay with `overlay: true`, `width: "100%"`,
  `maxHeight: "100%"`, `margin: 0`, and `anchor: "center"`.
- Do not call `switchSession()` or `newSession()` and do not use a non-overlay
  custom component as a full chat replacement.
- Do not install a replacement CustomEditor.
- The Down terminal listener consumes input only when the feature is enabled,
  the editor is empty, an active child exists, and this extension has no open
  modal. Every other input returns `undefined` unchanged.
- Terminal listeners run in registration order, so `/subagents` remains the
  supported fallback when another extension consumes Down first.
- For `/xxx` entered in the child view: call `done()`, await the custom UI
  promise, then call `ctx.ui.setEditorText(text)`. This preserves built-in and
  third-party slash-command dispatch.
- Components using `Input` propagate `Focusable.focused`, dispose timers and
  transcript leases, and never render a line wider than the supplied width.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Wrong version/type, extra schema key, empty id/action, invalid timestamp | Reject/discard the file without crashing the runner or child. |
| Rejected response has no error or contains a result | Treat the response as invalid. |
| Applied response contains an error | Treat the response as invalid. |
| Two consumers race for one file | Atomic claim allows at most one winner. |
| Request ID already has an authoritative response | Do not apply the action again. |
| Response write temporarily fails after action application | Retain/retry the response; never reapply the action. |
| Unknown action or unsupported thinking | Write one `rejected` response with a useful error. |
| Async/foreground target is terminal or index is invalid | Reject before writing steer/action to a stale inbox. |
| Transcript path escapes controlled roots | Refuse to read it and use a safe fallback/error state. |
| Transcript is truncated, replaced, partially written, or malformed | Reset/buffer/skip safely; keep polling without crashing the overlay. |
| Lease-directory read fails with non-`ENOENT` | Preserve the transcript; do not assume there are no viewers. |
| Overlay closes, session reloads, or context becomes stale | Stop timers, release leases, unregister listeners, and restore parent focus. |
| Earlier terminal listener consumes Down | Do nothing; `/subagents` remains available. |

### 5. Good, Base, and Bad Cases

- **Good:** the user picks a live foreground child, presses Shift+Tab, the
  parent writes one versioned request, the child claims it once, applies the
  next model-supported level, writes an `applied` response, and the overlay
  displays the actual level for that request ID.
- **Base:** a queued async step already has an action request in its deterministic
  inbox. The child consumes it after spawn; no runner-routing hop is needed.
- **Good:** persistent transcripts are disabled. The parent tails a scoped
  temporary transcript, keeps it while the overlay lease is active, and removes
  it only after real child exit and lease release.
- **Bad:** write `{ type: "action" }` into the steer inbox. The steer consumer
  deletes it and no response can be produced.
- **Bad:** open the child's session file with `switchSession()` to reuse native
  rendering. This tears down/rebinds the parent runtime, cannot live-tail an
  externally written session safely, and risks concurrent writers.
- **Bad:** call `setEditorText("/plugin")` before the overlay promise resolves.
  Pi's custom-UI restoration may overwrite the text.

### 6. Tests Required

Unit assertions:

- strict request/response parsing, including extra keys and applied/rejected
  invariants;
- atomic claim race, response replay, response-write retry, malformed files,
  and TTL cleanup;
- `cycleThinking` supported-level selection, post-set actual value, and every
  rejection branch;
- persistent versus temporary transcript resolution, lease-before-terminal,
  terminal-before-release, detached timing, and non-`ENOENT` preservation;
- transcript partial line, truncate, replace, in-place overwrite, malformed
  record, trusted-root escape, and fallback;
- target merge precedence and legacy state without live-child maps;
- overlay width, rendered-line scrolling, Focusable propagation, steer marker,
  response request-ID isolation, slash-close result, and timer disposal.

Integration assertions:

- sequential/parallel/dynamic async spawn receives the action directory;
- parallel foreground children register distinct live routes and clean up only
  after the last true exit;
- foreground/detached steer rejects stale children and reaches live children;
- `/subagents` coexists with `/subagents-fleet`; Down gates strictly and never
  replaces another CustomEditor; overlay closes before editor prefill;
- full overlay options are exactly the capturing full-terminal contract.

Real-session E2E assertions (using the faux provider, never a real API key):

- a foreground child consumes steer and the finalized transcript contains its
  unique delivery marker;
- `cycleThinking` returns an applied response from the child runtime;
- `artifacts: false` still creates, updates, retains, and cleans a temporary
  live transcript.

### 7. Wrong vs Correct

#### Wrong

```ts
// Mixed transport: the steer parser can consume and delete this file.
writeAtomicJson(path.join(steerInbox, "action.json"), actionRequest);

// Parent-session takeover breaks the orchestrator and plugin state.
await ctx.switchSession(childSessionFile);

// Pi may restore the saved editor text after this call.
ctx.ui.setEditorText("/third-party-command");
done();
```

#### Correct

```ts
const request = requestControlAction(child.actionControlDir, "cycleThinking", {
  source: "tui",
});

const result = await showChildOverlay(child);
if (result.kind === "slash") {
  // showChildOverlay has fully closed and restored the parent editor here.
  ctx.ui.setEditorText(result.text);
}

// Match only the response belonging to this view's request.
const response = consumeControlActionResponses(child.actionControlDir)
  .find((candidate) => candidate.requestId === request.id);
```

**Language**: All documentation is written in **English**.

---

## Persistent RPC execution children (unconditional)

### Scope / Trigger

Every foreground and async execution child is a persistent Pi RPC process
(`--mode rpc`, stdin piped). Logical completion is `agent_settled`; the
process stays resident for direct conversation until evicted. JSON one-shot
(`--mode json -p`) was removed 2026-08-02; `PI_SUBAGENT_E2E_JSON_CHILD`
retains a test-only escape hatch. Modules:
`src/runs/persistent/{rpc-protocol,rpc-child-registry}.ts`,
`src/runs/foreground/execution/*`, `src/runs/background/runner/*`,
`src/tui/steer-view/{host-editor-mode,reopen-bridge}.ts`,
`src/extension/index.ts`, `src/extension/config.ts`.

### Signatures

```ts
// pi-args
buildPiArgs({ mode: "rpc" });                       // always --mode rpc, no -p, no positional task, no @file
// rpc-protocol
attachRpcProtocol(child): { write: RpcWrite; reader: RpcLineReader };
// rpc-child-registry
createRpcChildRegistry(): RpcChildRegistry;       // get/has/register/unregister/evictIdle/evictOverflow/closeAll
createRpcChildCloser(child, deps): (kind: "graceful" | "force") => Promise<void>;
// eviction defaults (hardcoded; config switch removed)
IDLE_EVICTION_MS = 15 * 60 * 1000; MAX_RESIDENT_CHILDREN = 4;
// host-editor mode
createHostEditorConversation({ getResidentChild }): HostEditorConversationHandle;
// reopen bridge
createReopenBridge({ registry, getChildLaunchArgs, cwd }): ReopenBridge;
```

### Contracts

- RPC framing is strict LF-only JSONL on child stdin/stdout. Never use Node
  `readline` (it splits on U+2028/U+2029). Reader caps single records at
  16 MiB and emits an empty line as a placeholder.
- Backpressure: a false return from `stdin.write()` means the chunk was
  accepted into the stream's internal buffer; only subsequent lines queue
  until `drain` (single persistent drain listener — `once` per write
  double-flushes).
- Task delivery: RPC mode sends `prompt` over stdin after spawn; `@file` and
  positional `Task:` text are never used (Pi RPC rejects `@file`, ignores
  CLI positional messages).
- Completion: `agent_settled` → logical completion → finalize result without
  closing the process. `startFinalDrain` is disabled in RPC mode. Failed
  runs (timeout/budget/interrupt/error) are evicted (unregister + graceful
  close) — they have no conversational future.
- Registry invariants: one entry per child key; re-register replaces the
  handle (callers check `has()` first); evictIdle only touches settled
  children; evictOverflow evicts least-recently-active settled first, never
  an active/streaming one.
- Graceful close: cancel pending dialogs → stdin EOF (Pi persists session) →
  bounded grace → SIGTERM → SIGKILL. Force close skips EOF.
- Host-editor routing: `pi.on("input")` returns `{action:"handled"}` only
  while child mode is active; `!bash` and single `/` return `"continue"`
  (parent-owned). `//name` → RPC `prompt: "/name args"`. Unknown `//name`
  must not fall through to a child LLM prompt.
- Session files: the RPC child is the sole writer. The parent never opens a
  child session via `SessionManager.open`. Reopen bridge is guarded by the
  registry (never a second writer).
- Async children live in a separate runner process; their RPC registry lives
  in that process and is closed gracefully before the runner exits.

### Validation & Error Matrix

| Case | Behavior |
| --- | --- |
| RPC child crashes while host-editor mode active | Mode auto-closes, widget removed, input returns to parent; session file intact |
| `agent_settled` never arrives | Timeout/budget/interrupt paths terminate the process (failed run) |
| Reopen while resident entry exists | Returns existing entry; never spawns a second writer |
| `--no-session` child | `residentChild` continuity unavailable; viewer falls back to read-only/steer |
| `persistentChildren` config | Deprecated no-op (2026-08-02): all children are RPC regardless; `PI_SUBAGENT_E2E_JSON_CHILD=1` keeps the test JSON path |

### Tests Required

- `test/unit/rpc-protocol.test.ts` — LF-only splitting (U+2028), CRLF strip,
  fragmentation, >16MiB drop, backpressure queue/flush.
- `test/unit/rpc-child-registry.test.ts` — one-writer, idle/overflow eviction,
  graceful vs force close.
- `test/unit/host-editor-mode.test.ts` — routing matrix (ordinary/`//name`/
  single `/`/`!bash`), close stops routing.
- `test/unit/reopen-bridge.test.ts` — fresh reopen, one-writer guard, no-file.
- `test/integration/foreground-rpc-child.test.ts` + async RPC tests — settle
  → resident → evict; `--mode rpc` arg; task-over-stdin.

### Wrong vs Correct

#### Wrong

```ts
// readline splits on U+2028 — corrupts records.
readline.createInterface({ input: child.stdout });

// Buffering the backpressured chunk again double-writes it.
if (!stdin.write(chunk)) { queue.push(chunk); }

// Killing the settled child loses the session persist handshake.
trySignalChild(proc, "SIGKILL"); // on successful agent_settled

// Parent writes the child's session file (second writer).
SessionManager.open(childSessionFile).appendMessage(msg);
```

#### Correct

```ts
// LF-only JSONL writer with drain backpressure.
rpcWrite.write({ type: "prompt", message: text, streamingBehavior });

// Settle = logical completion; process stays resident; eviction closes it.
if (event.type === "agent_settled") state.finish(0);

// Graceful close persists the session (stdin EOF → Pi shutdown).
await resident.close("graceful");

// Parent never writes child sessions; reopen is registry-guarded.
if (!registry.has(key)) registry.register(reopen(target));
```

### Viewer-activity eviction and target switch

- `evictIdle(idleMs, { except })` and `evictOverflow(max, { except })` skip the
  excluded key; the extension eviction loop passes the active host-editor
  target's resident key so the child being conversed with is never evicted.
- `hostEditorConversation.routeInput` refreshes `resident.lastActivityAt` on
  every routed input.
- Selecting a new child while host-editor mode is active closes the old
  conversation first (`showChat`), then opens the new target; re-selecting the
  active target is a no-op. `open()` is re-entrant (second `/subagents`
  reopens the picker).
- `refreshCommands` binds the pending get_commands refresh to the requesting
  resident key; a stale refresh resolving after a target switch never writes
  one child's command set into the active child's cache. Timeout/no-stdout
  results are not cached (a later `//name` re-requests).

## Unified native child conversation (host editor + host rendering + async bridge)

### Scope / Trigger

Apply this contract whenever code touches the child conversation surface, the
runner conversation bridge, the transport abstraction, or the child-mode key
routing. Modules: `src/tui/child-conversation/*`,
`src/tui/steer-view/{host-editor-mode,open-view,child-channel,child-key-route,
async-bridge-channel,bridge-relay-tail,child-commands}.ts`,
`src/runs/background/runner/conversation-bridge/*`,
`src/extension/index.ts`, `src/extension/config.ts`.

### Contracts

- **Transport abstraction**: the viewer only knows `ChildConversationChannel`
  `{key, write(record), onStdoutLine(cb), settled, closed, lastActivityAt,
  touch, close(kind), exitCode?}`. Foreground = `LocalRpcChannel` (wraps
  `PersistentRpcChild`), async running = `AsyncBridgeChannel` (file bridge),
  async terminal = reopen → `LocalRpcChannel`. The ONLY sync/async branch
  point is `resolveChildChannel(target)` in `child-channel.ts`; viewer,
  assembler, and input routing have no async branch.
- **Runner bridge protocol** (`asyncDir/conversation/<stepKey>.*`):
  - stepKey = `${sanitize(stepIndex)}-${sanitize(agent)}`, sanitize `[^\w.-]→"_"`
    (paths.ts is load-bearing; both sides resolve it with the same function).
  - `requests.jsonl`: parent→runner `{id, ts, type, message?, streamingBehavior?,
    images?}`; the runner forwards prompt/get_commands/abort/model/thinking
    records VERBATIM to the child's RPC stdin **via writeLine (preserves the
    caller's id — `write()` would overwrite it)**; ping answered locally with a
    `pong` relay marker; viewer-hostile session mutations (new_session,
    switch_session, fork, clone) are NOT forwardable.
  - `stdout.jsonl`: runner mirrors every child stdout line + synthetic markers
    (`child_ready`/`child_settled`/`child_closed`/`child_unavailable`/`pong`/
    `relay_reset`); parent tails with a byte cursor (pre-seeded history never
    re-delivered; `relay_reset` → resync from new EOF). Raw child lines are fed
    verbatim to the same assembler parser as foreground RPC stdout.
  - `<stepKey>.active`: parent heartbeat `{ts}` rewritten ~every 5s; runner TTL
    30s. Fresh heartbeat ⇒ child is conversing: excluded from runner idle/cap
    eviction, and at `finalizeRun` the runner lingers (≤10min) before closeAll.
  - Parent clears heartbeats on viewer close / target switch / session shutdown
    (`closeAllOpenAsyncBridgeChannels`).
- **Reopen race guard**: the parent reopens a terminal async child's session
  only after the runner pid is confirmed dead (`process.kill(pid,0)`→ESRCH,
  bounded ≤5s); region-of-authority keeps single-writer per session across
  processes (runner closes children → parent reopen).
- **Foreground live children carry sessionFile**: `ForegroundLiveChild`
  records `sessionFile` at registration, and `fromForeground` forwards it
  into `SteerViewTarget`. `resolveForeground` therefore always has a reopen
  path when `getForegroundResident` returns undefined (process exited/evicted)
  — without this, a foreground child whose process had exited left the target
  with no sessionFile and the viewer degraded to read-only
  ("always read-only" bug, fixed 2026-08-02).
- **Channel swap**: when the active channel's `closed` fires, host-editor
  re-resolves; success → the accumulated assembler conversation survives (same
  instance; new channel's stdout feeds it; key-route re-subscribes by channel
  instance; heartbeat restarts). A 2s swap-rate guard stops reopen-spawn loops.
- **Native assembler** (`child-conversation/assembler.ts`): ports
  `addMessageToChat`/`renderSessionItems` role selection; toolCall↔toolResult
  paired by toolCallId; `toolDefinition` stays undefined (generic — the
  effective registry is private); unknown customType gets a labeled generic
  fallback; settings (hideThinkingBlock/outputPad/showImages/imageWidthCells/
  codeBlockIndent/hiddenThinkingLabel + `getToolsExpanded()`) re-applied per
  settings pass via `setExpanded`/`setOutputPad`/`setHideThinkingBlock`…
  Settings are read from `<agentDir>/settings.json` + `<cwd>/.pi/settings.json`
  (project wins, deep merge, 500ms TTL) because extensions have no settings
  accessor — the same file source the main view uses.
- **Key routing** (`child-key-route.ts`): must resolve effective keys via the
  **global `getKeybindings()` singleton** (`@earendil-works/pi-tui`), NOT
  hand-written `matchesKey` loops. The global singleton carries the user's
  `keybindings.json`, pi's default table, legacy migrations, and the
  **leader-key extension's `matches` prototype patch** (gates `leader+<key>`
  behind a pending state). A hand-written `matchesKey(data, "leader+m")`
  matches the raw letter `m` and swallows it, diverging from the main agent.
  Resolution order: `interrupt` first, then `app.*` actions. Esc → `abort`
  only while streaming, else pass through. Editing-level keys are never
  intercepted.
- **Streaming render trigger**: `ctx.ui.requestRender?.()` is a no-op
  (`ExtensionUIContext` has no `requestRender` method). The widget factory
  receives `tui: TUI` (from `@earendil-works/pi-tui`) which has a public
  `requestRender(force?)` method with ~16ms coalescing. The host-editor mode
  MUST capture the `tui` reference from the widget factory and call
  `tui.requestRender()` at the end of every `onRpcLine()` callback (both
  notify and assembler branches). Clearing `widgetTui = undefined` on mode
  close prevents stale renders.
- **Full-height widget**: the widget renders exactly `W = rows − CHROME(≈11)`
  lines (recomputed per render), blank-padded, so the parent chat rolls into
  terminal scrollback; removing the widget restores the pre-mode viewport.
- **Read-only degraded surface**: when no `ChildConversationChannel` can be
  resolved (no resident, no bridge, no reopenable session), the overlay
  (`SteerViewComponent`) renders as a **read-only transcript view** with NO
  Input component. The header shows "continuity unavailable"; footer shows
  "read-only · Esc back". Escape returns to the picker. Steer/thinking/scroll
  controls remain available but the user cannot send new messages.

### Validation & Error Matrix

| Case | Behavior |
| --- | --- |
| Runner dies while a bridge conversation is open | relay/`closed` fires; re-resolve → reopen if terminal+session, else auto-close child mode with clear notice |
| Relay truncated at cap | `relay_reset` marker; viewer resyncs from new EOF without duplicating the preserved tail |
| Heartbeat stale (parent crash) | runner stops considering child conversing; next eviction/finalize closes it (10min linger cap) |
| `--no-session` async child, run terminal | resolveChildChannel → undefined → degraded overlay (native-rendered, "continuity unavailable") |
| User remaps/removes an app key | key resolution follows keybindings.json; removed keys silently skip interception |
| Bridge request unknown type | ignored by the watcher (`REQUEST_TYPES` allowlist); child_unavailable when no resident |
| Reopen while runner alive | resolver waits pid death; never a second session writer |

### Wrong vs Correct

```ts
// Wrong: branch the viewer on async vs foreground.
if (kind === "async") { /* different render path */ }

// Wrong: readline over the relay (splits on U+2028/U+2029).
readline.createInterface({ input: child.stdout });

// Wrong: forward with write() — it overwrites id, breaking correlation.
rpcWrite.write({ id: parentId, type: "prompt", ... });

// Correct: one channel abstraction, resolved once.
const channel = await resolveChildChannel(ctx, target, deps);
channel.write({ type: "prompt", message: text, streamingBehavior, images });
```

```ts
// Correct: the assembler receives the same raw records for foreground and
// async — byte-fidelity from a single source at a time.
channel.onStdoutLine((line) => assembler.addRpcLine(line));

// Correct: re-resolve on channel death keeps the conversation.
await channel.closed; const next = await resolveChildChannel(ctx, target, deps);
if (next) { switchChannel(next); } else { closeWithNotice(); }

// Correct: key routing follows the user's keymap.
if (!keybindings.actionForKey(data)) return undefined;
```

### Tests Required

- Unit: channel abstraction (write/id preservation, tail markers, heartbeat,
  closed semantics), assembler (role selection, pairing, streaming flattening,
  settings re-apply, fallbacks), child-keybindings (remap/remove matrix),
  child-key-route (consume gating, idle-Esc pass-through), resolve matrix
  (foreground resident/reopen, async boot race, terminal pid-death, no-session),
  runner bridge (relay framing/cap/markers, requests round-trip, operational
  commands allowlist, heartbeat expiry), reopen-swap guard.
- Integration: conversation-bridge-roundtrip (real runner + mock child:
  prompt → relayed response, heartbeat, child_closed).
