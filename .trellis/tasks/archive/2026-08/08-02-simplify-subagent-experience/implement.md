# Implementation Plan: simplify and unify subagent experience

Each phase should finish with focused tests green. Preserve the user's unrelated `.pi/settings.json` modification.

## Phase 1 — Reduce package-owned resources

- [ ] Simplify `src/slash/commands/registration.ts` to register only `/subagents`; remove registration fan-outs and obsolete slash-adapter tests while retaining underlying non-command capabilities that are still referenced.
- [ ] Delete all bundled prompt Markdown files, remove `prompts/**/*` from `package.json#files`, and set `pi.prompts` to `[]` to defeat convention fallback.
- [ ] Delete the seven specialized `agents/*.md` files and reduce `agents/delegate.md` to required neutral `name`/`description` frontmatter only.
- [ ] Add exact default-surface tests: registered commands equal `['subagents']`, packaged prompts are empty, and default builtin discovery equals `['delegate']` with neutral omitted fields.
- [ ] Update fixtures that relied specifically on a removed builtin without renaming independent local agent fixtures.
- Validate: `npm run test:unit` plus focused command/resource discovery integration tests.

## Phase 2 — Shared child exit and configurable picker

- [ ] Extract one child-view teardown function shared by `/subagents exit|close`, canonical exit key, and raw `/quit|/exit` submit adapters.
- [ ] Add a high-priority terminal route using the live global keybinding manager for `app.exit` and `tui.input.submit`; preserve empty/non-empty editor behavior and do not intercept double-Ctrl+C.
- [ ] Add a small package keybinding reader/validator for `subagents.openPicker` in `<agentDir>/keybindings.json`, with no default and extension-reload semantics.
- [ ] Replace `handleSubagentsDown` with the configured picker handler while preserving empty editor, selectable target, and no-modal gates.
- [ ] Remove `tui.openSubagentsOnDown`, `TuiConfig`, defaults/resolution, and stale config tests/docs.
- [ ] Add the exit matrix: default/remap/remove/multiple/legacy migration, host-editor/picker/degraded-modal/inactive states, empty/non-empty, submit remap, `/quit`, `/exit`, shared teardown, and listener priority.
- [ ] Add picker tests for absent/string/array/empty/invalid bindings, dedupe, reload reconstruction, raw matching, and all safety gates.
- Validate: focused unit tests, `npm run test:unit`, and `npm run test:integration` for `/subagents` entry/exit wiring.

## Phase 3 — Complete child history in root scrollback

- [ ] Change `src/tui/child-conversation/render.ts` to return complete child assembler history with full-height minimum padding and no moving-tail slice/clamp.
- [ ] Remove the host-editor seed's 80-line fallback cap. Add an explicit complete trusted-file mode (incremental where practical, with no line/byte truncation) while preserving trusted roots, symlink refusal, malformed-line handling, partial-line safety, and recent-output fallback; keep bounded degraded-view previews separate.
- [ ] Reverse tail-loss tests: oldest child rows remain present after viewport overflow; newest rows remain bottom-visible; short histories still fill the available child viewport; resize and invalidate remain stable.
- [ ] Add host-editor integration coverage with parent and child history proving complete child rows are contributed without parent-history mixing; retain native messages/tools, images/input/slash/autocomplete-compatible host path, live streaming, channel swap, and teardown assertions.
- Validate: focused transcript/render/host-editor tests, `npm run test:unit`, `npm run test:integration`.

## Phase 4 — Integrated wait public contract

- [ ] Add `all?: boolean` and `action:'wait'` documentation to `SubagentParams`; update internal param types and action constants.
- [ ] Route integrated wait through `action-dispatch.ts` with injected lifecycle roots plus existing event/supervisor dependencies. Root observes top-level run/result roots; child-safe fanout observes only its inherited nested run/result roots. Return explicit unavailability only when an authorized root cannot be resolved.
- [ ] Remove standalone `WaitParams`, the `wait` tool registration/export, `waitTool` config/types/resolver, and `PI_SUBAGENT_WAIT_TOOL_ENABLED` handling.
- [ ] Refactor the wait primitive to remove elapsed timeout/config branches while preserving exact-before-prefix resolution, ambiguity, initial snapshots, first/all, no-active immediate return, completion/failed/paused, needs-attention, actionable supervisor requests, AbortSignal, event subscriptions, and poll fallback.
- [ ] Replace timeout tests with virtual-time assertions that waiting stays pending indefinitely until terminal/attention/abort. Assert `active_long_running` and `progress_update` do not wake it.
- Validate: schema tests, wait unit/integration matrix, `npm run test:unit`, `npm run test:integration`.

## Phase 5 — Completion broker and rich result normalization

- [ ] Add a focused session-scoped completion broker module with sync ownership (including canonical mode/concrete task descriptors), full normalized completion cache, exact-run wait support, size/TTL pruning, session reset, and dispose cleanup. Initialize it in root and child-safe state constructors.
- [ ] Expand runner/result-watcher payload types to the full `runner-finalize.ts` contract. Persist actual child task/exitCode/usage values, and centralize normalization so intercom, completion events, sync conversion, and tracker see consistent child statuses/metadata.
- [ ] Cache the normalized full completion before intercom delivery, completion emit, and unlink. Preserve dedupe, nested enrichment, session scoping, native watch/poll fallback, and retry-on-enrichment-failure behavior.
- [ ] Add completion-to-`AgentToolResult<Details>` conversion using existing output-formatting helpers, with canonical mode, full child task/output/error/exitCode/usage/session/model/artifact/truncation/transcript/structured-output metadata, workflow/output maps, available aggregate accounting, and explicit zero usage only for legacy files where per-child usage is unavailable.
- [ ] Make notification handling consult sync ownership and suppress only sync-owned completion turns; observer waits and ordinary async calls retain current batching/notification behavior.
- [ ] Test fast completion before subscription, cache-before-event/unlink ordering, malformed/foreign-session payloads, TTL/size/session cleanup, failure/paused conversion, unavailable usage policy, and sync-vs-async notification ownership.
- Validate: focused broker/result-watcher/notify tests, `npm run test:unit`, `npm run test:integration`.

