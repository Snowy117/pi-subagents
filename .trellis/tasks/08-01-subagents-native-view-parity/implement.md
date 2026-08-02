# Implementation Plan: unified native child conversation

Companion to `design.md`. Ordered phases; each ends green
(`npm run test:unit`; integration from Phase 2). Rollback points marked.

## Phase 0 — Compile target 0.83.0 (small, isolated)

- [ ] Bump `node_modules/@earendil-works/pi-coding-agent` (and `pi-tui`,
      `pi-ai` as needed) to 0.83.0; run `npm install --save` equivalents per
      repo convention; verify `pi --version` == runtime.
- [ ] Type-check + full unit suite green (fix any drift).
- Validate: `npx tsc --noEmit` (or repo's type-check) && `npm run test:unit`.

## Phase 1 — Viewer settings + transcript fidelity primitives

- [ ] `src/tui/child-conversation/viewer-settings.ts`: read global + project
      settings.json (deep merge project-wins), 500ms TTL, expose the 6 inputs;
      markdown theme = getMarkdownTheme + codeBlockIndent; toolOutputExpanded
      injected by caller from ctx.ui.getToolsExpanded() (0.83.0).
- [ ] Transcript record fidelity: expose full `message` objects (already
      written) + stream event shapes typed; unit tests for de-dupe heuristics.
- Validate: unit tests green; no behavior change yet.

## Phase 2 — Native assembler (shared by widget and degraded overlay)

- [ ] `src/tui/child-conversation/assembler.ts`: port of addMessageToChat +
      renderSessionItems + live event handlers (message_start/update/end,
      tool_execution_*, tool_result_end, agent_settled); pairing by toolCallId;
      settings snapshot; generic fallback labels.
- [ ] `src/tui/child-conversation/render.ts`: component factory (Container)
      rendering the item tail into W lines (padded), full-height sizing,
      invalidate() contract, expand re-apply per settings pass.
- [ ] Unit tests: role selection, toolCall↔toolResult pairing, streaming
      update flattening, settings application, fallback branches, resize.
- Validate: `npm run test:unit` (existing host-editor tests adjusted to feed
  the assembler).

## Phase 3 — Host-editor widget switches to the assembler

- [ ] Rewrite `host-editor-mode.ts` transcript surface: widget = assembler
      (W = rows − CHROME), seed from transcript, live via onStdoutLine;
      forward `input.images` on prompt; keep `//name` validation + exits.
- [ ] `routeInput` becomes channel-generic over ChildConversationChannel.
- [ ] Naming: extract channel interface + LocalRpcChannel from existing code;
      host-editor-mode consumes the abstraction (no functional change yet).
- [ ] `src/tui/child-conversation/child-keybindings.ts`: effective key map for
      the 7 app actions (defaults + keybindings.json overrides + legacy
      migration) + matcher; unit tests for user remaps/removals.
- [ ] `src/tui/steer-view/child-key-route.ts` (mode-gated onTerminalInput):
      interrupt→abort (streaming only), model.cycle fwd/bwd, model.select
      (ctx.ui.select), thinking.cycle, tools.expand/thinking.toggle local;
      consume only when routed; Esc pass-through when child idle.
- Validate: foreground integration tests (existing) green; key-route unit
  tests (key resolution matrix incl. custom keybindings.json; consume gating;
  idle-Esc pass-through); manual smoke.

## Phase 4 — Async bridge (runner side)

- [ ] `src/runs/background/runner/conversation-bridge.ts` (runner side):
      conversation dir ensure; per-child relay writer (raw stdout lines +
      child_ready/settled/closed markers, 20MiB cap + relay_reset); requests
      watcher (offset cursor) forwarding prompt/get_commands/ping; heartbeat
      freshness check helper.
- [ ] `run-pi-streaming.ts`: optional `conversationRelay` hook tapping parsed
      stdout lines (+ markers on settle/close).
- [ ] `run-subagent.ts` lifecycle: eviction loop except conversing keys;
      finalize → linger while ≥1 fresh heartbeat (TTL 30s, max 10min) →
      closeAll → exit; session_shutdown/interrupt paths clear promptly.
- [ ] Unit + integration: relay framing/cap; requests round-trip; settle
      markers; linger/finalize ordering; heartbeat expiry.
- Validate: `npm run test:unit && npm run test:integration`.

## Phase 5 — AsyncBridgeChannel (parent side) + wiring

- [ ] `src/tui/steer-view/async-bridge-channel.ts`: requests append (atomic),
      stdout relay tail reader, heartbeat writer, closed via EOF/pid death.
- [ ] `resolveChildChannel(target)` (new module or index.ts): foreground →
      registry/reopen; async running → bridge (bounded boot retry); async
      terminal → wait runner pid death (≤5s) → reopen; else undefined.
- [ ] `getResidentChild` removed/replaced by resolveChildChannel; host-editor
      re-resolve on channel closed (seamless swap preserves accumulated
      conversation).
- [ ] Open-view `showChat`: async no longer falls to the overlay by default.
- [ ] Wire the 4.2 key-route to AsyncBridgeChannel (abort/model/thinking all
      forwarded via requests inbox); verify response relay.
- [ ] Tests: resolve matrix, bridge channel behaviors, channel swap on close,
      reopen race guard, input routing matrix across channel kinds.
- Validate: unit + integration (new async bridge fixture w/ real runner).

## Phase 6 — Degraded surface + regression sweep

- [ ] `SteerViewComponent` legacy path only for "continuity unavailable":
      notice header + native assembler rendering (no self-drawn message/tool
      lines); steer + thinking controls remain.
- [ ] README/CHANGELOG updates (parity matrix, best-effort boundaries).
- [ ] Full scope regression: foreground + async execution, steer/control,
      eviction, /subagents exit/target, DCP //name, parent chat restore.
- Validate: `npm run test:all` (unit+integration+e2e as runnable), manual TUI
  smoke (foreground child, async running child, async completed child, zentui
  editor, tool-display).

## Risky files / rollback points

- `src/tui/steer-view/host-editor-mode.ts` — widget surface rewrite; keep the
  old strip rendering behind the degraded toggle for one release?
  Rollback: assembler swap is additive; routing untouched.
- `src/runs/background/runner/run-subagent.ts` + `run-pi-streaming.ts` — linger
  lifecycle + relay; rollback = `subagents.persistentChildren: false` restores
  immediate closeAll on finalize (the bridge follows `persistentChildren`).
- `src/extension/index.ts` — resolveChildChannel; rollback = keep
  getResidentChild for foreground (bridge gated off).
- `src/tui/steer-view/child-key-route.ts` — interception gate; rollback =
  disable via config `subagents.childKeyRoute` (default true) → keys revert
  to main-agent semantics.
- Dep bump (Phase 0) — isolated commit; revert yields prior pinned version
  (0.82.1 types still compile the new assembler — no new-API dependency beyond
  getToolsExpanded, which has a runtime fallback).

## Validation commands

- Every phase: `npm run test:unit`.
- Phase 2+: `npm run test:integration`.
- Phase 6: full `npm run test:all`; manual smoke checklist above.

## Before start

- [ ] Confirm `package.json` devDependency / lockfile strategy for 0.83.0.
- [ ] AC mapping: AC1–AC10 closed across Phase 3/4/5/6; checklist per phase
      references its ACs in code review.
- [ ] Agreed config keys: `subagents.childKeyRoute` (default true); the runner
      conversation bridge follows `persistentChildren` (no separate key —
      documented in design §9); heartbeat TTL / linger max / relay cap
      constants (no further user-config keys unless review asks).