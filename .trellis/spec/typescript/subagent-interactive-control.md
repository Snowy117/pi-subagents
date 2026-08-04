# Interactive Subagent Control Contracts

> Load-bearing contracts across `/subagents`, host-editor child chat, persistent RPC children, bridge/reopen routing, detached execution, waiting, and completion delivery.

## 1. Scope

Apply this specification whenever code changes:

- `/subagents` registration, picker entry, or child-view exit;
- host-editor/native child transcript rendering;
- parent-to-child semantic control;
- persistent child process/session ownership;
- foreground-resident, detached, bridge, or reopen channel selection;
- active-run lifecycle, integrated waiting, or completion notification ownership;
- temporary live-transcript retention and cleanup.

The parent Pi session remains authoritative. A headless child is never treated as a literal nested TUI, and the parent never writes the child's session file.

## 2. Package entry surface

### Slash/resources

- `/subagents` is the only package-provided slash command.
- `/subagents exit` and `/subagents close` leave the child view through the shared teardown.
- The package publishes no prompt templates and sets `pi.prompts` to `[]` so Pi does not convention-load a package-root `prompts/` directory.
- User, project, and third-party commands/prompts are unaffected.

### Picker entry

There is no default picker key. In particular, Down arrow is never consumed by this package unless the user explicitly maps it.

The optional package-owned keybinding is read from `<agentDir>/keybindings.json`:

```json
{
  "subagents.openPicker": ["ctrl+down", "alt+s"]
}
```

Contract:

- accepted: one valid Pi `KeyId` string, an array containing only valid `KeyId` strings, or `[]`;
- absent or invalid value: no binding;
- a mixed valid/invalid array is invalid as a whole;
- valid duplicates are removed;
- no default and no fallback key;
- one read when the extension runtime is constructed; Pi `/reload` reconstructs and rereads;
- raw terminal matching uses `matchesKey` after strict grammar validation;
- no promise of host conflict reporting, `/hotkeys` display, migrations, or leader-key prototype behavior.

The picker handler consumes only when all gates pass:

1. UI context exists;
2. editor text is empty;
3. a selectable child target exists;
4. this package has no picker/degraded modal open;
5. the terminal input matches one configured picker key.

All other input returns unchanged.

## 3. Shared child-view exit

One idempotent teardown operation is used by:

- `/subagents exit` and `/subagents close`;
- the live canonical `app.exit` action while child mode/package modal is active and editor text is empty;
- raw submission of exact trimmed `/quit` or legacy `/exit` while editable host-editor child mode is active.

The teardown closes host-editor mode and any package modal through their normal close paths. Those paths remove widget/status state, dispose assembler/validators/subscriptions, release transcript/viewer leases, close viewer-side channels, and clear target/context references. It never exits the parent process.

### Canonical exit action

Resolve the global `getKeybindings()` singleton and call:

```ts
getKeybindings().matches(input, "app.exit")
```

Consume only when:

- host-editor mode or a package picker/degraded modal is active;
- `ctx.ui.getEditorText()` is empty;
- the live manager matches `app.exit`.

Non-empty editor input passes through so Pi retains normal delete-forward/editor behavior. Never hard-code Ctrl+D. The manager owns defaults, custom remaps, multiple keys, legacy migration, `[]` removal, live reload, and runtime patches.

### `/quit` and `/exit` submit adapter

Pi 0.83.0 handles `/quit` before normal extension input, so the package observes raw terminal submission:

```ts
getKeybindings().matches(input, "tui.input.submit")
```

Consume only when editable host-editor child mode is active and the exact trimmed editor text is `/quit` or `/exit`. Clear the editor before teardown so the parent cannot submit the stale text after mode closes.

Read-only package modals do not claim slash submission. Pi's double-Ctrl+C emergency exit remains host-owned and is never reimplemented.

### Terminal listener order

Registration order is load-bearing:

1. shared exit route (`app.exit`, then slash-submit adapter);
2. optional configured picker route;
3. child app-action route.

Each stage returns a consumed result only when its complete contract matches.

