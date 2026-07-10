# Design — foreground intercom wait/notify (D1, co-existence)

## Decision

- **D1**: detach must fire regardless of which extension's `contact_supervisor` /
  `intercom` tool handles the child's call.
- **Co-existence**: pi-intercom (general cross-session messaging + broker + UI)
  and pi-subagents (native supervisor channel + detach) stay installed together.
- **Cross-repo changes to pi-intercom are allowed** (both projects maintained by
  the same author). This unlocks a cleaner D1 variant than a pi-subagents-only
  fix.

## Root-cause mechanism (precise)

The native `contact_supervisor` loses to pi-intercom not by load-order luck, but
by a guard:

- pi-intercom registers `contact_supervisor` **at module-load** (top-level
  `if (childOrchestratorMetadata) pi.registerTool(...)`).
- pi-subagents registers its native client **lazily**, on `session_start`, via
  `registerNativeSupervisorClientOnce` → `registerNativeSupervisorClient`.
- `registerNativeSupervisorClient` guards with `if (!hasTool(pi,
  "contact_supervisor"))` before registering. By the time `session_start` fires,
  pi-intercom's tool already exists, so the guard is true and pi-subagents
  **silently skips** registration.

Net: the child's `contact_supervisor` is always pi-intercom's (broker path, no
file, no `INTERCOM_DETACH_REQUEST_EVENT`). The parent's supervisor-channel
`poll()` finds nothing → no detach → foreground `runSync` stays blocked.

## Design — the cross-protocol handshake (D1b, recommended)

Keep pi-intercom's broker transport intact (general messaging, UI, liveness).
Add a **side-channel supervisor-channel file write** so pi-subagents' existing
parent poller detects the request and fires detach — without pi-subagents
needing to know which tool handled the child's call.

### Child side (pi-intercom repo)

In pi-intercom's `contact_supervisor` (and `intercom ask`, for subagent
contexts) execute, **also** write a native supervisor request file when the
child is a subagent:

- Read `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR` (already set by pi-subagents'
  `pi-args.ts` when the intercom bridge is active — no new env needed).
- Read `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID`, `PI_SUBAGENT_RUN_ID`,
  `PI_SUBAGENT_CHILD_AGENT`, `PI_SUBAGENT_CHILD_INDEX`,
  `PI_SUBAGENT_INTERCOM_SESSION_NAME` (all already set).
- Write a `SupervisorRequest` JSON to `<channelDir>/requests/<requestId>.json`
  using the **same schema** pi-subagents' parent poller parses
  (`type:"subagent.supervisor.request"`, `id`, `createdAt`, `reason`,
  `message`, `expectsReply`, `orchestratorSessionId`, `runId`, `agent`,
  `childIndex`, optional `childTarget`/`interview`/`expiresAt`).
  - Use the broker message id as `requestId` (or a fresh UUID) so a later
    native reply file can be correlated.
- The child still blocks on the **broker** `waitForReply` (pi-intercom's
  existing path) for the actual supervisor answer. The file is purely a
  detach-trigger + receipt channel; it does not replace broker delivery.

> Implementation note: pi-intercom can depend on a tiny shared contract
> module for the request schema + `writeAtomicJson` + paths, or vendor a
> minimal copy (the schema is ~15 fields). Cross-repo coupling is limited to
> "write a JSON file with these fields to this dir" — stable and small.

### Parent side (pi-subagents repo) — no change needed for detection

The existing `createNativeSupervisorChannel` `poll()` already:
- discovers request files in `SUPERVISOR_CHANNEL_ROOT/<channel>/requests/`,
- checks `requestMatchesContext` (`orchestratorSessionId === currentSessionId`),
- on `expectsReply`, calls `pi.sendMessage(subagent_supervisor_request, …)` and
  emits `INTERCOM_DETACH_REQUEST_EVENT` → `detachForIntercom()`.

So once pi-intercom writes the file, **detach fires automatically**. This is
why D1b is the cleanest: it reuses the entire existing native detach pipeline.

### Reply path — the one nuance to resolve

After detach, the parent has two ways to reply, and they must agree:

