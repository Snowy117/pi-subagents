# Design: Simplify Subagent Params

## Overview

This task removes ~9 major feature groups from the subagent dispatch system: chain, clarify, share, acceptance, budget/timeout overrides, cwd override, sessionDir override, `agent`/`task` top-level params (replaced by `tasks` only), `control` override, `output`/`outputMode`/`reads` overrides, `agentScope` override, `runId`/`dir` aliases, and all associated code.

The result: a clean dispatch API with 16 top-level parameters, `TaskItem` with 6 fields, and all configuration-driven defaults read from agent config only.

## Design Principles

1. **Config-driven, not dispatch-driven**: All runtime behavior (budget, timeout, cwd, output, control, acceptance) comes from agent config or system defaults. Dispatch only says *what* to run, not *how*.
2. **One mode to rule them all**: `tasks: [{agent, task}]` replaces `agent`/`task` for single runs. A single task is just a parallel with n=1.
3. **Delete, don't neuter**: A removed feature's code is deleted, not commented out or conditionally skipped. This keeps the codebase clean and auditable.
4. **No dangling imports**: Every file that imported a deleted module must be updated. Use `lsp_diagnostics path="*"` to catch all of them.

## Execution Phases

### Phase 0: Schema & Types

**Files to modify:**
- `src/extension/schemas/blocks.ts` — Remove all chain/acceptance/budget/output overrides. Keep only: `SkillOverride`, `ControlOverrides` (if kept), `TaskItem` (simplified)
- `src/extension/schemas/subagent-params.ts` — Reduce to 16 parameters
- `src/runs/foreground/executor/types.ts` — Simplify `SubagentParamsLike`, `TaskParam`, `ExecutionContextData`
- `src/shared/types/options-types.ts` — Remove `acceptance`, `acceptanceContext`, `outputMode`, `share`, `structuredOutput`, `persistentChildren` (if not needed)
- `src/shared/types/result-types.ts` — Remove `AcceptanceLedger`, `acceptance`, `acceptanceStatus`, `ChainOutputMap`, `WorkflowGraphNode`, `outputMode`, `savedOutputPath`, `savedOutputReference`, `truncation`, `transcriptPath`, `transcriptError`, `artifactPaths`, `progressSummary`, `modelAttempts`, `attemptedModels`, `structuredOutput`, `structuredOutputPath`, `structuredOutputSchemaPath`, `sessionFile`, `completionGuardTriggered`, `intercomTarget`, `skills`, `skillsWarning`, `turnBudget`, `toolBudget`, `progress`, `controlEvents`, `chainOutputs`, `outputReference`, `residentChild`, `detached`, `interrupted`, `wrapUpRequested`
- `src/shared/types/async-types.ts` — Remove `acceptance`, `...`
- `src/runs/background/async-execution/types.ts` — Remove `acceptance`
- `src/runs/background/runner/types.ts` — Remove `acceptance`
- `src/extension/tool-description.ts` — Remove all removed-parameter descriptions

**New `TaskItem` schema:**
```typescript
export const TaskItem = Type.Object({
  agent: Type.String(),
  task: Type.String(),
  count: Type.Optional(Type.Integer({ minimum: 1 })),
  progress: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String()),
  skill: Type.Optional(SkillOverride),
});
```

**New `SubagentParams` schema (16 parameters):**
```typescript
const SubagentParamsSchema = Type.Object({
  // Management/control
  action: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  index: Type.Optional(Type.Integer({ minimum: 0 })),
  view: Type.Optional(Type.String({ enum: ["fleet", "transcript"] })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  message: Type.Optional(Type.String()),
  config: Type.Optional(Type.Unsafe({ anyOf: [{ type: "object" }, { type: "string" }] })),
  
  // Scheduling
  schedule: Type.Optional(Type.String()),
  scheduleName: Type.Optional(Type.String()),
  
  // Execution
  tasks: Type.Optional(Type.Array(TaskItem)),
  concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
  worktree: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.String({ enum: ["fresh", "fork"] })),
  async: Type.Optional(Type.Boolean()),
  artifacts: Type.Optional(Type.Boolean()),
  includeProgress: Type.Optional(Type.Boolean()),
});
```

### Phase 1: Delete Chain + Clarify + Acceptance directories

**Delete:**
- `src/runs/foreground/chain-execution/` (entire directory)
- `src/runs/foreground/chain-clarify/` (entire directory)
- `src/runs/shared/acceptance/` (entire directory)

