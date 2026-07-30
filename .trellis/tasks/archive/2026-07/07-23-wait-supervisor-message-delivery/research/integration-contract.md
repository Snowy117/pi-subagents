# Supervisor wait and pi-intercom integration evidence

## Repositories and baselines

- pi-subagents: `/home/neko/Projects/pi-subagents`, branch `main`.
- pi-intercom: `/home/neko/.pi/agent/git/github.com/Snowy117/pi-intercom`, branch
  `feat/system-message-template-and-liveness`, inspected at `4099abf`.
- The pi-intercom working tree was clean before research. No source edits were
  made during planning.

## Current pi-subagents delivery path

1. `src/intercom/native-supervisor-channel/parent-channel.ts` polls request
   files, validates session/lifecycle, stores reply-expecting requests in a
   private map, sends a visible custom message, then emits
   `INTERCOM_DETACH_REQUEST_EVENT`.
2. `src/runs/foreground/execution/single-attempt-process.ts` consumes that event
   for foreground detach.
3. `src/runs/background/wait/helpers.ts` subscribes only to completion, control,
   control-intercom, and result-intercom wake channels.
4. `src/runs/background/wait/wait.ts` returns only for completion or persisted
   async `needs_attention`; the supervisor request changes neither.
5. `src/extension/index.ts` creates both the supervisor channel and wait tool,
   so it can inject a narrow read-only request query without adding supervisor
   lifecycle to global async state.

Adding the event to the wake set is necessary but insufficient. The wait loop
would wake, see a still-running child, and sleep again. A persistent actionable
request query is also required.

## Race model

The request producer inserts into pending state before emitting the event. A
race-free consumer therefore uses this sequence:

1. Query actionable requests for the exact initial run snapshot.
2. Subscribe to wake events.
3. Query again immediately after subscription and before awaiting sleep.
4. Treat events only as wake hints and query again after every wake.

This covers request-before-wait, request-after-subscription, and the gap between
the first query and subscription. Unresolved requests stay level-triggered
until lifecycle refresh observes removal, reply, expiry, or inactive run state.

## Pi message semantics

Pi SDK `docs/extensions.md` documents:

- `ctx.mode` is `tui`, `rpc`, `json`, or `print`.
- `ctx.hasUI` is true in TUI/RPC and false in JSON/print.
- `sendMessage` defaults to `deliverAs: "steer"` while streaming. The message is
  delivered after the active assistant turn finishes its tool calls and before
  the next model call.
- `triggerTurn: true` triggers only while idle and is not a mid-tool interrupt.

Consequently, the supervisor event must make `wait` return. Adding a native
trigger is neither sufficient nor desirable when pi-intercom also owns idle and
busy broker delivery.

## Current pi-intercom bridge

`index.ts` registers `contact_supervisor` at module load and therefore wins the
co-installed child tool name. Its helper `writeNativeSupervisorRequest` writes
an atomic file in pi-subagents' schema, but currently:

- writes blocking files before broker delivery is known to have succeeded;
- does not remove the file after broker reply/cancellation/failure;
- writes a second native mirror for progress updates;
- does not identify the authoritative reply transport.

The broker child waits in pi-intercom's `waitForReply`; writing a native reply
file cannot unblock it. The side-channel file is only a detach/wake receipt.

## Required co-installation contract

- Add optional `replyTransport: "pi-intercom"` to broker-origin native
  receipts. Missing means native/backward-compatible behavior.
- Pi-subagents retains such blocking receipts for lifecycle-aware wait queries
  and emits the existing detach event, but suppresses its duplicate visible
  message and native reply/list handling.
- Pi-intercom writes a blocking receipt only after successful broker delivery
  and removes it best-effort in the blocking ask's final cleanup path.
- Progress updates use the broker only because they do not detach or interrupt
  wait.
- Broker protocol and reply routing remain unchanged.

## Non-interactive boundary

Pi-intercom currently auto-replies to a new inbound message while a no-UI
session is busy and does not deliver that message to the model. A mirrored
supervisor ask can therefore resolve and be removed before pi-subagents sees
it. The current task leaves that policy unchanged. Native-only wait behavior is
mode-independent; co-installed end-to-end human reply acceptance covers TUI and
RPC. Supporting broker asks in busy JSON/print mode requires a separate design
with structured supervisor metadata in broker messages.

## Test-isolation finding

During research, pi-intercom integration fixtures inherited the live
`PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR` and orchestrator session identity and wrote
fake requests into the active parent channel. Those injected requests were test
data, not real user or subagent decisions.

Before running more pi-intercom integration tests:

- include the supervisor channel directory and orchestrator session ID in the
  environment keys cleared/restored by the test helper;
- use `mkdtemp` and a unique non-live session ID in bridge-specific tests;
- remove the temporary channel during teardown;
- keep environment-mutating tests non-concurrent.

## Existing coverage gap

- `test/unit/wait.test.ts` covers generic completion wake and poll fallback.
- `test/unit/native-supervisor-channel.test.ts` covers native display ordering.
- `test/integration/foreground-detach-cross-protocol.test.ts` covers filesystem
  receipt to foreground detach.
- No test combines a live wait, native request discovery, event wake, and
  persistent request reconciliation.
- Pi-intercom has no assertion for native receipt creation, cleanup, or ambient
  bridge environment isolation.

