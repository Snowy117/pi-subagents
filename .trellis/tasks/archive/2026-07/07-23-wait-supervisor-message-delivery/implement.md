# Implementation plan

## Working-tree and ownership rules

- Use one writer sequentially across both repositories.
- pi-subagents task root: `/home/neko/Projects/pi-subagents`.
- pi-intercom integration root:
  `/home/neko/.pi/agent/git/github.com/Snowy117/pi-intercom`, branch
  `feat/system-message-template-and-liveness`.
- Snapshot both `git status --short --branch` outputs before editing and never
  include unrelated user changes.
- Do not run pi-intercom integration tests until ambient supervisor-channel
  environment isolation is fixed; planning already demonstrated that fixtures
  can otherwise reach a live parent.

## 1. Add RED wait reproductions

- [ ] Create a focused pi-subagents unit test file for supervisor attention
      during wait rather than growing `test/unit/wait.test.ts` past its size
      guideline.
- [ ] Prove current code fails to return for a newly inserted blocking request
      when only the supervisor event fires and the run stays active.
- [ ] Add cases for pre-existing state and the check/subscription race before
      production changes.
- [ ] Record the focused failing command/output in the implementation handoff.

## 2. Isolate pi-intercom bridge tests first

- [ ] Extend the integration environment guard to clear and restore
      `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR` and
      `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID`.
- [ ] Add a temporary channel/session fixture for bridge-specific tests and
      remove it in teardown.
- [ ] Keep process-environment bridge tests non-concurrent.
- [ ] Run only the isolation-focused test before adding bridge behavior tests.

## 3. Implement the pi-subagents attention source

- [ ] Add the optional `replyTransport: "pi-intercom"` discriminator to the
      native request type and parsing contract.
- [ ] Replace the factory's externally exposed mutable pending map with a
      lifecycle-refreshed read-only actionable-request query.
- [ ] Keep the map private to parent-channel tools.
- [ ] Exclude pi-intercom receipts from native pending/list/reply/status counts.
- [ ] For pi-intercom receipts, suppress duplicate `pi.sendMessage` delivery but
      still emit `INTERCOM_DETACH_REQUEST_EVENT` after recording the request.
- [ ] Preserve native request/progress behavior and legacy files without the
      discriminator.

## 4. Make wait event-driven and race-free

- [ ] Inject the actionable-request query through `extension/index.ts` and
      `extension/registration/tools.ts` into `WaitDeps`.
- [ ] Add `INTERCOM_DETACH_REQUEST_EVENT` to wait's wake channels.
- [ ] Implement subscribe-then-query reconciliation inside the wake primitive
      so no request can land between the initial check and subscription.
- [ ] Query before the first sleep and after every wake.
- [ ] Filter requests against exact IDs captured at wait start.
- [ ] Return a transport-aware summary for blocking requests without changing
      async `activityState` or adding `triggerTurn: true`.
- [ ] Update the wait tool description to name blocking supervisor requests as
      an early-return condition and state the mode boundary accurately.

## 5. Complete pi-subagents regression coverage

- [ ] Cover requests before wait, after subscription, and at the
      check/subscription boundary.
- [ ] Cover targeted ID resolution, unrelated runs, later runs, progress
      exclusion, resolution-before-reconciliation, and repeated waits.
- [ ] Add parent-channel tests for immutable/refreshed query results, transport
      filtering, duplicate suppression, and lifecycle pruning.
- [ ] Add a focused integration test combining real request-file discovery,
      live wait, shared event bus, and a long poll fallback.
- [ ] Update the existing foreground-detach cross-protocol fixture to cover the
      new pi-intercom discriminator while retaining a legacy/native case.

## 6. Fix pi-intercom receipt ownership

- [ ] Make the atomic native writer return the created receipt path or
      `undefined`; add best-effort removal for that path.
- [ ] Write blocking receipts only after broker delivery succeeds and include
      `replyTransport: "pi-intercom"`.
- [ ] Remove the receipt in a `finally` spanning broker reply wait completion,
      cancellation, timeout/disconnect, and shutdown rejection.
- [ ] Do not create a native receipt for progress updates.
- [ ] Add tests for successful creation/schema, delivery failure, reply,
      cancellation, and representative waiter rejection/cleanup paths.
- [ ] Reconcile the stale busy-interactive test expectation with the branch's
      current steer behavior without broadening the supervisor fix.

## 7. Update cross-extension documentation

- [ ] Update `.trellis/spec/typescript/cross-extension-contracts.md` to describe
      receipts as detach/wait signals, the optional transport discriminator,
      broker-authoritative replies, duplicate suppression, and cleanup owner.
- [ ] Remove the unsupported claim that generic pi-intercom `intercom ask`
      writes a native supervisor receipt.
- [ ] Document TUI/RPC support and the unchanged busy JSON/print auto-reply
      boundary.

## 8. Validation

Run focused checks first, then full repository checks.

### pi-subagents

```bash
node --experimental-strip-types --test test/unit/wait-supervisor-request.test.ts test/unit/native-supervisor-channel-broker-receipts.test.ts
node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/wait-supervisor-cross-protocol.test.ts test/integration/foreground-detach-cross-protocol.test.ts
npm run test:unit
npm run test:integration
npm run test:all
```

Run `lsp_diagnostics` on every changed TypeScript file and then with `path="*"`.
This repository has no lint or typecheck script; do not report nonexistent
commands as validation.

### pi-intercom

After environment isolation is in place:

```bash
npm test
```

Run file-specific LSP diagnostics for changed pi-intercom TypeScript files. Its
package defines no lint/typecheck script, so the full configured test command is
the authoritative executable check.

### Final cross-repository review

- [ ] Confirm both working trees contain only intended changes.
- [ ] Confirm the side-channel schema values match exactly in both repositories.
- [ ] Confirm one blocking broker ask produces one LLM-visible broker message,
      one native wake/detach event, and no native reply option.
- [ ] Confirm receipt cleanup prevents a resolved request from interrupting a
      later wait.
- [ ] Confirm no test wrote outside its temporary channel directory.
- [ ] Run `python3 ./.trellis/scripts/task.py validate
      07-23-wait-supervisor-message-delivery` from pi-subagents.

## Rollback points

1. After RED tests: no production changes; remove only new tests if the design
   is rejected.
2. After pi-subagents changes: native-only behavior can be reverted without
   touching broker protocol.
3. After pi-intercom changes: revert receipt discriminator/cleanup together;
   leaving only one can restore duplicate or stale pending behavior.
4. Do not commit either repository until both sides pass their checks and the
   cross-repository contract has been reviewed.

