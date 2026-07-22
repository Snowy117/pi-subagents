# Technical Design

## Boundary

Mutation detection is owned by `src/runs/shared/long-running-guard.ts`. It is consumed by:

- foreground event processing (`single-attempt-events.ts`),
- background streaming (`run-pi-streaming.ts`),
- background progress/escalation (`runner-ops-step-updates.ts`), and
- completion guard message inspection (`completion-guard.ts`).

All four consumers should use the same tool classification contract.

## Change

Extend `isMutatingTool()` so the built-in `apply_patch` tool is classified alongside `edit` and `write`. Update `hasMutationToolCall()` to delegate each assistant tool call to `isMutatingTool()` instead of maintaining a second `edit`/`write` check plus bash special case.

The shared function remains conservative for unknown tools and only treats `bash` as mutating when its command matches the existing mutation patterns. This preserves MCP behavior and avoids broadening the trust boundary.

## Data Flow

`tool_execution_start` or assistant `toolCall` → shared `isMutatingTool(toolName, args)` → `observedMutationAttempt` / completion guard result → normal successful completion.

The tool arguments are not interpreted for `apply_patch`; the tool name itself is sufficient to establish an attempted mutation, matching the existing `edit` and `write` contract.

## Compatibility / Rollback

This is additive for `apply_patch` and a deduplication of equivalent existing logic. Existing callers retain their behavior. Rollback is limited to reverting the shared classification and the focused regression test if an integration reveals a tool-name collision.
