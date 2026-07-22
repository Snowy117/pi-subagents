# Implementation Plan

1. Update `isMutatingTool()` in `src/runs/shared/long-running-guard.ts` to include `apply_patch`.
2. Refactor `hasMutationToolCall()` in `src/runs/shared/completion-guard.ts` to call the shared classifier for assistant tool calls.
3. Add unit coverage in `test/unit/completion-guard.test.ts` for `apply_patch`, while retaining existing edit/write/bash cases.
4. Run `npm test` and inspect workspace LSP diagnostics.
5. Review the complete diff against this task's acceptance criteria and confirm no unrelated behavior changed.

## Validation Commands

- `npm test`
- `git diff --check`
- LSP diagnostics with `path="*"`

## Risk / Rollback Points

- Shared tool classification affects foreground activity tracking, background activity tracking, repeated mutation failure tracking, and completion guard behavior. The existing tests for those paths are the primary regression signal.
- If the refactor changes behavior for a non-`apply_patch` tool, restore the explicit existing branches and keep only the additive `apply_patch` classification.

## Completion Record

- Implemented the shared `apply_patch` classification and removed the duplicate completion-guard classifier.
- Regression coverage verifies `apply_patch` acceptance and preserves read-only, unknown, and MCP classification.
- Validation passed: focused completion-guard tests (14/14), `npm test` (991/991), `git diff --check`, and diagnostics on all changed files.
- A workspace LSP sweep found 54 pre-existing diagnostics in seven untouched files; this task introduced none.
- No code-spec update was needed: the existing code-reuse and cross-layer guides already prescribe the single shared-classifier approach applied here.
