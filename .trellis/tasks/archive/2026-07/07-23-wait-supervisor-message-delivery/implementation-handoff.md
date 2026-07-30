# Implementation Handoff: supervisor attention during wait

## Scope and implementation summary

Implemented the reviewed `wait-supervisor-message-delivery` task in both working trees without staging or committing files.

Pi-subagents now:

- Treat blocking native supervisor `need_decision` and `interview_request` requests as actionable wait attention.
- Subscribe `wait` to `INTERCOM_DETACH_REQUEST_EVENT` and use subscribe-then-reconcile to close the check/subscription race.
- Keep persistent lifecycle-refreshed request state authoritative; event payloads are only wake hints.
- Capture and filter against exact initial run IDs, excluding unrelated and later-launched runs.
- Return transport-aware request/run/agent/reason and native or pi-intercom reply instructions.
- Keep progress updates out of the wait predicate and avoid async `activityState` changes or `triggerTurn` changes.
- Expose frozen read-only actionable-request summaries from the native channel instead of exposing its mutable pending map.
- Parse the additive `replyTransport: "pi-intercom"` discriminator.
- Suppress duplicate native visible messages and native pending/list/status/reply handling for broker receipts while still recording them and emitting the detach/wake event.

Pi-intercom now:

- Writes a blocking native receipt only after successful broker delivery.
- Writes `replyTransport: "pi-intercom"` and returns the exact receipt path.
- Does not write progress receipts.
- Removes the exact receipt in `finally`, covering broker reply, delivery failure, cancellation, shutdown rejection, timeout/disconnect cleanup paths.
- Clears/restores ambient bridge environment variables in integration tests and uses isolated temporary channel/session fixtures.

The cross-extension contract spec now describes broker-authoritative replies, receipt lifecycle, duplicate suppression, discriminator compatibility, and TUI/RPC versus unchanged JSON/print behavior.

## Changed files

### pi-subagents (`/home/neko/Projects/pi-subagents`)

- `.trellis/spec/typescript/cross-extension-contracts.md`
- `src/extension/index.ts`
- `src/extension/registration/tools.ts`
- `src/intercom/native-supervisor-channel/parent-channel.ts`
- `src/intercom/native-supervisor-channel/request-lifecycle.ts`
- `src/intercom/native-supervisor-channel/types.ts`
- `src/runs/background/wait/helpers.ts`
- `src/runs/background/wait/wait.ts`
- `test/integration/foreground-detach-cross-protocol.test.ts`
- `test/integration/wait-supervisor-cross-protocol.test.ts` (new)
- `test/unit/native-supervisor-channel.test.ts`
- `test/unit/native-supervisor-channel-broker-receipts.test.ts` (new)
- `test/unit/wait-supervisor-request.test.ts` (new)

The task context files under `.trellis/tasks/07-23-wait-supervisor-message-delivery/` remain uncommitted/un-staged as task artifacts.

### pi-intercom (`/home/neko/.pi/agent/git/github.com/Snowy117/pi-intercom`, branch `feat/system-message-template-and-liveness`)

- `index.ts`
- `intercom.integration.test.ts`

## Tests added or updated

- `test/unit/wait-supervisor-request.test.ts`: pre-existing request, event arrival with long poll fallback, check/subscription boundary, exact initial run filtering, later-launched run filtering, progress exclusion, resolution before reconciliation, and repeated level-triggered waits.
- `test/unit/native-supervisor-channel-broker-receipts.test.ts`: broker receipt wake without duplicate delivery/native reply, frozen query summaries, lifecycle pruning.
- `test/unit/native-supervisor-channel.test.ts`: read-only query usage and cancellation assert typing.
- `test/integration/wait-supervisor-cross-protocol.test.ts`: real temporary receipt discovery and event-driven live wait.
- `test/integration/foreground-detach-cross-protocol.test.ts`: native legacy and pi-intercom discriminator cases.
- `pi-intercom/intercom.integration.test.ts`: receipt schema/creation timing, cleanup after reply/cancellation/shutdown, no receipt after delivery failure, no progress receipt, and ambient environment isolation. Existing stale branch expectations were updated only where the current branch already implements immediate interactive steer/system-message template behavior.

## RED evidence

A detached baseline worktree at commit `216acfb` ran the new wait regression file with the production changes absent. The command was terminated by an 8-second guard with exit `124`; the test runner reported interruption while running `test/unit/wait-supervisor-request.test.ts`, demonstrating the prior wait remained blocked rather than returning on supervisor attention.