**Delete individual files:**
- `src/runs/foreground/executor/chain-path.ts`
- `src/runs/background/async-execution/chain-execution.ts`
- `src/runs/background/chain-root-attachment.ts`
- `src/runs/background/chain-append.ts`
- `src/runs/shared/chain-outputs.ts`
- `src/runs/shared/acceptance.ts`
- `src/runs/background/runner/share-export.ts`
- `src/shared/settings/chain-directories.ts`
- `src/shared/settings/chain-instructions.ts`
- `src/shared/settings/chain-templates.ts`
- `src/shared/settings/chain-types.ts`
- `src/shared/settings/step-behavior.ts`
- `src/shared/types/acceptance-types.ts`
- `src/agents/chain-serializer.ts`
- `src/slash/commands/chain-expression.ts`
- `src/slash/commands/chain-steps.ts`

### Phase 2: Clean Foreground Execution

**`single-path.ts`**: Remove clarify TUI logic, acceptance passing, chain-related vars. Simplify to pure `tasks[0]` dispatch.

**`parallel-path.ts`**: Remove clarify TUI, acceptance passing. Simplify.

**`parallel-path-helpers.ts`**: Remove `ParallelClarifyBackgroundState`, `dispatchParallelBackgroundFromClarify`, acceptance fields.

**`parallel-tasks.ts`**: Remove acceptance passing, `buildChainInstructions`, `ChainStep` usage.

**`async-path.ts`**: Remove chain routing (the `hasChain` branches), acceptance passing. Only keep async single + parallel paths.

**`async-resume.ts`**: Remove acceptance passing, `agentScope` resolution.

**`prepare-execution.ts`**: Remove `agentScope` resolution, `cwd` override, `sessionDir` override, `control` override resolution, acceptance validation, chain-related logic. `effectiveCwd` becomes `ctx.cwd` always.

**`validation.ts`**: Remove `validateExecutionAcceptance`, chain validation logic (`validateExecutionChainBindings`). Only keep agent validation for `tasks[].agent`.

**`chain-append.ts`**: Delete (entire file, chain removal).

**`budget-resolution.ts`**: Remove `resolveToolBudget`, `resolveTurnBudget`, `resolveForegroundTimeout` (if only used for dispatch overrides). Keep only `AgentDefaultContextPolicy` resolution, `shouldForkAgent`.

**`foreground-state.ts`**: Remove acceptance/chain-related state tracking.

**`intercom-result.ts`**: Remove acceptance references.

**`fork-helpers.ts`**: Remove `wrapChainTasksForFork`, `collectChainSessionFiles`, `collectChainThinkingOverrides`.

### Phase 3: Clean Background Runner

**`run-sync.ts`** (foreground execution): Remove acceptance evaluation, `formatAcceptancePrompt`, `buildSkippedAcceptanceLedger`, `stripAcceptanceReportsFromMessages`, `acceptanceOutputByResult`. Remove `shareEnabled` logic.

**`attempt-helpers.ts`**: Remove `acceptanceOutputByResult`, `buildSkippedAcceptanceLedger`, `stripAcceptanceReportsFromMessages`.

**`run-single-step.ts`** (background): Remove `evaluateAcceptance`, `formatAcceptancePrompt`, `stripAcceptanceReport`, `acceptanceFailureMessage`. Remove `skipAcceptance` from context. Remove `acceptance` from return type.

**`run-single-step-helpers.ts`**: Remove `acceptance` field from result builder, `skipAcceptance` logic.

**`runner-step-dynamic.ts`**: Remove `evaluateAcceptance`, `aggregateAcceptanceReport`, `acceptanceFailureMessage`, `markDynamicGraphGroup` acceptance.

**`runner-dynamic-collection.ts`**: Remove acceptance logic entirely.

**`runner-step-sequential.ts`**: Remove `acceptance` field from results.

**`runner-step-parallel.ts`**: Remove `acceptance` field from results.

**`runner-finalize.ts`**: Remove `acceptance` field.

**`runner-parallel-collection.ts`**: Remove `acceptance` field.

**`runner-ops.ts`**: Remove `AcceptanceLedger` import, `markDynamicGraphGroup` acceptance param.

**`runner-ops-status.ts`**: Remove `acceptanceStatus` field.

**`runner-ops-step-updates.ts`**: Remove `stripAcceptanceReport`.

**`completion-batcher.ts`**: Check for acceptance references (likely none).

### Phase 4: Clean Shared Utilities

**`single-output.ts`**: Remove `outputMode` references if not needed.

**`tool-budget.ts`**: Remove if no longer used by dispatch (but keep if agent config still uses it).

**`turn-budget.ts`**: Same as tool-budget.

**`nested-events.ts`**: Remove `acceptance` related fields.

**`workflow-graph.ts`**: Remove `acceptanceStatus` from `WorkflowGraphNode`.

**`result-intercom.ts`**: Remove acceptance fields.

### Phase 5: Clean Extension Layer

