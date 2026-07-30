# Cross-Extension Integration Contracts

> Contracts for co-existing with sibling pi extensions (pi-intercom, etc.).
> These are **load-bearing integration invariants** — violating them reintroduces
> the foreground-detach deadlock (task `07-10-foreground-intercom-wait-bug`).

---

## pi-subagents ↔ pi-intercom co-existence

Both extensions are commonly co-installed. They serve distinct purposes:

- **pi-intercom**: general cross-session messaging (any pi session ↔ any pi
  session) via a socket broker; UI session list / compose / presence; liveness.
- **pi-subagents**: subagent↔supervisor coordination **and** the only thing that
  fires foreground **detach** (freeing the orchestrator's blocked `runSync`).

### The tool-name collision

Both register a tool named `contact_supervisor` in child processes. The native
client (`src/intercom/native-supervisor-channel/child-client.ts`) registers
**lazily** on `session_start` and guards with `if (!hasTool(pi, ...))`.
pi-intercom registers at **module-load**. So in co-install, **pi-intercom's
broker-based `contact_supervisor` always wins** — the native client silently
skips. This is **expected and fine**; do not try to "win" the name.

### The cross-protocol handshake (the contract that makes detach fire)

Because the child's `contact_supervisor` is pi-intercom's (broker path, no file),
the parent's filesystem poller (`createNativeSupervisorChannel`) would find
nothing → no detach → orchestrator stays blocked forever.

**Contract**: pi-intercom's child-only `contact_supervisor` **additionally
writes a native `SupervisorRequest` file** to
`PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR/requests/<id>.json` whenever that env is set.
The file uses the exact schema in
`src/intercom/native-supervisor-channel/types.ts` (`type`,
`id`, `createdAt`, `reason`, `message`, `expectsReply`, `orchestratorSessionId`,
`runId`, `agent`, `childIndex`, optional `expiresAt`/`childTarget`/`interview`,
and optional `replyTransport: "pi-intercom"`).
The parent poller then discovers the file → emits
`INTERCOM_DETACH_REQUEST_EVENT` → foreground detach or an active `wait` wake.

The file write is **best-effort** and occurs only after broker delivery succeeds:
a failure must never break the broker send. The broker remains the authoritative
transport for delivery/reply. Pi-intercom removes the exact blocking receipt
when the broker ask resolves, fails, is cancelled, times out, disconnects, or
the child shuts down. Progress updates do not write receipts.

The pi-subagents parent records a broker receipt and emits the existing detach /
wait wake event, but suppresses a duplicate native visible message and excludes
the receipt from native `pending`, `list`, `status`, and
`subagent_supervisor({ action: "reply" })` actions. The queued broker message
and `intercom({ action: "reply", ... })` are the only effective reply path.
Files without the discriminator remain native requests for compatibility.

### Reply path (the one asymmetry)

After detach, the orchestrator must reply via **pi-intercom's `intercom
{action:"reply"}`** (broker), **not** the native `intercom reply` (which writes a
reply file). The child is blocked on the broker's `waitForReply`, not polling
the native reply file. A native reply is silently lost → child blocks until the
10-min ask timeout.

**Mitigation in place**: pi-intercom's broker message directs the parent to
`intercom({ action: "reply", message: "..." })`; the side-channel receipt is
only a lifecycle-aware detach/wait signal and does not inject a second message.

**Deferred follow-up (option b)**: make the native `intercom reply` detect
broker-origin requests and forward over the broker too, so either reply tool
unblocks the child. Not implemented; tracked in the task's `implement.md`.

---

## Adding a new cross-extension contract

When a new sibling-extension interaction is introduced:

1. Name the contract here with the env / file / event schema it depends on.
2. Pin the schema in a `types.ts` (single source of truth both repos read).
3. Add a discriminator test under `test/integration/` that proves the contract
   end-to-end (see `foreground-detach-cross-protocol.test.ts` for the pattern).
4. Keep the coupling surface **minimal and stable** (a small JSON file schema
   beats a rich RPC).

### Wait and host-mode boundary

The native wait predicate is independent of `ctx.hasUI` and works in TUI, RPC,
JSON, and print hosts. Co-installed broker end-to-end replies are supported in
TUI/RPC. Pi-intercom's existing busy JSON/print auto-reply behavior remains
unchanged; a broker ask may resolve before its short-lived receipt is observed.

## Executable supervisor-receipt contract

### 1. Scope / trigger

This contract applies whenever pi-intercom's child-only
`contact_supervisor` runs with both `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR` and
`PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` set. The native file is a wake/detach
receipt, not a second message or a second reply transport.

### 2. Signatures

- Native channel exposes
  `getActionableRequests(): ReadonlyArray<SupervisorAttentionRequest>`.
- `SupervisorAttentionRequest` contains `id`, `runId`, `agent`, `childIndex`,
  `reason`, and optional `replyTransport: "pi-intercom"`.
- `SupervisorRequest.replyTransport` is optional so old native files remain
  valid.

### 3. Contracts: request, response, and environment

- A native request omits `replyTransport`; its visible message and
  `subagent_supervisor({ action: "reply" })` path remain authoritative.
- A pi-intercom receipt contains `replyTransport: "pi-intercom"`, is written
  only after broker delivery succeeds, and is removed when the broker ask
  settles.
- The parent records either request, but only a native request is included in
  native pending/list/status/reply actions. Both blocking request kinds enter
  the wait attention query; progress updates do not.
- The event `INTERCOM_DETACH_REQUEST_EVENT` is a wake hint. The lifecycle-
  refreshed query is the termination authority.

### 4. Validation and error matrix

| Condition | Required behavior |
|---|---|
| Missing bridge environment | Broker behavior is unchanged; no receipt is written. |
| Broker delivery fails | No receipt is written; the broker error is returned. |
| Receipt write or removal fails | Suppress the filesystem error; broker behavior remains authoritative. |
| Invalid `replyTransport` | Reject the request file as invalid. |
| Native reply against a broker receipt | Reject it as having no pending native request. |
| Broker ask resolves/cancels/expires/disconnects | Remove the exact receipt best-effort. |

### 5. Good, base, and bad cases

- **Good:** broker delivery succeeds, one broker message is visible, one native
  wake/detach event is emitted, `wait` returns, and `intercom reply` resolves
  the child while the receipt is removed.
- **Base:** an old file without the discriminator follows the native path.
- **Bad:** a broker receipt is sent through `pi.sendMessage` again or answered
  with a native reply file; either creates duplicate context or leaves the
  broker child waiting.

### 6. Tests required

- Unit: validate the discriminator, frozen lifecycle query, native action
  filtering, and receipt pruning.
- Integration: assert event-driven wait return with a long poll fallback,
  native-only `hasUI: false` behavior, and no duplicate broker receipt message.
- Pi-intercom integration: assert post-delivery creation, all blocking-ask
  cleanup paths, no progress receipt, and restoration of ambient bridge
  environment variables.

### 7. Wrong versus correct

**Wrong:** write a pi-intercom mirror before `connectedClient.send()` and let
the native parent display and answer it.

**Correct:** send through the broker first, write an additive
`replyTransport: "pi-intercom"` receipt only after delivery, let the native
parent record it only as a wake/detach signal, and reply through the broker.

**Language**: All documentation is written in **English**.