The existing cross-protocol foreground test also retains an explicit RED baseline case (`does NOT fire detach when the shadow tool omits the file write`).

## Validation commands and results

### Passed

1. `node --experimental-strip-types --test test/unit/wait-supervisor-request.test.ts test/unit/native-supervisor-channel-broker-receipts.test.ts test/unit/native-supervisor-channel.test.ts`
   - **18 tests passed, 0 failed.**
2. `node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/wait-supervisor-cross-protocol.test.ts test/integration/foreground-detach-cross-protocol.test.ts`
   - **5 tests passed, 0 failed.**
3. `env -u PI_SUBAGENT_* bridge variables npm run test:unit`
   - **1000 tests passed, 0 failed.** Environment variables unset to prevent ambient live child-bridge metadata from contaminating minimal unit fixtures.
4. `env -u PI_SUBAGENT_* bridge variables npm run test:e2e`
   - **1 E2E test passed, 0 failed.**
5. In pi-intercom: `npm test`
   - **36 tests passed, 0 failed.**
6. `python3 ./.trellis/scripts/task.py validate 07-23-wait-supervisor-message-delivery`
   - Context validation passed: implement manifest 9 entries and check manifest 7 entries.
7. `git diff --check` in both repositories
   - Passed with no whitespace errors.
8. Changed-file LSP diagnostics
   - Fresh diagnostics for the changed wait/channel source files and new wait/broker tests were clean.

### Full integration result

`env -u PI_SUBAGENT_* bridge variables npm run test:all` completed the unit tier successfully (1000/1000), then the integration tier reported **466/472 passed, 6 failed**. All six failures are in the unrelated pre-existing `test/integration/slash-commands-message-delivery.test.ts` suite (`/run` parsing/UI snapshot and `/parallel` forwarding/limit assertions). A baseline detached worktree at `216acfb` reproduced the same slash-command failures (and additionally the unrelated dynamic fanout failure in that isolated run), so these are not caused by the supervisor-wait changes. The task-specific integration tests in the same run passed, including the new cross-protocol wait test. The e2e tier was run separately and passed.

### Pi-intercom LSP/runtime classification

`npm test` is fully green. LSP diagnostics still report known pre-existing branch errors in `index.ts` (reconnect assignment and broad `AgentToolResult` typing) and the existing child-process stdin typing in `intercom.integration.test.ts`; these are unrelated to the receipt changes. The changed receipt code is exercised by the full 36-test command. One stale daemon diagnostic continued to report the old synchronous assert callback in `test/unit/native-supervisor-channel.test.ts` after the callback was changed to `async`; the focused runtime test passes and the daemon explicitly marked the diagnostic stale. Fresh diagnostics for the new wait tests and wait/channel source files are clean.

## Residual risks / reviewer notes

- Full pi-subagents integration remains red only in the unrelated slash-command suite; it should not be attributed to this task without a separate investigation.
- Pi-intercom's branch retains its known LSP diagnostics despite a green authoritative `npm test`; no unrelated type cleanup was attempted.
- Busy JSON/print pi-intercom auto-reply policy remains intentionally unchanged; a broker ask can settle before a receipt is observed in that mode, per approved scope.
- Native receipt cleanup is best-effort by design. If filesystem deletion fails, native lifecycle refresh eventually prunes stale/inactive/resolved state; broker reply remains authoritative.

## Working-tree / staging state