**`tool-description.ts`**: Update both `FULL_SUBAGENT_TOOL_DESCRIPTION` and `COMPACT_SUBAGENT_TOOL_DESCRIPTION`:
- Remove CHAIN mode description entirely
- Remove CHAIN TEMPLATE VARIABLES section
- Remove `timeoutMs`/`maxRuntimeMs` from description
- Remove `context`, `clarify`, `share`, `sessionDir`, `acceptance` descriptions
- Simplify EXECUTION section to only SINGLE (via `tasks:[{agent,task}]`) and PARALLEL
- Remove chain-related safety guidance
- Update `append-step` to mention it's removed (or remove the mention)

**`config.ts`**: Remove `resolvePersistentChildConfig`, `chain.dynamicFanout` config.

**`doctor.ts`**: Remove `sessionDir` override reference.

**`registration/tools.ts`**: Remove chain-related tool registration.

### Phase 6: Agent Layer

**`agent-management.ts`**: Remove `chainName` handling.

**`chain-serializer.ts`**: Already deleted.

**`agents.ts`**: Remove chain-related types.

**`agent-scope.ts`**: Hardcode to `"both"`, remove `resolveExecutionAgentScope`.

### Phase 7: Slash Commands

**`src/slash/commands/chain-expression.ts`**: Delete.
**`src/slash/commands/chain-steps.ts`**: Delete.
**`src/slash/commands/execution-commands.ts`**: Remove chain-related commands.
**`src/slash/commands/completions.ts`**: Remove chain completions.
**`src/slash/commands/inline-config.ts`**: Remove chain-related config keys.

### Phase 8: Clean Agent Config / Settings

**`src/shared/settings.ts`**: Remove `ChainStep`, `SequentialStep`, `isParallelStep`, `isDynamicParallelStep`, `getStepAgents`, `resolveStepBehavior`, `buildChainInstructions`, `StepOverrides`, `taskDisallowsFileUpdates`, `chain` config fields.

### Phase 9: Re-export & Index Files

Update all `index.ts` / barrel files that re-export from deleted modules.

## Detailed Change: `SubagentParamsLike` → `DispatchParams`

```typescript
export interface DispatchParams {
  action?: string;
  id?: string;
  index?: number;
  view?: "fleet" | "transcript";
  lines?: number;
  message?: string;
  schedule?: string;
  scheduleName?: string;
  config?: unknown;
  tasks?: TaskParam[];
  concurrency?: number;
  worktree?: boolean;
  context?: "fresh" | "fork";
  async?: boolean;
  artifacts?: boolean;
  includeProgress?: boolean;
  // Legacy: only for backward compat in the tool description
  // Internally, agent/task are converted to tasks[0]
}

export interface TaskParam {
  agent: string;
  task: string;
  count?: number;
  progress?: boolean;
  model?: string;
  skill?: string | string[] | boolean;
}
```

## Detailed Change: Execution Flow

### Before (simplified):
```
dispatch({agent, task, chain, tasks, timeout, budget, control, clarify, ...})
  → determine mode (single/chain/parallel)
  → chain path: chain-execution/
  → single path: single-path.ts → run-sync.ts (acceptance eval)
  → parallel path: parallel-path.ts → parallel-tasks.ts
```

### After:
```
dispatch({tasks: [{agent, task}], ...})
  → always parallel path (single = parallel with n=1)
  → single task: single-path.ts → run-sync.ts (no acceptance)
  → multiple tasks: parallel-path.ts → parallel-tasks.ts
```

## Detailed Change: `prepare-execution.ts`

Major simplifications:
- Remove `effectiveParams.cwd` override → always use `ctx.cwd`
- Remove `scope: AgentScope` → hardcode `"both"`
- Remove `shareEnabled` → always `false`
- Remove `effectiveParams.control` → always use `deps.config.control`
- Remove `effectiveParams.sessionDir` → always use `deps.config.defaultSessionDir`
- Remove `effectiveParams.chain` → no chain validation
- Remove `effectiveParams.agent` → no single mode detection
- Remove `hasSingle`, `hasChain` → only `hasTasks`
- Remove `foregroundTimeout`, `turnBudget`, `runToolBudget`, `configToolBudget` resolution
- Remove `chainBindingsError` validation
- Remove `allowClarifyTaskPrompt`
- Remove `backgroundRequestedWhileClarifying`
- `foregroundMode` is always `"parallel"` (or tasks.length === 1 → "single" for display)

## Detailed Change: `validateExecutionInput`

```typescript
export function validateExecutionInput(
  params: DispatchParams,
  agents: AgentConfig[],
): AgentToolResult<Details> | null {
  if (!params.tasks || params.tasks.length === 0) {
    return {
      content: [{ type: "text", text: "tasks is required with at least one entry." }],
      isError: true,
      details: { mode: "single", results: [] },
    };
  }
  for (let i = 0; i < params.tasks.length; i++) {
    const task = params.tasks[i]!;
    if (!task.agent) {
      return {
        content: [{ type: "text", text: `tasks[${i}].agent is required.` }],
        isError: true,
        details: { mode: "single", results: [] },
      };
    }
    if (!task.task && task.task !== "") {
      return {
        content: [{ type: "text", text: `tasks[${i}].task is required.` }],
        isError: true,
        details: { mode: "single", results: [] },
      };
    }
    if (!agents.find((a) => a.name === task.agent)) {
      return {
        content: [{ type: "text", text: `Unknown agent: ${task.agent} (task ${i + 1})` }],
        isError: true,
        details: { mode: "single", results: [] },
      };
    }
  }
  return null;
}
```

