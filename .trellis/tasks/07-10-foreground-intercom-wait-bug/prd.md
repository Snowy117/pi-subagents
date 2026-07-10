# Fix foreground subagent wait/notify after intercom interaction

## Goal

When a foreground subagent detaches for intercom coordination, the parent must
be able to observe the detached child's lifecycle: surface the child's
supervisor request, reply to it, `wait` for the child to finish, and receive
its completion notification. Today, when **pi-subagents** and **pi-intercom**
are both installed, the child's `contact_supervisor` is intercepted by
pi-intercom's broker-based implementation, which never triggers pi-subagents'
detach machinery — so the parent stays blocked, can neither surface the request
nor `wait`, and receives no completion.

## Background — Confirmed Root Cause (live-reproduced)

Reproduced directly in this session (latest plugin loaded):

- **Repro 1** (run `f27fd58a`): foreground `delegate` instructed to call
  `contact_supervisor` first. Child held the foreground ~20min then failed; the
  supervisor request never surfaced to the parent; no detach.
- **Repro 2** (run `97970a25`): same, with a watcher polling
  `/tmp/pi-subagents-uid-1000/supervisor-channels` every 0.2s for 60s. **Zero
  request files captured.**

Decisive evidence — child transcript `.../97970a25/run-0/session.jsonl`:
- `toolCall contact_supervisor({reason:"need_decision",message:"REPRO2: yes or no?"})`.
- A `custom: intercom_sent` event with `to:"subagent-chat-019f4ae5"` — emitted
  by **pi-intercom**, NOT pi-subagents (`intercom_sent` appears nowhere in
  `src/`).
- Tool returns `Failed: Session shutting down` when the parent kills/escapes.

### The conflict

Two extensions register a tool named `contact_supervisor`:

1. **pi-subagents native** (`src/intercom/native-supervisor-channel/child-client.ts`
   → `registerNativeSupervisorClient`): writes a request JSON to
   `SUPERVISOR_CHANNEL_ROOT/<channel>/requests/`. The parent's
   `createNativeSupervisorChannel` `poll()` discovers it → emits
   `INTERCOM_DETACH_REQUEST_EVENT` → `detachForIntercom()` → foreground
   `runSync` resolves `detached=true` and the parent is free.
2. **pi-intercom** (`~/.pi/agent/git/github.com/Snowy117/pi-intercom/index.ts`):
   registers its own `contact_supervisor` (gated on
   `PI_SUBAGENT_ORCHESTRATOR_TARGET`/`RUN_ID`/`CHILD_AGENT`/`CHILD_INDEX`,
   which pi-subagents also sets). Routes via **socket broker**, blocks on
   `waitForReply`. Writes **no** file, emits **no**
   `INTERCOM_DETACH_REQUEST_EVENT`.

pi's `registerTool` stores tools in a per-extension `Map` keyed by name. The
native client loses not by load-order luck but by a guard:
`registerNativeSupervisorClient` only registers when
`!hasTool(pi, "contact_supervisor")`. pi-intercom registers at module-load
(top-level `if (childOrchestratorMetadata)`); pi-subagents registers lazily on
`session_start`. By `session_start`, pi-intercom's tool already exists, so the
native client **silently skips** registration (the `intercom_sent` event in the
transcript proves pi-intercom's tool handled the call). Because the broker path
writes no request file, the parent's supervisor-channel poller finds nothing →
no detach → foreground `runSync` stays blocked → parent stuck → no completion
notification.

This is an **integration/architecture conflict**, not the in-process timing bug
originally hypothesized (H1–H4 in the prior PRD revision are all invalidated:
they assumed the native file path was taken — it isn't). The original
user-reported scenario (`intercom({action:"ask"})`) shares the same root cause:
the foreground child's blocking intercom round-trip never detaches.

### Verified architecture facts (unchanged, still correct in isolation)

- `wait` CAN track foreground-detached runs: `foregroundRunsForWait` reads
  `state.foregroundRuns`; a detached child → `foregroundRunEffectiveState`
  returns `"running"`, and on child exit `updateRememberedForegroundChild`
  flips it terminal → `wait` resolves.
- `SubagentState` is a module-level singleton (`extension/index.ts:82`);
  `registerSubagentNotify`'s `SUBAGENT_ASYNC_COMPLETE_EVENT` handler survives
  across turns.
- The foreground control is cleaned in a `finally` block on tool return, so it
  is not itself a turn gate.
- `notifyForegroundDetachedCompletion` emits with `sessionId =
  state.currentSessionId`; `handleComplete` gates on the same field — they match
  within one stable process.

## Requirements

- **R1 — Detach must fire when a foreground child asks its supervisor via
  intercom, regardless of which extension's `contact_supervisor`/`intercom`
  tool actually handles the child's call.** The parent must become free to act
  (surface/reply/wait) the moment the child blocks on a supervisor reply.
- **R2 — After detach, `wait` resolves on child exit** and the **completion
  notification delivers** (the existing in-process machinery already does this
  once detach fires; R1 is what unblocks it).
- **R3 — No regression.** Existing foreground, detach, intercom, and
  notification tests pass; co-installation with pi-intercom does not double-fire
  detach or duplicate requests.
- **R4 — Reproduction coverage.** A test captures the conflict (child intercom
  ask must result in parent-side detach) and discriminates it from the pure
  in-process path.

## Acceptance Criteria

- [ ] A reproduction test exists that fails on current code and passes after the
      fix (foreground child asks supervisor via intercom → parent detaches →
      parent can reply → child exits → `wait` resolves + completion delivers).
- [ ] With both pi-subagents and pi-intercom installed, a foreground child's
      `contact_supervisor`/`intercom` ask triggers the parent's detach so the
      parent is no longer stuck.
- [ ] After detach + reply + child exit, `wait` for that run resolves and the
      `subagent-notify` completion fires.
- [ ] `npm run lint`, `npm run typecheck`, and the full test suite pass.

## Design Decision (resolved)

- **Co-existence:** both pi-intercom (general cross-session messaging + broker
  + UI) and pi-subagents (native supervisor channel + detach) stay installed
  together. They serve distinct purposes; only the overlapping
  `contact_supervisor`/parent-reply tool is the conflict.
- **Direction: D1b (cross-protocol handshake).** Detach must fire regardless of
  which extension's tool handles the child's call. pi-intercom, in its
  `contact_supervisor` (and `intercom ask` for subagent contexts), additionally
  writes a native `SupervisorRequest` file to the channel dir pi-subagents
  already sets via `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR`. The existing parent
  poller then discovers the file → emits
  `INTERCOM_DETACH_REQUEST_EVENT` → `detachForIntercom()` — reusing the entire
  native detach pipeline with **no parent-side code change** for detection.
  Full design in `design.md`; execution plan in `implement.md`.
- **Reply path (minimal):** in co-install, the parent must reply via
  pi-intercom's `intercom({action:"reply"})` (the child blocks on the broker,
  not on the native reply file). Documented via the surfaced request's reply
  hint + a spec note. Native-reply-to-broker forwarding deferred (option b).

## Out of Scope

- Re-enabling `resume`/revive of detached foreground children (throws by design,
  `resume-targets.ts:24`).
- Changing the pi-intercom broker protocol or the supervisor-channel filesystem
  protocol themselves (only the bridging/detection between them is in scope).
- The async/background detach path (separate code path).
- Native-reply-to-broker forwarding (option b; deferred until the UX bites).
