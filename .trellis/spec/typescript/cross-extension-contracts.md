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

**Contract**: pi-intercom's `contact_supervisor` (and `intercom ask` for
subagent contexts) **additionally writes a native `SupervisorRequest` file** to
`PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR/requests/<id>.json` whenever that env is set.
The file uses the exact schema in
`src/intercom/native-supervisor-channel/types.ts` (`type`,
`id`, `createdAt`, `reason`, `message`, `expectsReply`, `orchestratorSessionId`,
`runId`, `agent`, `childIndex`, optional `expiresAt`/`childTarget`/`interview`).
The parent poller then discovers the file → emits
`INTERCOM_DETACH_REQUEST_EVENT` → `detachForIntercom()` fires. **No parent-side
change is needed** to detect the request once the file is written.

The file write is **best-effort**: a failure must never break the broker send
(it degrades to the pre-fix stuck-parent behavior, which is bad UX but not a
crash). The broker remains the authoritative transport for delivery/reply.

### Reply path (the one asymmetry)

After detach, the orchestrator must reply via **pi-intercom's `intercom
{action:"reply"}`** (broker), **not** the native `intercom reply` (which writes a
reply file). The child is blocked on the broker's `waitForReply`, not polling
the native reply file. A native reply is silently lost → child blocks until the
10-min ask timeout.

**Mitigation in place**: the surfaced `subagent_supervisor_request` message and
pi-intercom's incoming-message hint both direct the parent to
`intercom({ action: "reply", message: "..." })`.

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

**Language**: All documentation is written in **English**.