## Detailed Change: `run-sync.ts`

Major simplifications:
- Remove `resolveEffectiveAcceptance`, `formatAcceptancePrompt`, `acceptanceFailureMessage`, `evaluateAcceptance` imports
- Remove `taskWithAcceptance` (no acceptance prompt to append)
- Remove `acceptanceOutputByResult`, `buildSkippedAcceptanceLedger`, `stripAcceptanceReportsFromMessages` usage
- Remove `result.acceptance = ...` block
- Remove `acceptanceFailure` and `acceptanceCanFailRun` logic
- Remove `shareEnabled` / `sessionEnabled` / `share` logic
- Remove `invokeOutputPathSystemPrompt` (if acceptance was the only consumer)
- Result: straightforward model-candidate loop with acceptance-free output

## Detailed Change: `run-single-step.ts` (background)

Major simplifications:
- Remove `formatAcceptancePrompt`, `stripAcceptanceReport`, `acceptanceFailureMessage`, `evaluateAcceptance` imports
- Remove `step.effectiveAcceptance` check and acceptance prompt injection
- Remove `ctx.skipAcceptance` checks
- Remove `stripAcceptanceReport(rawOutput)` → output is used directly
- Remove `outputForAcceptance` / `outputForPersistence` split
- Remove the entire acceptance evaluation block
- Remove `timedOutAfterAcceptance`, `turnBudgetExceeded`, `acceptanceCanFailRun` logic
- Simplify return type to remove `acceptance` field

## Detailed Change: `single-path.ts`

Major simplifications:
- Remove clarify TUI import (`ChainClarifyComponent`, `ChainClarifyResult`)
- Remove `params.clarify` check and clarify UI code block
- Remove `params.share`, `shareEnabled` from data
- Remove `buildStepBehavior` call (acceptance-only)
- Remove `resolveEffectiveToolBudget` call (if removed)
- Result: direct `runSync` call with simplified options

## Detailed Change: `async-path.ts`

Major simplifications:
- Remove both `hasChain` branches entirely
- Keep only `hasTasks` (parallel) and `hasSingle` (convert to tasks[0])
- Remove all `ChainStep` imports and usage
- Remove `chain` from `executeAsyncChain` calls
- Remove `wrapChainTasksForFork`, `collectChainSessionFiles`, `collectChainThinkingOverrides`
- Remove `acceptance` passing
- Remove `toolBudget`/`turnBudget`/`configToolBudget`/`timeoutMs` passing

## Risk Mitigation

1. **Compilation errors from dangling imports**: Use `lsp_diagnostics path="*"` after each phase to catch all errors. Fix them before moving to the next phase.
2. **Missed acceptance code paths**: The acceptance feature is deeply integrated. After Phase 1 (delete directories), every file that imports from deleted modules will show up as LSP errors. Triage systematically.
3. **Backward compatibility**: The `agent`/`task` removal is a breaking API change. The tool description must clearly document the new `tasks:[{agent,task}]` pattern.
4. **Large scope**: Split into sub-tasks if needed. Phase 0 (schema/types) can be done first, then phases 1-3 (deletion), then phases 4-9 (cleanup).

## Testing Strategy

After all changes:
1. `lsp_diagnostics path="*"` — must be clean
2. `npm test` — unit tests must pass
3. Verify the tool schema is correct by checking the extension loads
4. Manual functional test: `subagent({ tasks: [{agent: "coder", task: "hello"}] })`

## Acceptance Criteria (from PRD)

### Schema / Types
- [ ] 16 top-level parameters only
- [ ] `TaskItem` has 6 fields only
- [ ] `blocks.ts` cleaned of all removed schemas
- [ ] `SubagentParamsLike` simplified
- [ ] `RunSyncOptions` cleaned
- [ ] `SingleResult` cleaned of acceptance fields
- [ ] All chain types removed

### Deletion
- [ ] chain-execution/ directory deleted
- [ ] chain-clarify/ directory deleted
- [ ] acceptance/ directory deleted
- [ ] All listed files deleted
- [ ] No dangling imports

### Functionality
- [ ] Compiles cleanly
- [ ] Single task via `tasks:[{agent,task}]` works
- [ ] Parallel tasks work
- [ ] Action management works
- [ ] Async works
- [ ] Schedule works