1. **pi-intercom's `intercom` tool (`action:"reply"`)** — routes through the
   broker back to the child's `waitForReply`. This is the reply the child is
   actually blocking on.
2. **pi-subagents' native `intercom` tool (`action:"reply"`)** — writes a reply
   file the child's native `waitForReply` would read. But the child (using
   pi-intercom's tool) is **not** polling the reply file; it's blocked on the
   broker.

So the parent must reply via **pi-intercom's** `intercom reply` to unblock the
child. The detach message already directs the parent to "Reply to the supervisor
request first" and the surfaced `subagent_supervisor_request` message carries a
reply hint — we should make that hint point at whichever reply tool is active.
For the broker path, pi-intercom already prints
`Reply: intercom({ action: "reply", message: "..." })` in its incoming message,
so the parent is naturally guided to the right tool.

**Risk to flag for the user (design.md, not blocking):** if the parent replies
via the *native* `intercom` reply tool, the child (on the broker path) never
sees it and stays blocked until the 10-min ask timeout. Mitigation options:
- (a) Document that co-install requires replying via pi-intercom's intercom tool
  (acceptable; the surfaced message already hints it).
- (b) Have pi-subagents' native reply tool, when the request was broker-origin
  (detectable: the child's tool was pi-intercom's), forward the reply over the
  broker too. (More work; defer unless the UX bites.)

## Test plan

### Reproduction / regression test (in pi-subagents test suite)

A test that fails on current code, passes after fix:

1. Simulate the conflict: register a "shadow" `contact_supervisor` tool (as
   pi-intercom would) that does **not** write the supervisor-channel file, then
   run a foreground child through the executor harness that calls
   `contact_supervisor`.
   - On current code: assert **no** `INTERCOM_DETACH_REQUEST_EVENT` fires and
     the foreground stays blocked (with a short timeout → failure).
2. Add the cross-protocol handshake: have the shadow tool **also** write the
   native request file (mirroring the pi-intercom change).
   - Assert: the parent poll discovers the file → emits
     `INTERCOM_DETACH_REQUEST_EVENT` → `runSync` resolves `detached=true`.
3. After detach, simulate a reply + child exit → assert
   `notifyForegroundDetachedCompletion` fires `SUBAGENT_ASYNC_COMPLETE_EVENT`
   and `wait` resolves (the existing `foreground-detached-notify.test.ts` +
   `wait.test.ts` already cover the second half; extend them if needed).

This test discriminates the conflict (broker path without the file write) from
the pure in-process native path (which the existing
`single-execution-detach.test.ts` covers by emitting the event directly).

### Existing tests to keep green

- `test/unit/native-supervisor-channel.test.ts` (poll + request lifecycle)
- `test/integration/single-execution-detach.test.ts` (in-process detach)
- `test/unit/foreground-detached-notify.test.ts` + `test/unit/notify.test.ts`
- `test/unit/wait.test.ts`

## Cross-repo change summary

- **pi-intercom** (`index.ts`, `contact_supervisor` + `intercom ask`): when
  `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR` is set, also write a native
  `SupervisorRequest` file to that channel dir. No change to broker delivery or
  UI.
- **pi-subagents**: no behavioral code change required for the core fix (the
  parent poller already handles the file). Tests + docs only. (The native
  `contact_supervisor` losing the `hasTool` race is **fine** under D1b — we
  don't need our tool to win; we need pi-intercom's tool to write the file.)

## Trade-offs vs D1a (pi-subagents-only, observe tool-use)

- D1b (cross-repo) reuses the **entire** existing native detach pipeline; no new
  event-subscription plumbing or pi-intercom message-format parsing on the
  parent. Smaller, more robust surface.
- D1a would require pi-subagents to detect "child used an intercom tool" +
  correlate an incoming `intercom_message` to a run + emit detach — and would
  still need the reply to route over the broker. More moving parts, parent-side
  coupling to pi-intercom's message shape.
- D1b's cost: one cross-repo dependency on a small, stable file schema (already
  owned by this author). Acceptable and cleaner.

## Out of scope (restated)

- `resume`/revive of detached foreground children (throws by design).
- Changing the broker protocol or the native channel filesystem protocol
  themselves (only the cross-protocol handshake is in scope).
- The async/background detach path.
