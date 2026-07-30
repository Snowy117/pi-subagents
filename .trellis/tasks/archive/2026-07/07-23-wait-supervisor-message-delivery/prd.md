# Make supervisor requests interrupt an active wait

## Goal

When a parent agent is blocked in the pi-subagents `wait` tool, a blocking
`contact_supervisor` request from one of the runs captured by that wait must
promptly return control to the parent so it can respond. The behavior must
remain correct when pi-intercom is co-installed and owns the child's
`contact_supervisor` tool.

User value: a child waiting for a decision no longer remains blocked until an
unrelated completion, generic attention timeout, or `wait` timeout.

## Background

The archived task `07-10-foreground-intercom-wait-bug` fixed a different
failure. In that bug, pi-intercom's broker-based `contact_supervisor` won the
child tool-name collision but did not write the native request file, so a
foreground parent never received `INTERCOM_DETACH_REQUEST_EVENT` and could not
detach. The pi-intercom native-file bridge and pi-subagents cross-protocol
foreground-detach regression test now cover that path.

The current gap begins after request discovery:

- `src/intercom/native-supervisor-channel/parent-channel.ts` records a blocking
  request and emits `INTERCOM_DETACH_REQUEST_EVENT`.
- `src/runs/background/wait/helpers.ts` does not subscribe to that event.
- `src/runs/background/wait/wait.ts` terminates only for run completion or an
  async `activityState` of `needs_attention`; a supervisor request sets neither.
- A request can therefore be visible in the transcript while the active
  `wait` tool continues sleeping.
- Existing tests cover foreground detach and generic wait wakeups separately,
  but not a newly arriving supervisor request during a live wait.

The native channel currently polls every 250 ms (`CHANNEL_POLL_MS` is bounded
to at most 500 ms). Pi's default `sendMessage` delivery while a tool is active
is steer delivery after the current tool call; `triggerTurn: true` does not
interrupt the active tool.

## Requirements

### R1 - Actionable supervisor attention

- Blocking `need_decision` and `interview_request` requests for a run in the
  wait's initial run snapshot must make `wait` return promptly after discovery.
- The wait result must identify the request and run and state the applicable
  reply path.
- An unresolved request is level-triggered: later waits that include the same
  run must continue returning until the request is resolved or becomes stale.
- `progress_update` is non-blocking and must not terminate `wait`.

### R2 - Race-free wake and reconciliation

- The detach/supervisor event is an immediate wake hint; persistent pending
  request state is the authority for whether `wait` returns.
- The implementation must cover a request that exists before `wait`, arrives
  after subscription, or arrives between the initial check and subscription.
- The wait predicate must use exact resolved run IDs from its initial snapshot.
  Unrelated runs and runs launched after the wait begins must not satisfy it.
- Resolved, expired, inactive, missing, or wrong-session requests must not
  terminate `wait`.

### R3 - Read-only lifecycle boundary

- The native supervisor channel must expose a read-only, lifecycle-refreshed
  query for actionable requests instead of sharing its mutable pending map with
  `wait`.
- Supervisor requests must not be persisted as async
  `activityState: "needs_attention"`; that state has a separate owner and
  lifecycle.

### R4 - pi-intercom co-installation contract

- Compatibility targets pi-intercom branch
  `feat/system-message-template-and-liveness` (baseline commit `4099abf`).
- The native request schema gains an optional transport discriminator. A mirror
  written by pi-intercom uses `replyTransport: "pi-intercom"`; absence remains
  backward-compatible native behavior.
- For a pi-intercom receipt, pi-subagents records and queries the actionable request
  and emits the wake/detach event, but does not inject a duplicate native
  supervisor message or offer the native reply tool for that request. The
  broker message and `intercom({ action: "reply" })` remain authoritative.
- Pi-intercom writes a blocking native receipt only after broker delivery
  succeeds and removes it best-effort whenever the broker ask settles, fails,
  is cancelled, times out, or disconnects. A resolved broker ask must not
  interrupt later waits.
