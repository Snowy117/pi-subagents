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
