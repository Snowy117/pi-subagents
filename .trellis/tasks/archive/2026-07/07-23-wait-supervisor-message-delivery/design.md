# Design: supervisor attention during wait

## Architecture boundary

Keep supervisor-request lifecycle in the native supervisor channel. The wait
tool receives only a read-only capability that lists currently actionable
requests; it does not own request files, replies, or cleanup.

The existing event remains the low-latency notification mechanism. Persistent
query state is the source of truth. This deliberately mirrors the existing
event-plus-poll reconciliation pattern used by async completion without
conflating supervisor attention with async activity state.

## Request transport contract

Extend `SupervisorRequest` with an optional discriminator:

```ts
replyTransport?: "pi-intercom";
```

Absence means the native pi-subagents request/reply flow. This is additive and
keeps older native writers readable.

### Native request

1. Child writes a request file.
2. Parent channel records it, sends `subagent_supervisor_request`, and emits
   `INTERCOM_DETACH_REQUEST_EVENT` when it expects a reply.
3. The read-only query exposes it to `wait`.
4. `subagent_supervisor({ action: "reply" })` writes the reply file and removes
   the request.

### pi-intercom receipt

1. Pi-intercom successfully delivers the authoritative broker ask.
2. Pi-intercom writes a blocking native receipt with the broker message ID and
   `replyTransport: "pi-intercom"`.
3. The pi-subagents parent records it and emits the same detach/wake event, but
   suppresses a second visible native message.
4. The request is excluded from native `pending/list/reply` tool actions so the
   parent cannot write an ineffective native reply.
5. The wait query still exposes route metadata and transport, allowing `wait`
   to report that a broker supervisor ask needs attention.
6. Pi-intercom's queued broker message supplies the full content and the
   `intercom({ action: "reply" })` instruction on the next model call.
7. Pi-intercom removes the receipt when the broker ask settles. The next query
   refresh prunes it from the channel map.

No broker protocol field changes in this task. The discriminator exists only in
the native side-channel file.

## Read-only supervisor attention source

`createNativeSupervisorChannel` exposes a callback rather than its mutable map.
The callback:

- refreshes pending lifecycle against current state/context;
- returns immutable summaries needed by wait (`id`, `runId`, `agent`,
  `childIndex`, `reason`, and `replyTransport`);
- includes only requests that expect a reply;
- never writes replies or lets callers mutate channel state.

The channel's parent tools continue using the private map, but filter out
`replyTransport: "pi-intercom"` for native list, resolution, and status counts.
The callback is injected from `src/extension/index.ts` through
`registerSubagentTools` into `WaitDeps`.

## Wait algorithm

After resolving an optional ID prefix, `waitForSubagents` captures the exact
initial run IDs as it does today.

An actionable request is one returned by the source whose `runId` belongs to
that snapshot. It is independent of `all`: a blocked child always needs parent
action before waiting longer helps.

The loop follows a subscribe-then-reconcile discipline:

1. Query before the first sleep. Return immediately for a pre-existing request.
2. In the wake helper, subscribe to all wake channels including
   `INTERCOM_DETACH_REQUEST_EVENT`.
3. Immediately after subscriptions are installed, query the attention source.
   If actionable state exists, cancel the sleep and return from the helper.
4. On any event or poll wake, reload run status and query actionable requests.
5. Return if completion, generic attention, or supervisor attention satisfies
   the wait.

The query, not event payload, decides termination. This covers missed events,
request resolution races, and the check/subscription boundary.

The result names request ID, run, agent, and reason. Native requests direct the
parent to `subagent_supervisor`; pi-intercom receipts direct it to the queued
broker message and `intercom reply`. An unresolved request remains
level-triggered across later waits.

## Progress updates

`progress_update` has `expectsReply: false`, requires no decision, and must not
terminate wait. Native children retain their existing visible native progress
message. Pi-intercom stops writing a native progress mirror because the broker
already delivers it and the mirror contributes neither detach nor wake
behavior.

## Turn delivery

Do not add `triggerTurn: true` to `parent-channel.ts`.

- During an active wait, only returning the tool can advance the current turn.
- Default steer delivery then places the queued broker/native message before
  the next model call.
- When idle, pi-intercom already owns trigger behavior for broker messages.
- A second native trigger would create duplicate or empty turns.

Idle native-only wake behavior is unchanged and outside this task.

## Pi-intercom receipt lifecycle

Refactor `writeNativeSupervisorRequest` to return the created request path or
`undefined`. Add a best-effort remover for that exact path.

For blocking asks:

1. Register the broker reply waiter.
2. Send the broker message.
3. If delivery fails, reject the waiter and return without creating a receipt.
4. After successful delivery, create the native receipt.
5. Await the broker reply.
6. In `finally`, remove the receipt if one was created.

The `finally` path covers successful reply, cancellation, timeout, disconnect,
and shutdown-driven waiter rejection. File cleanup failure must not replace the
broker result. The parent channel will eventually expire or inactivate an
unremovable receipt.

## Mode behavior

The wait source and predicate do not inspect `ctx.hasUI`, so native-only
requests work in TUI, RPC, JSON, and print hosts.

With pi-intercom co-installed, TUI/RPC retain broker steer/trigger delivery and
support a human/model reply. Busy JSON/print sessions currently auto-reply and
drop inbound broker asks; that policy is unchanged, and the short-lived receipt
may disappear before native discovery. This is an explicit compatibility
boundary, not a claim of end-to-end no-UI reply support.

## Test design

### pi-subagents unit coverage

Use a new focused wait-supervisor test file instead of extending the existing
near-500-line `wait.test.ts`. Inject a fake event bus, sleep, attention source,
and deterministic run state. Cover:

- request pending before wait;
- request arriving after event subscription with a long poll fallback;
- request inserted during the first check/subscription boundary;
- unrelated and later-launched runs;
- non-blocking progress exclusion;
- request removed before post-wake reconciliation;
- level-triggered repeat waits until resolution.

Add focused channel tests for lifecycle-refreshed immutable summaries, native
versus pi-intercom tool visibility, duplicate-message suppression, event
emission, and receipt-file removal pruning.

### pi-subagents integration coverage

Add a cross-protocol live-wait test using a real temporary channel/file,
shared fake event bus, long wait poll interval, and delayed receipt. Assert
prompt return and exactly one authoritative visible message for native and
pi-intercom transport variants. Keep the existing foreground-detach test as a
separate discriminator for the previously fixed bug.

### pi-intercom coverage

Before any bridge test, isolate the channel directory and orchestrator session
environment. Test:

- no receipt before broker delivery success;
- expected additive schema and atomic file creation after success;
- removal after reply and all waiter rejection paths;
- no progress receipt;
- ambient live bridge variables are cleared/restored.

## Compatibility and migration

- Schema change is additive; older pi-subagents treats a new receipt as a
  normal request only if it does not understand the discriminator, preserving
  detach at the cost of duplicate messaging during mixed-version rollout.
- New pi-subagents continues to accept old files without the discriminator as
  native requests.
- Broker wire format and pi-intercom reply tracking do not change.
- Both repositories should be released together to obtain duplicate
  suppression and lifecycle cleanup.

## Rollback

The changes are separable by repository but the new behavior is coordinated.

- Reverting pi-subagents restores old wait behavior but pi-intercom broker asks
  still function and foreground detach remains available.
- Reverting pi-intercom retains wait support for native requests; old
  broker-origin files are treated as native and may duplicate messages or
  remain pending until existing lifecycle cleanup.
- No persisted migration is required. Removing stale request files from temp
  storage restores the pre-change state.