- pi-subagents has only the intended task implementation, tests, spec update, and existing task artifact files modified/untracked.
- pi-intercom has only `index.ts` and `intercom.integration.test.ts` modified.
- `git diff --cached --name-only` is empty in both repositories.
- No commit, push, merge, or staging operation was performed.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Implemented the reviewed event-driven wait, lifecycle-refreshed read-only supervisor query, transport discriminator, pi-intercom receipt lifecycle, test isolation, focused regressions, and contract documentation in the two specified working trees without unrelated production scope expansion."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "This handoff records changed files, tests, RED baseline evidence, commands/results, full-validation classification, LSP evidence, residual risks, and staging state for independent review."
    }
  ],
  "changedFiles": [
    ".trellis/spec/typescript/cross-extension-contracts.md",
    "src/extension/index.ts",
    "src/extension/registration/tools.ts",
    "src/intercom/native-supervisor-channel/parent-channel.ts",
    "src/intercom/native-supervisor-channel/request-lifecycle.ts",
    "src/intercom/native-supervisor-channel/types.ts",
    "src/runs/background/wait/helpers.ts",
    "src/runs/background/wait/wait.ts",
    "test/integration/foreground-detach-cross-protocol.test.ts",
    "test/integration/wait-supervisor-cross-protocol.test.ts",
    "test/unit/native-supervisor-channel.test.ts",
    "test/unit/native-supervisor-channel-broker-receipts.test.ts",
    "test/unit/wait-supervisor-request.test.ts",
    "/home/neko/.pi/agent/git/github.com/Snowy117/pi-intercom/index.ts",
    "/home/neko/.pi/agent/git/github.com/Snowy117/pi-intercom/intercom.integration.test.ts"
  ],
  "testsAddedOrUpdated": [
    "test/unit/wait-supervisor-request.test.ts",
    "test/unit/native-supervisor-channel-broker-receipts.test.ts",
    "test/unit/native-supervisor-channel.test.ts",
    "test/integration/wait-supervisor-cross-protocol.test.ts",
    "test/integration/foreground-detach-cross-protocol.test.ts",
    "/home/neko/.pi/agent/git/github.com/Snowy117/pi-intercom/intercom.integration.test.ts"
  ],
  "commandsRun": [
    {
      "command": "node --experimental-strip-types --test test/unit/wait-supervisor-request.test.ts test/unit/native-supervisor-channel-broker-receipts.test.ts test/unit/native-supervisor-channel.test.ts",
      "result": "passed",
      "summary": "18 tests passed"
    },
    {
      "command": "node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/wait-supervisor-cross-protocol.test.ts test/integration/foreground-detach-cross-protocol.test.ts",
      "result": "passed",
      "summary": "5 tests passed"
    },
    {
      "command": "env -u PI_SUBAGENT_* bridge variables npm run test:unit",
      "result": "passed",
      "summary": "1000 tests passed"
    },
    {
      "command": "env -u PI_SUBAGENT_* bridge variables npm run test:e2e",
      "result": "passed",
      "summary": "1 test passed"
    },
    {
      "command": "cd /home/neko/.pi/agent/git/github.com/Snowy117/pi-intercom && npm test",
      "result": "passed",
      "summary": "36 tests passed"
    },
    {
      "command": "python3 ./.trellis/scripts/task.py validate 07-23-wait-supervisor-message-delivery",
      "result": "passed",
      "summary": "Implement/check manifests validated"
    },
    {
      "command": "npm run test:all with bridge environment unset",
      "result": "failed",
      "summary": "Unit 1000/1000 passed; integration 466/472 passed, six unrelated slash-command failures"
    },
    {
      "command": "baseline detached worktree regression run with 8-second guard",
      "result": "failed_as_expected",
      "summary": "Exit 124; baseline wait regression hung until guard termination"
    }
  ],
  "validationOutput": [
    "Focused pi-subagents unit: 18/18 passed.",
    "Focused pi-subagents integration: 5/5 passed.",
    "Full pi-subagents unit: 1000/1000 passed with bridge environment unset.",
    "Pi-subagents E2E: 1/1 passed.",
    "Full pi-intercom npm test: 36/36 passed.",
    "Task context validation passed.",
    "No diff whitespace errors; no staged files in either repository."
  ],
  "residualRisks": [
    "Six unrelated slash-command integration tests remain failing and reproduce on a detached baseline.",
    "Known pre-existing pi-intercom LSP diagnostics remain despite green npm test.",
    "Busy JSON/print broker auto-reply behavior is intentionally unchanged.",
    "Receipt deletion is best-effort and relies on lifecycle pruning if filesystem cleanup races fail."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added race-free supervisor attention to wait, a frozen lifecycle-refreshed request query, broker receipt discriminator/suppression/cleanup, isolated cross-protocol regressions, and updated contract documentation.",
  "reviewFindings": [
    "no blockers found in focused implementation review",
    "full integration blocker is confined to unrelated pre-existing slash-command tests",
    "pi-intercom LSP findings are pre-existing/stale and contradicted by green runtime tests"
  ],
  "manualNotes": "Do not stage or commit from this handoff. Reviewer should inspect the six unrelated integration failures separately if full-suite green status is required."
}
```
