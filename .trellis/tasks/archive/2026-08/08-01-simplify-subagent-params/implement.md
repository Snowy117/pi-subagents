# Implementation Plan: Simplify Subagent Params

## Overview

Large-scale parameter cleanup across the entire codebase. The work is split into 4 phases, each independently verifiable via `lsp_diagnostics path="*"`.

## Phase Order & Dependencies

Phase 0 (Schema) must go first — all other phases depend on the new types.
Phase 1 (Deletion) removes directories/files — run after Phase 0 so LSP catches dangling imports.
Phase 2 (Foreground Logic) depends on Phases 0+1.
Phase 3 (Background Logic) depends on Phases 0+1.

Within each phase, file order matters: edit leaf files (types, schemas) before their consumers.

## Phase 0: Schema & Types Cleanup

### 0.1 `blocks.ts` — Simplify schema definitions
- Remove: `ChainItem`, `AcceptanceOverride`, `TurnBudgetOverride`, `ToolBudgetOverride`, `ToolBudgetBlock`, `DynamicExpandSchema`, `DynamicCollectSchema`, `DynamicParallelTemplateSchema`, `ParallelTaskSchema`, `OutputOverride`, `OutputModeOverride`, `ReadsOverride`
- Simplify `TaskItem` to 6 fields: `agent`, `task`, `count`, `progress`, `model`, `skill`
- Keep: `SkillOverride`, `JsonSchemaObject`, `ControlOverrides`
- Remove `ControlOverrides` if only used for dispatch override (check callers)

### 0.2 `subagent-params.ts` — Reduce to 16 parameters
- Remove: `agent`, `task`, `chain`, `chainDir`, `chainName`, `runId`, `dir`, `timeoutMs`, `maxRuntimeMs`, `turnBudget`, `toolBudget`, `cwd`, `clarify`, `share`, `sessionDir`, `control`, `output`, `outputMode`, `agentScope`, `skill`, `model`, `acceptance`
- Keep only: `action`, `id`, `index`, `view`, `lines`, `message`, `schedule`, `scheduleName`, `config`, `tasks`, `concurrency`, `worktree`, `context`, `async`, `artifacts`, `includeProgress`

### 0.3 `types.ts` (executor) — Simplify
- `SubagentParamsLike`: remove all removed params, rename to `DispatchParams` (or keep name)
- `TaskParam`: remove `cwd`, `output`, `outputMode`, `reads`, `toolBudget`, `acceptance`
- `ExecutionContextData`: remove `shareEnabled`, `backgroundRequestedWhileClarifying`, `timeoutMs`, `deadlineAt`, `turnBudget`, `toolBudget`, `configToolBudget`

### 0.4 `options-types.ts` — Remove acceptance types
- Remove `acceptance`, `acceptanceContext`, `share`, `outputMode`, `outputPath`, `structuredOutput`
- Simplify `RunSyncOptions`

### 0.5 `result-types.ts` — Remove all acceptance fields
- Remove `AcceptanceLedger`, `acceptance`, `acceptanceStatus`, `ChainOutputMap`, `WorkflowGraphNode`, `outputMode`, `savedOutputPath`, `savedOutputReference`, `truncation`, `transcriptPath`, `transcriptError`, `artifactPaths`, `progressSummary`, `modelAttempts`, `attemptedModels`, `structuredOutput`, `structuredOutputPath`, `structuredOutputSchemaPath`, `sessionFile`, `completionGuardTriggered`, `intercomTarget`, `skills`, `skillsWarning`, `turnBudget`, `toolBudget`, `progress`, `controlEvents`, `chainOutputs`, `outputReference`, `residentChild`, `detached`, `interrupted`, `wrapUpRequested`

### 0.6 `async-types.ts` — Remove acceptance
- Remove `acceptance` field from `SubagentState`, `NestedRunSummary`, `PublicNestedRunSummary`

### 0.7 `async-execution/types.ts` — Remove acceptance
- Remove `acceptance` from `AsyncChainParams`, `AsyncSingleParams`

### 0.8 `runner/types.ts` — Remove acceptance
- Remove `acceptance` from `SingleStepContext`, `RunPiStreamingResult`, `SingleStepResult`

### 0.9 `tool-description.ts` — Update both descriptions
- Remove CHAIN mode, CHAIN TEMPLATE VARIABLES, budget/timeout/clarify/share/acceptance mentions
- Update EXECUTION to only SINGLE (`tasks:[{agent,task}]`) and PARALLEL
- Update `append-step` mention