## 4. Host-editor native conversation

The normal interactive child surface keeps Pi's real editor mounted and focused. Do not install a replacement `CustomEditor`, call `switchSession()`, call `newSession()`, or open the child session through `SessionManager`.

### Render contract

The widget renders:

1. child status/header rows;
2. the assembler's complete rendered history;
3. blank padding only when the total output is shorter than `max(1, terminal.rows - chrome)`.

Never apply a moving-tail slice such as:

```ts
content.slice(-availableRows)
```

and never clamp the final widget output to viewport height. The TUI root receives every child row; its bottom-anchored viewport shows recent rows while terminal scrollback retains older child rows. No package PageUp/PageDown history model is added to the editable host-editor path.

The complete child transcript must not be contaminated with parent chat rows. Parent history may exist earlier in root scrollback, but the widget's history source contains child records only.

### History seeding

- Trusted persistent/live transcript files are read completely for host-editor seeding, incrementally where practical.
- No semantic line or byte cap is allowed on this complete-history path.
- Truncation, replacement, partial final line, malformed JSONL, and trusted-root escape are handled safely.
- A complete trusted output/session fallback is read without the old arbitrary 80-line cap.
- If the only source is inherently bounded `recentOutput`, seed what exists.
- The degraded read-only fleet/transcript preview may retain its separate bounded-preview contract.

### Native behavior

The child assembler uses Pi's exported native components and main-view role selection:

- user messages → native user component;
- assistant messages/streaming → native assistant component;
- tool calls/results paired by `toolCallId` → native tool execution component;
- custom messages → registered renderer when available, labeled generic fallback otherwise;
- bash executions → native bash component.

Viewer settings are reapplied from `<agentDir>/settings.json` plus `<cwd>/.pi/settings.json` (project wins), including thinking visibility, output padding, images, image width, code indentation, hidden-thinking label, and host tool-expansion state.

The widget factory captures the real `TUI`. Every live RPC line ends with `tui.requestRender()` through a lazy adapter. Never cast `ExtensionUIContext` to `TUI`; it does not implement `requestRender()`.

### Host editor input

While child mode is active:

- ordinary submitted text routes as a child RPC `prompt`, preserving `streamingBehavior` and images;
- `!bash` and a single `/` remain parent-owned;
- `//name args` validates against child commands, then sends `/name args` only when supported;
- unknown `//name` does not become a child LLM prompt;
- a normal `/name` is parent-owned so Pi/third-party slash routing remains intact;
- channel activity refreshes `lastActivityAt`.

The real editor preserves autocomplete, multiline editing, paste, image handling, slash routing, custom keybindings, and extension editor wrappers.

## 5. Child app-action routing

The child action router resolves effective actions through the global keybinding manager, not handwritten key loops. This preserves user remaps/removals, legacy migrations, and leader-key manager patches.

Routing rules:

- interrupt is checked before other child app actions;
- Escape/interrupt sends child `abort` only while the child is streaming, otherwise passes through;
- thinking cycle, model cycle/select, tool expansion, and thinking visibility operate on child/view state while child mode is active;
- editing-level keys are never intercepted;
- action feedback updates the child status/renderer through the current channel and real TUI.

The package-owned picker binding is the sole exception because `subagents.openPicker` is unknown to Pi's runtime action table and therefore requires strict raw matching.

## 6. Semantic control channel

### Signatures

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

### Request/response schemas

```ts
interface ChildControlActionRequest {
  version: 1;
  type: "action";
  id: string;
  ts: number;
  action: string;
  payload?: unknown;
  source?: string;
}

interface ChildControlActionResponse {
  version: 1;
  type: "action_response";
  requestId: string;
  ts: number;
  status: "applied" | "rejected";
  action: string;
  result?: unknown;
  error?: string;
}
```

Requests require non-empty unique IDs/actions and finite non-negative timestamps. Applied responses may contain `result` but no `error`; rejected responses require `error` and contain no `result`. Extra schema keys or invariant violations are rejected.

Directory contract:

