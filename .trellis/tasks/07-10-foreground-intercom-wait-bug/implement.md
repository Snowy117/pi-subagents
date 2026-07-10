# Implement — foreground intercom wait/notify (D1b cross-protocol handshake)

> Decision: D1b (cross-protocol handshake). Minimal reply-path handling (a):
> document that co-install requires replying via pi-intercom's `intercom` tool.
> Defer native-reply-to-broker forwarding (b).

## Execution order

Implement in two repo-local passes. The **pi-intercom** change is the one that
makes the bug go away; the **pi-subagents** change is test + doc only for the
core fix. Order them so the repro test is written against current (broken)
behavior first, then made green.

### Phase 1 — pi-subagents: repro test (RED) + discriminator

1. **Add `test/integration/foreground-detach-cross-protocol.test.ts`.** A focused
   integration test using the existing `single-execution-harness` (MockPi) +
   event-bus pattern from `single-execution-detach.test.ts`. It must:
   - Register a "shadow" `contact_supervisor` tool on the child mock that
     **mimics pi-intercom**: it does NOT write the native request file (simulating
     the broker-only path), but it DOES emit a sentinel that, after the fix, would
     also write the file. For the RED run, omit the file write.
   - Run a foreground child that calls this shadow `contact_supervisor`.
   - **Assert (RED, current code):** `INTERCOM_DETACH_REQUEST_EVENT` does NOT fire
     within a short window, and `runSync` stays blocked (test fails via timeout /
     assertion).
2. After Phase 2 lands, update the shadow tool to also write the native request
   file (mirroring the pi-intercom change) and flip the assertions to GREEN:
   - `INTERCOM_DETACH_REQUEST_EVENT` fires, `runSync` resolves `detached=true`.
   - After a simulated reply + child exit, `SUBAGENT_ASYNC_COMPLETE_EVENT` fires
     and the run leaves `state.foregroundRuns` as terminal (so `wait` would
     resolve).
3. **Keep existing tests green.** Run the unit + integration suites after
   landing changes.

### Phase 2 — pi-intercom: write native request file (the fix)

In `/home/neko/.pi/agent/git/github.com/Snowy117/pi-intercom/index.ts`:

1. **Add a small `writeNativeSupervisorRequest` helper** (near the top, after the
   env-reading helpers) that:
   - Reads `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR` (skip if absent — non-subagent
     intercom sessions do nothing).
   - Reads `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID`, `PI_SUBAGENT_RUN_ID`,
     `PI_SUBAGENT_CHILD_AGENT`, `PI_SUBAGENT_CHILD_INDEX`,
     `PI_SUBAGENT_INTERCOM_SESSION_NAME`.
   - Ensures `<channelDir>/requests` exists (`fs.mkdirSync(..., {recursive:true,
     mode:0o700})`).
   - Writes a JSON file to `<channelDir>/requests/<requestId>.json` with the
     `SupervisorRequest` schema (see Contract below). Use the broker `messageId`
     as `requestId` when available, else `randomUUID()`.
   - Best-effort: wrap in try/catch; a write failure must never break the broker
     send (the file is a detach trigger, not the transport).
   - **Atomic write:** write to `<file>.tmp` then `fs.renameSync`, OR use a
     vendor copy of the `writeAtomicJson` pattern (pi-subagents uses rename with
     `mode:0o600`). The parent poller parses by `JSON.parse`, so rename-atomicity
     avoids partial reads.
2. **Call it from `contact_supervisor`** for the two reply-expecting reasons
   (`need_decision`, `interview_request`) **before** blocking on `waitForReply`.
   Also call it for `progress_update` (non-blocking, `expectsReply:false`) so the
   parent still sees the progress note surfaced via the native poller. Place the
   call right after computing `requestText` / `questionId`, using:
   - `reason`: the contact reason,
   - `message`: `requestText` (for need_decision/interview) or the update text,
   - `expectsReply`: reason !== "progress_update",
   - `interview`: the validated interview object (for interview_request).
3. **Do NOT** change the broker send, `waitForReply`, the intercom `ask` tool's
   broker path, or any UI. The broker remains the reply transport; the file is
   purely the detach trigger + receipt.

> Optional (nice-to-have, not blocking): also call from the `intercom` tool's
> `ask` action when `childOrchestratorMetadata` is present, for parity. The
> primary path is `contact_supervisor`; `intercom ask` is the documented
> fallback. If time-boxed, do `contact_supervisor` only and note the gap.