## Phase 1: Delete Directories & Files

### 1.1 Delete directories
```bash
rm -rf src/runs/foreground/chain-execution/
rm -rf src/runs/foreground/chain-clarify/
rm -rf src/runs/shared/acceptance/
```

### 1.2 Delete individual files
```bash
rm src/runs/foreground/executor/chain-path.ts
rm src/runs/background/async-execution/chain-execution.ts
rm src/runs/background/chain-root-attachment.ts
rm src/runs/background/chain-append.ts
rm src/runs/shared/chain-outputs.ts
rm src/runs/shared/acceptance.ts
rm src/runs/background/runner/share-export.ts
rm src/shared/settings/chain-directories.ts
rm src/shared/settings/chain-instructions.ts
rm src/shared/settings/chain-templates.ts
rm src/shared/settings/chain-types.ts
rm src/shared/settings/step-behavior.ts
rm src/shared/types/acceptance-types.ts
rm src/agents/chain-serializer.ts
rm src/slash/commands/chain-expression.ts
rm src/slash/commands/chain-steps.ts
```

### 1.3 Fix all dangling imports (LSP-driven)
After deletion, run `lsp_diagnostics path="*"` and fix every error.

## Phase 2: Foreground Logic Cleanup

### 2.1 `single-path.ts`
- Remove `ChainClarifyComponent`, `ChainClarifyResult` imports
- Remove `params.clarify` check and clarify UI block
- Remove `params.share`, `shareEnabled` references
- Remove `resolveStepBehavior` call
- Remove `resolveEffectiveToolBudget` call
- Remove `buildStepBehavior` import
- Simplify to direct `runSync` call

### 2.2 `parallel-path.ts`
- Remove clarify TUI logic
- Remove acceptance passing

### 2.3 `parallel-path-helpers.ts`
- Remove `ParallelClarifyBackgroundState`, `dispatchParallelBackgroundFromClarify`
- Remove `acceptance` field from task construction

### 2.4 `parallel-tasks.ts`
- Remove `acceptance` passing
- Remove `buildChainInstructions`, `ChainStep` usage

### 2.5 `async-path.ts`
- Remove both `hasChain` branches entirely
- Remove `ChainStep` imports
- Remove `wrapChainTasksForFork`, `collectChainSessionFiles`, `collectChainThinkingOverrides`
- Remove `acceptance`, `toolBudget`, `turnBudget`, `timeoutMs` passing

### 2.6 `async-resume.ts`
- Remove `agentScope` resolution
- Remove `acceptance` passing

### 2.7 `prepare-execution.ts`
- Remove `agentScope` resolution
- Remove `cwd` override → always `ctx.cwd`
- Remove `sessionDir` override → always from config
- Remove `control` override → always from config
- Remove `foregroundTimeout`, `turnBudget`, `runToolBudget`, `configToolBudget`
- Remove `hasSingle`, `hasChain` → only `hasTasks`
- Remove `chainBindingsError` validation
- Remove `allowClarifyTaskPrompt`, `backgroundRequestedWhileClarifying`
- Remove `validateExecutionAcceptance` call

### 2.8 `validation.ts`
- Remove `validateExecutionAcceptance`
- Remove `validateExecutionChainBindings`
- Remove chain validation logic
- Simplify `validateExecutionInput` to tasks-only

### 2.9 `chain-append.ts` — Already deleted in Phase 1

### 2.10 `budget-resolution.ts`
- Remove `resolveToolBudget`, `resolveTurnBudget`, `resolveForegroundTimeout`
- Keep `AgentDefaultContextPolicy` resolution, `shouldForkAgent`

### 2.11 `foreground-state.ts`
- Remove acceptance/chain-related state tracking

### 2.12 `intercom-result.ts`
- Remove acceptance references

### 2.13 `fork-helpers.ts`
- Remove `wrapChainTasksForFork`, `collectChainSessionFiles`, `collectChainThinkingOverrides`

## Phase 3: Background Logic Cleanup