```text
<run>/control/
├─ steer-targets/<index>/
└─ action-targets/<index>/
   ├─ requests/
   └─ responses/
```

- `PI_SUBAGENT_STEER_INBOX` points to the steer inbox.
- `PI_SUBAGENT_ACTION_CONTROL_DIR` points to the action target directory.
- Never write action files into the steer inbox.
- Writes are atomic; consumers atomically claim before parsing/applying.
- Replayed request IDs preserve one authoritative response and never reapply non-idempotent actions.

`cycleThinking` derives supported levels from the child model and compatibility layer, uses public `getThinkingLevel()`/`setThinkingLevel()`, and returns the actual post-set level. Missing/non-reasoning models, invalid payload, unknown action, or exception produce one useful rejected response.

## 7. Persistent RPC child contract

Every execution child is a persistent Pi RPC process:

```ts
buildPiArgs({ mode: "rpc" }); // --mode rpc, no -p, no positional task, no @file
```

`PI_SUBAGENT_E2E_JSON_CHILD=1` is a test-only escape hatch. The legacy `persistentChildren` config is a no-op.

### Framing and prompt delivery

- RPC is strict LF-only JSONL; never use Node `readline` because it splits U+2028/U+2029.
- One record is capped at 16 MiB; an oversized record is dropped with an empty-line placeholder behavior defined by the protocol helper.
- A false `stdin.write()` means the chunk was accepted into the stream buffer; queue only subsequent records until one persistent `drain` listener flushes.
- Every `runSingleAttempt` attaches RPC transport and sends the initial `prompt` over stdin after spawn, regardless of registry presence.
- Prompt delivery is never gated on child retention/registry registration.
- Immediately after queuing the initial prompt, publish a running partial update so the native parent tool component renders before first child output.

### Completion and retention

- `agent_settled` is logical task completion; the process may remain resident for conversation.
- Successful registered children remain resident.
- Unregistered successful children close gracefully after finalization.
- Failed/timeout/budget/interrupt children are unregistered and closed; they have no safe conversational future.
- Graceful close: cancel dialogs → stdin EOF (session persist) → bounded grace → SIGTERM → SIGKILL.
- Force close skips EOF.
- Spawned/piped processes use post-exit stdio guards and guarded signals.

### Registry invariants

```ts
createRpcChildRegistry(): RpcChildRegistry;
```

- one entry per child key;
- callers check `has()` before register/reopen to preserve one writer;
- re-register replaces the handle only through the explicit registry contract;
- idle/overflow eviction touches settled children only and skips the actively viewed key;
- every routed child input refreshes activity;
- session shutdown closes retained children gracefully.

## 8. Unified `ChildConversationChannel`

The viewer knows only:

```ts
interface ChildConversationChannel {
  readonly key: string;
  write(record: RpcOutgoingRecord): void;
  onStdoutLine(cb: (line: string) => void): () => void;
  readonly settled: boolean;
  readonly closed: Promise<void>;
  lastActivityAt: number;
  touch(): void;
  close(kind: "graceful" | "force"): Promise<void>;
  readonly exitCode?: number;
}
```

Kinds:

- foreground resident/reopened child → `LocalRpcChannel`;
- running detached child → `AsyncBridgeChannel`;
- terminal detached child with session → wait for runner death, reopen, then `LocalRpcChannel`.

`resolveChildChannel(target)` is the only foreground/detached branch point. Viewer, assembler, input routing, and key routing remain transport-agnostic.

When the active channel closes, host-editor mode re-resolves while retaining the same accumulated assembler. A successful replacement swaps subscriptions and heartbeat; failure closes child mode with a clear notice. A rate guard prevents reopen loops.

The parent reopens a detached child's session only after confirming the runner PID is dead (bounded wait, ESRCH authority). Never create a second session writer while the runner owns the child.

## 9. Detached conversation bridge

Per-child bridge files live under:

```text
<asyncDir>/conversation/<stepKey>.requests.jsonl
<asyncDir>/conversation/<stepKey>.stdout.jsonl
<asyncDir>/conversation/<stepKey>.active
```