- Non-blocking progress updates remain broker-delivered and do not require a
  native receipt because they neither detach nor terminate `wait`.

### R5 - Turn-delivery policy

- Do not add `triggerTurn: true` to native supervisor delivery. Returning the
  active `wait` allows queued steer delivery to reach the next model call, and
  a second trigger could duplicate pi-intercom's idle behavior.
- Do not redesign completion/control notification batching or the pi-intercom
  broker protocol in this task.

### R6 - Mode boundary

- The pi-subagents wait predicate and native request path are mode-independent
  and must work in TUI, RPC, JSON, and print hosts.
- Co-installed pi-intercom end-to-end human reply behavior is required for TUI
  and RPC (`ctx.hasUI === true`).
- Pi-intercom's existing busy non-interactive auto-reply policy in JSON and
  print modes remains unchanged. A broker ask may therefore resolve before its
  native receipt is observed; changing that policy requires structured broker
  supervisor metadata and is a separate follow-up.

### R7 - Regression and test isolation

- Add a focused RED reproduction before changing wait behavior.
- Cover pre-existing requests, event-driven arrival, the check/subscription
  boundary, run filtering, progress updates, and resolution before
  reconciliation.
- Cover broker-receipt suppression and lifecycle pruning in pi-subagents.
- Cover pi-intercom receipt creation after delivery and cleanup on all ask exit
  paths.
- Pi-intercom tests must clear and restore ambient native supervisor-channel
  variables by default. Bridge tests must use an isolated temporary channel and
  session identity so fixtures can never write into a live parent channel.
- Update the cross-extension contract spec to match the implemented writer,
  transport discriminator, duplicate-delivery policy, and reply lifecycle.

## Acceptance Criteria

- [ ] **AC1 / R1-R2:** With a long poll fallback armed, a newly discovered
      blocking request for an initially waited run returns `wait` via the event
      path, without waiting for run completion or the poll timeout.
- [ ] **AC2 / R1-R2:** A request already pending before `wait`, including one
      created at the check/subscription boundary, is observed without a missed
      wake.
- [ ] **AC3 / R1-R2:** Unrelated runs, later-launched runs, non-blocking progress
      updates, and requests resolved before reconciliation do not terminate the
      wait.
- [ ] **AC4 / R1-R3:** An unresolved blocking request continues to interrupt
      matching waits, and stops doing so immediately after lifecycle refresh
      observes resolution/removal.
- [ ] **AC5 / R4-R5:** A pi-intercom receipt emits one wake/detach signal but no
      duplicate native message and no native reply option; the queued broker
      message remains the authoritative parent instruction.
- [ ] **AC6 / R4:** Pi-intercom creates no receipt on broker delivery failure and
      removes a created receipt after reply, cancellation, timeout/disconnect,
      and shutdown-driven waiter rejection.
- [ ] **AC7 / R6:** Native-only mode coverage proves the wait behavior is not
      gated on `ctx.hasUI`; co-installed TUI/RPC coverage proves the broker reply
      unblocks the child. JSON/print auto-reply behavior is documented as
      unchanged.
- [ ] **AC8 / R7:** Pi-intercom tests cannot inherit or write to the live
      `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR` or orchestrator session identity.
- [ ] **AC9 / R7:** Focused and full pi-subagents unit/integration checks,
      pi-intercom's full test command, and TypeScript LSP diagnostics pass.
- [ ] **AC10 / R7:** `.trellis/spec/typescript/cross-extension-contracts.md`
      describes the actual implemented co-installation contract without
      claiming that generic `intercom ask` writes native receipts.

## Out of Scope

- Changing pi-intercom's busy JSON/print auto-reply policy or adding structured
  supervisor metadata to the broker message protocol.
- Making native reply actions forward over the pi-intercom broker.
- Reworking foreground detached-run resume behavior.
- Waking an otherwise idle parent for native-only requests.
- General redesign of completion, control, or result notification batching.