### Phase 3 — pi-subagents: docs (the reply-path note)

1. Update the intercom-bridge instruction template or the surfaced
   `subagent_supervisor_request` reply hint so that, in co-install, the parent is
   told to reply via `intercom({ action: "reply", message: "..." })` (pi-intercom's
   tool). The detach message ("Reply to the supervisor request first") stays; we
   just make the active reply tool discoverable. Low-risk text change.
2. Add a spec note under `.trellis/spec` (typescript layer) capturing the
   co-install contract: "When both pi-intercom and pi-subagents are installed,
   the parent must reply to a foreground-detached supervisor request via
   pi-intercom's `intercom reply`, not the native `intercom reply`, because the
   child blocks on the broker." Use the `trellis-update-spec` flow if available.

## Contract — the native `SupervisorRequest` schema pi-intercom must write

(File: `pi-subagents/src/intercom/native-supervisor-channel/types.ts`.)

```jsonc
{
  "type": "subagent.supervisor.request",
  "id": "<messageId or uuid>",          // requestId, used for reply file correlation
  "createdAt": 1783669775458,            // ms epoch
  "expiresAt": 1783670375000,            // ms epoch; only when expectsReply (createdAt + 10min)
  "reason": "need_decision",             // | "interview_request" | "progress_update"
  "message": "<formatted message body>", // same body the broker sends
  "expectsReply": true,                  // false for progress_update
  // routing/correlation (all from env):
  "orchestratorTarget": "<PI_SUBAGENT_ORCHESTRATOR_TARGET>",
  "orchestratorSessionId": "<PI_SUBAGENT_ORCHESTRATOR_SESSION_ID>",
  "runId": "<PI_SUBAGENT_RUN_ID>",
  "agent": "<PI_SUBAGENT_CHILD_AGENT>",
  "childIndex": 0,                       // Number(PI_SUBAGENT_CHILD_INDEX)
  "childTarget": "<PI_SUBAGENT_INTERCOM_SESSION_NAME, optional>",
  "interview": { /* ... */ }             // optional, only for interview_request
}
```

Write path: `<PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR>/requests/<id>.json`
(rename-atomic). The parent poller matches on
`request.orchestratorSessionId === ctxSessionId`, so `orchestratorSessionId`
**must** equal `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` (already set by
pi-subagents' `pi-args.ts` to the parent session id).

## Validation commands

### pi-subagents repo (`/home/neko/Projects/pi-subagents`)

```
npm run lint
npm run typecheck     # if present; else tsc --noEmit via package config
npm run test:unit
npm run test:integration   # includes the new cross-protocol repro test
```

### pi-intercom repo (`/home/neko/.pi/agent/git/github.com/Snowy117/pi-intercom`)

```
npx tsc --noEmit            # typecheck (no dedicated script)
npm test                    # broker/paths, spawn, reply-tracker, integration, inline-message
```

### Live end-to-end (this environment, both extensions installed)

Re-run the repro: dispatch a foreground `delegate` instructed to call
`contact_supervisor({reason:"need_decision", ...})`. **Expected after fix:** the
supervisor request surfaces to the parent, the parent detaches (subagent tool
returns the "Detached for intercom coordination" message), the parent replies via
`intercom({action:"reply"})`, the child resumes and exits, and the completion
notification fires. The `/tmp/pi-subagents-uid-1000/supervisor-channels/.../requests/`
file is now present during the round-trip (was empty before).

## Risky points / rollback

- **pi-intercom file write must be best-effort.** If it throws, the broker path
  must still work (degrade to pre-fix behavior: no detach, but no crash).
- **`orchestratorSessionId` correctness is load-bearing.** If the env is stale or
  mismatched, `requestMatchesContext` returns false and the parent skips the
  request (same symptom as the bug). Verify the env value equals the parent's
  `ctx.sessionManager.getSessionId()` at dispatch time.
- **Rollback:** revert the pi-intercom `writeNativeSupervisorRequest` call sites.
  pi-subagents needs no code revert (no behavioral change there).

## Follow-up (out of scope, tracked here)

- Option (b): make pi-subagents' native `intercom reply` detect broker-origin
  requests and forward over the broker, so either reply tool unblocks the child.
  Defer until the UX bites.