`stepKey` is derived identically on parent and runner sides from sanitized step index and agent.

### Requests

- Forward allowed prompt/get_commands/abort/model/thinking records verbatim through `writeLine` so caller IDs are preserved.
- Do not use a helper that overwrites the request ID.
- `ping` is answered locally with a relay marker.
- Viewer-hostile session mutation records (`new_session`, `switch_session`, `fork`, `clone`) are not forwardable.
- Unknown request types are ignored safely.

### Stdout relay

- Mirror every raw child stdout line and synthetic lifecycle markers (`child_ready`, `child_settled`, `child_closed`, `child_unavailable`, `pong`, `relay_reset`).
- Parent tailing uses a byte cursor and LF-only framing.
- Pre-seeded history is not redelivered.
- Relay cap/truncate emits `relay_reset`; the viewer resyncs from new EOF without duplicating the preserved conversation.

### Heartbeat/lifecycle

- Parent rewrites `<stepKey>.active` roughly every five seconds while viewing.
- Runner treats heartbeats fresh for 30 seconds.
- Freshly viewed children are excluded from runner idle/cap eviction.
- At finalization, the runner may linger up to ten minutes for active conversation, then closes children gracefully.
- Parent clears heartbeats on view close, target switch, and session shutdown.

## 10. Live transcript lifecycle

```ts
resolveLiveTranscriptPath(input: {
  persistentPath?: string;
  runId: string;
  index: number;
}): string;

retainLiveTranscript(path?: string, deps?: LiveTranscriptDeps): () => void;
markLiveTranscriptTerminal(path?: string, deps?: LiveTranscriptDeps): void;
```

- Persistent artifacts use their configured path.
- Otherwise use `<TEMP_ROOT_DIR>/live-transcripts/<runId>/<index>.jsonl`.
- A view acquires a lease before reading and releases it on every close/error/dispose path.
- Terminal cleanup deletes a temporary transcript only after true child termination and zero leases.
- A detached launch receipt is not termination.
- One parent session never recursively deletes the global live-transcript root.
- Non-`ENOENT` lease read failures preserve the transcript.
- Transcript rows represent finalized message/tool events, not token deltas.

## 11. Unified detached execution lifecycle

After count expansion:

```text
one concrete invocation  -> single -> executeAsyncSingle
multiple invocations     -> parallel -> executeAsyncChain
```

One canonical mode and one generated run ID flow through spawn reservation, runner config, nested metadata, start event, persisted status, tracker/widget, and final details.

All public calls launch detached:

- caller detach policy true → launch receipt;
- caller detach policy false/default → claim sync ownership, launch, exact-run integrated wait, rich completion conversion.

Every successful launcher emits its start event immediately after successful spawn and before returning. A chain/parallel start includes lifecycle version, run ID, PID, current session ID, canonical mode, cwd, async directory, flattened agents, parallel/workflow metadata, nested route, and applicable budgets/deadline. Failed launch emits no start event.

The tracker is the sole active-run indicator owner. Start inserts the queued job and mounts the editor-top widget immediately; polling updates running/activity/attention/terminal state; completion retention and removal follow tracker policy. Sync launch-plus-wait uses the same indicator and remains visible if attention/abort returns before terminal completion.

## 12. Integrated wait

Public shape:

```ts
subagent({ action: "wait", id?, all? })
```

Algorithm:

1. list active runs owned by the current session and authorized lifecycle root;
2. resolve exact ID before unique prefix;
3. snapshot target IDs;
4. subscribe to completion/control/supervisor events;
5. reconcile persistent status after subscribing;
6. keep a poll fallback for missed events;
7. return when the predicate matches.

Predicates:

- no ID/default: first snapshotted terminal or actionable attention;
- no ID/`all:true`: all snapshotted terminal unless attention intervenes;
- ID: resolved target terminal or actionable attention;
- no active match: immediate result;
- terminal: complete, failed, or paused;
- actionable: `needs_attention`, pending `need_decision`, or pending `interview_request` scoped to target IDs;
- non-actionable: `active_long_running`, ordinary control progress, or `progress_update`.