### 3.1 `run-sync.ts` (foreground execution)
- Remove acceptance evaluation: `resolveEffectiveAcceptance`, `formatAcceptancePrompt`, `evaluateAcceptance`, `acceptanceFailureMessage`
- Remove `taskWithAcceptance`
- Remove `acceptanceOutputByResult`, `buildSkippedAcceptanceLedger`, `stripAcceptanceReportsFromMessages`
- Remove `result.acceptance = ...` block
- Remove `shareEnabled` / `sessionEnabled` / `share` logic

### 3.2 `attempt-helpers.ts`
- Remove `acceptanceOutputByResult`, `buildSkippedAcceptanceLedger`, `stripAcceptanceReportsFromMessages`
- Remove `AcceptanceLedger`, `ResolvedAcceptanceConfig` imports

### 3.3 `run-single-step.ts` (background)
- Remove `acceptanceFailureMessage`, `evaluateAcceptance`, `formatAcceptancePrompt`, `stripAcceptanceReport` imports
- Remove `step.effectiveAcceptance` check and acceptance prompt injection
- Remove `ctx.skipAcceptance` checks
- Remove `stripAcceptanceReport(rawOutput)` → use output directly
- Remove `outputForAcceptance` / `outputForPersistence` split
- Remove entire acceptance evaluation block
- Simplify return type: remove `acceptance` field

### 3.4 `run-single-step-helpers.ts`
- Remove `acceptance` field from result builder
- Remove `skipAcceptance` logic

### 3.5 `runner-step-dynamic.ts`
- Remove `evaluateAcceptance`, `aggregateAcceptanceReport`, `acceptanceFailureMessage`
- Remove `markDynamicGraphGroup` acceptance param

### 3.6 `runner-dynamic-collection.ts`
- Remove acceptance logic entirely

### 3.7 `runner-step-sequential.ts`
- Remove `acceptance` field from results

### 3.8 `runner-step-parallel.ts`
- Remove `acceptance` field from results

### 3.9 `runner-finalize.ts`
- Remove `acceptance` field

### 3.10 `runner-parallel-collection.ts`
- Remove `acceptance` field

### 3.11 `runner-ops.ts`
- Remove `AcceptanceLedger` import
- Remove `markDynamicGraphGroup` acceptance param

### 3.12 `runner-ops-status.ts`
- Remove `acceptanceStatus` field

### 3.13 `runner-ops-step-updates.ts`
- Remove `stripAcceptanceReport`

## Phase 4: Verification

### 4.1 `lsp_diagnostics path="*"` — must be clean
### 4.2 `npm test` — unit tests must pass
### 4.3 Manual verification

## Files NOT modified (but verify no dangling refs)
- `src/shared/settings.ts` — remove `ChainStep`, `SequentialStep`, `isParallelStep`, `isDynamicParallelStep`, `getStepAgents`, `resolveStepBehavior`, `buildChainInstructions`, `StepOverrides`, `taskDisallowsFileUpdates`, `chain` config fields
- `src/extension/config.ts` — remove `resolvePersistentChildConfig`, `chain.dynamicFanout`
- `src/extension/doctor.ts` — remove `sessionDir` override reference
- `src/extension/registration/tools.ts` — remove chain-related tool registration
- `src/agents/agent-management.ts` — remove `chainName` handling
- `src/agents/agent-scope.ts` — hardcode to `"both"`, remove `resolveExecutionAgentScope`
- `src/agents/agents.ts` — remove chain-related types
- `src/slash/commands/execution-commands.ts` — remove chain-related commands
- `src/slash/commands/completions.ts` — remove chain completions
- `src/slash/commands/inline-config.ts` — remove chain-related config keys
- `src/shared/single-output.ts` — remove `outputMode` references
- `src/shared/tool-budget.ts` — remove if only used by dispatch
- `src/shared/turn-budget.ts` — remove if only used by dispatch
- `src/shared/nested-events.ts` — remove acceptance related fields
- `src/shared/workflow-graph.ts` — remove `acceptanceStatus` from `WorkflowGraphNode`
- `src/runs/shared/result-intercom.ts` — remove acceptance fields
- `src/runs/background/completion-batcher.ts` — verify no acceptance references
- `src/runs/background/async-execution/single-execution.ts` — remove acceptance resolution
- `src/runs/background/async-execution/step-building.ts` — remove acceptance resolution
- `src/runs/foreground/execution/single-attempt-process.ts` — remove `stripAcceptanceReport`
- `src/runs/foreground/execution/single-attempt-finalize.ts` — remove `acceptanceOutputByResult`, `stripAcceptanceReport`