## Phase 6 — Canonical mode and unified detached execution

- [ ] Introduce one canonical mode helper after `count` expansion. Fix the adjacent invalid-count normalization error so callers receive the concrete validation result.
- [ ] Carry canonical mode and one generated run ID through preparation, spawn reservation, nested metadata, launcher selection, tracker events, status, and results.
- [ ] Refactor public execution so one concrete task calls `executeAsyncSingle`, multiple concrete tasks call `executeAsyncChain`, and every execution uses the detached runner regardless of return policy. Ensure root and child-safe fanout both have a completion ingestion path for their authorized result roots.
- [ ] For `async:true`, return the launch receipt. For default/`async:false`, claim ownership before launch, launch, wait indefinitely for the exact new run ID, convert a terminal broker result, and release ownership on launch error/terminal/attention/abort/session cleanup.
- [ ] Remove or isolate stale undeclared top-level `agent`/`task` and unreachable foreground public branches. Preserve resume/management and child-depth/spawn-limit behavior.
- [ ] Fix call rendering: `subagent <agent>` for one concrete invocation, `subagent parallel (N)` for multiple; `[async]` reflects the resolved caller detach policy only, not the always-detached internal runner.
- [ ] Add sync single/parallel completion, attention, blocking supervisor request, AbortSignal-run-survival, launch failure, and mode propagation tests. Assert one task and `count:1` never say parallel; `count>1` and multi-task always do.
- Validate: focused executor/render tests, `npm run test:unit`, `npm run test:integration`.

## Phase 7 — Restore chain start event and indicator regression

- [ ] Restore `executeAsyncChain` post-spawn nested-start and `SUBAGENT_ASYNC_STARTED_EVENT` emission with current session, PID, canonical mode, agents/chain/parallel/workflow/cwd/asyncDir/budget/nested metadata; emit nothing on failure.
- [ ] Ensure both async-detached and sync-owned launch-plus-wait calls create the tracker job immediately; preserve attention text, status polling, terminal retention, and cleanup.
- [ ] Add producer-level success/failure event tests and a producer-to-tracker/widget integration test that proves the editor-top widget mounts before `tool_result` or completion.
- [ ] Assert attention/completion updates and removal still work for single and parallel runs.
- Validate: focused async execution/tracker/widget tests, `npm run test:unit`, `npm run test:integration`.

## Phase 8 — Documentation, specs, and breaking-change cleanup

- [ ] Update README, `skills/pi-subagents/SKILL.md`, tool descriptions, start-helper messages, examples, package description where needed, and CHANGELOG for removed commands/prompts/agents/config/tool plus migration examples.
- [ ] Update `.trellis/spec/typescript/schema-and-type-safety.md` for integrated wait and cardinality-based single/parallel mode.
- [ ] Rewrite stale entry/view/execution sections of `.trellis/spec/typescript/subagent-interactive-control.md` for shared exit, no-default namespaced picker, full root-scrollback history, unified detached runner, completion broker, integrated wait, and indicator contract. Preserve unrelated persistent RPC/control/bridge contracts.
- [ ] Search for removed command names, prompt names, builtin names in current docs/examples, `openSubagentsOnDown`, `waitTool`, wait-tool registration, and stale “parallel n=1” claims; historical changelog/archive references may remain historical.
- Validate: documentation/resource search plus `python3 ./.trellis/scripts/task.py validate 08-02-simplify-subagent-experience`.

## Phase 9 — Final validation and review

- [ ] Run `npm test`.
- [ ] Run `npm run test:integration`.
- [ ] Run `npm run test:e2e` and then `npm run test:all` when the environment supports the existing faux-provider E2E.
- [ ] Run workspace `lsp_diagnostics` and inspect the full diff for stale public exports/config/docs.
- [ ] Manual smoke: no default Down behavior; configured picker opens; app exit and `/quit` return from child view; long child history is available in terminal scrollback; sync and async single/parallel launches show the editor-top indicator; integrated wait wakes correctly.
- [ ] Run the Trellis check agent against PRD/design/implementation acceptance.

## Risky files and rollback points

- `src/runs/foreground/executor/{prepare-execution,create-executor,async-path}.ts`: public execution lifecycle; keep mode/runner changes together.
- `src/runs/background/result-watcher/*`, new completion broker, and `src/runs/background/notify.ts`: ordering/ownership contract; rollback as one unit to avoid lost or duplicated results.
- `src/tui/steer-view/registration.ts` and new entry/exit adapters: terminal listener priority; revert adapters independently if host drift is found.
- `src/tui/child-conversation/render.ts` and transcript fallback readers: render size/performance; optimize without restoring line-loss semantics.
- `src/extension/schemas/*`, tool registration, config/types: breaking public surface; documentation/spec migration must land in the same change.