There is no elapsed orchestration timeout. AbortSignal ends only the tool call and leaves the runner alive. Runner-level deadline/budget failure remains a normal terminal completion.

Root wait sees top-level run/result roots. A fanout child sees only `<TEMP_ROOT_DIR>/nested-subagent-runs/<rootRunId>` and `RESULTS_DIR/nested/<rootRunId>`. If no authorized root can be resolved, return a clear unavailable management result instead of broadening visibility.

## 13. Completion broker and notification ownership

The broker is session-scoped, bounded, and TTL-pruned. It stores:

- normalized rich completions by exact run ID;
- sync ownership by exact run/session with canonical mode and concrete task descriptors;
- exact-run waiters.

Result watcher ordering is load-bearing:

1. parse and validate owning session;
2. normalize nested/child rich result data;
3. cache in the broker;
4. deliver result intercom when configured;
5. emit completion;
6. release sync ownership after synchronous completion listeners observe it;
7. unlink the result file.

This prevents both lost fast completions and duplicate sync completion turns. `registerSubagentNotify` suppresses `triggerTurn:true` only while that run is sync-owned. A general observer wait never owns the result and never suppresses independently detached completion notification.

Sync terminal conversion returns full normal `AgentToolResult<Details>` content and metadata. Missing legacy per-child usage becomes explicit zero usage, never aggregate-derived estimates.

Attention, abort, launch failure, session reset, TTL expiry, and dispose release ownership without interrupting the detached process. Completion cache lifetime is independent so a late exact waiter can still recover a fast result.

## 14. Error and validation matrix

| Case | Required behavior |
| --- | --- |
| Invalid picker JSON/value/member | No binding; do not consume ordinary input; report safely once where UI is available |
| Child inactive or editor non-empty on `app.exit` | Pass through |
| `/quit` or `/exit` outside editable child mode | Pass through to host |
| Double-Ctrl+C | Host owns it |
| Transcript path escapes trusted roots | Refuse and use safe fallback/error state |
| Transcript truncates/replaces/has malformed or partial line | Reset/buffer/skip safely; continue polling |
| RPC line exceeds cap | Drop through protocol's bounded behavior; do not crash host |
| Child crashes while active | Re-resolve channel; reopen when safe, otherwise close mode and restore parent input |
| Reopen while runner alive | Wait boundedly; never create second session writer |
| Bridge relay truncates | `relay_reset`, resync, no preserved-history duplication |
| Control consumers race | Atomic claim permits at most one application |
| Response persistence temporarily fails after action | Retry/preserve response; never reapply action |
| Wait ID prefix is ambiguous | Clear error; do not select arbitrarily |
| Wait aborts | Tool returns; detached run stays alive |
| Completion happens before wait subscription/file unlink | Broker cache returns full normalized result |
| Sync-owned completion | No duplicate automatic completion turn |
| Ordinary detached completion | Normal notification remains enabled |
| One/count:1 launch | `single` everywhere; never `parallel` |

## 15. Required tests

### Unit

- strict picker parsing: absent/string/array/`[]`, dedupe, invalid member/shape/file, key grammar;
- exit matrix: default/remap/remove/multiple/legacy, empty/non-empty, submit remap, `/quit`, `/exit`, inactive/modal states;
- complete widget history, short padding, resize/invalidate stability, no tail slicing;
- transcript partial/truncate/replace/malformed/trusted-root/fallback behavior;
- native assembler role selection, tool pairing, streaming, settings reapply, generic fallbacks;
- host editor routing and child app-key remap/remove behavior;
- strict action request/response parsing, claim race, replay, response retry;
- RPC LF framing, fragmentation, record cap, backpressure; registry eviction/one-writer/graceful close;
- bridge request ID preservation, relay markers/cap, heartbeat expiry;
- integrated wait snapshot/exact-prefix/all/attention/supervisor/abort/no-timeout behavior;
- completion broker size/TTL/session/dispose/fast cache and rich conversion;
- notification suppression only for sync ownership;
- canonical mode and call-label rendering.

### Integration

- exact package slash registration equals `['subagents']` and no package prompts;
- picker to host-editor activation and shared exit teardown;
- enough parent/child history to prove complete child-only root contribution;
- foreground resident, running bridge, terminal reopen, no-session degraded matrix;
- real runner bridge prompt/response/heartbeat/close round trip;
- single and parallel launch start events feed tracker/widget before result;
- rich result watcher caches before delayed intercom/event/unlink;
- synchronous single/parallel completion, failure/paused/attention/abort-run-survival;
- persistent RPC prompt-over-stdin, initial running update, settle/retention/close;
- current-session and authorized-nested-root wait scoping.

### E2E

Use the faux provider only:

- detached launch-plus-wait returns the full result;
- child conversation consumes prompt/control and retains finalized transcript;
- no real API key or external provider call.

## 16. Wrong vs correct

Wrong:

```ts
if (matchesKey(input, "ctrl+d")) process.exit(0);
return content.slice(-availableRows);
await wait({ timeoutMs: 1_800_000 });
SessionManager.open(childSessionFile).appendMessage(message);
if (registry) attachRpcProtocol(child).write.write({ type: "prompt", message: task });
```

Correct:

```ts
if (getKeybindings().matches(input, "app.exit") && editorText === "") {
  await exitSubagentView(ctx);
  return { consume: true };
}

return content.length < minimumRows
  ? [...content, ...Array(minimumRows - content.length).fill("")]
  : content;

await subagent({ action: "wait", id: runId });

const rpc = attachRpcProtocol(child);
registry?.register(resident);
rpc.write.write({ type: "prompt", message: task });
state.fireUpdate();
```

## 17. TUI render frequency contract

Pi's `requestRender()` renders the whole component tree and diffs output lines.
Cached tree renders are cheap (~0.05 ms), but **invalidated renders (markdown
re-parse) cost ~100 ms per 150 messages**, and a tool result's
`context.invalidate()` both rebuilds the result component and triggers a full
`requestRender()`. While subagents run, the extension must not drive the TUI
render loop at high frequency with per-frame work that grows with the child
transcript.

### Rules (all render drivers)

- **No O(child transcript) work per frame.** While a result is running, never
  call `getFinalOutput` / `getSingleResultOutput` in the render path — the
  running compact view does not display that output (it is only needed for the
  completed view). Lazy-compute it for non-running rows only.
- **Per-event snapshots omit `messages`.** `snapshotResult(result, progress,
  includeMessages = true)` — `emitUpdateSnapshot` (per child event) passes
  `false`; final snapshots (`finalizeSingleAttempt`, `onDetachedExit`) keep the
  default. The final result contract is unchanged.
- **Throttle render drivers.** Foreground spinner animation interval ≤ 200 ms
  (not 80 ms — a 12.5 fps full re-render loop for the whole run). Async job
  poller uses tracker-local `JOB_TRACKER_POLL_INTERVAL_MS = 500` — deliberately
  NOT the shared `POLL_INTERVAL_MS` (250 ms) used by the runner's control
  channel. Widget re-renders are throttled to ≥ 500 ms except terminal
  transitions and job-set changes.
- **Throttled rebuilds need a sticky dirty flag.** A per-tick
  changed-compare loses an update that was blocked by the throttle (the next
  tick sees no delta and never renders). Accumulate `pendingWidgetChange`
  outside the tick and clear it only when a render actually happens.
- **Version-change-or-throttle rebuild.** Scrollback child views rebuild on a
  snapshot version change (real data change) and at most ~1/500 ms while
  running (live duration labels); completed views rebuild on version change
  only. Use an injectable `now`/`rebuild` so unit tests can verify the cadence.
- **Skip idle renders.** Poll-driven views (steer view) must not call
  `requestRender()` when nothing changed (no new records, no pending action
  responses, no header/notice change).

**Language**: All documentation is written in English.
