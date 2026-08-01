/** task: simplify-subagent-params — Phase 2: Foreground execution cleanup.
 *
 * Remove acceptance references from foreground execution files.
 * These files are NOT deleted — they are kept but imports of/from acceptance.ts
 * must be removed.
 *
 * Files to edit:
 * 1. src/runs/foreground/execution/run-sync.ts
 *    - Remove imports: acceptanceFailureMessage, evaluateAcceptance, formatAcceptancePrompt, resolveEffectiveAcceptance
 *    - Remove: taskWithAcceptance, effectiveAcceptance, acceptancePrompt variables
 *    - Remove: result.acceptance = ..., acceptanceFailure, acceptanceCanFailRun
 *    - Remove: stripAcceptanceReportsFromMessages result call
 *    - Remove: buildSkippedAcceptanceLedger usage
 *    - Remove: shareEnabled variable
 * 2. src/runs/foreground/execution/attempt-helpers.ts
 *    - Remove: acceptanceOutputByResult, buildSkippedAcceptanceLedger, stripAcceptanceReportsFromMessages
 *    - Remove: AcceptanceLedger, ResolvedAcceptanceConfig imports
 * 3. src/runs/foreground/execution/single-attempt-process.ts
 *    - Remove: stripAcceptanceReport import and usage
 * 4. src/runs/foreground/execution/single-attempt-finalize.ts
 *    - Remove: acceptanceOutputByResult import, stripAcceptanceReport import and usage
 * 5. src/runs/foreground/executor/single-path.ts
 *    - Remove: ChainClarifyComponent, ChainClarifyResult imports
 *    - Remove: params.clarify check, clarify UI block, runInBackground branch
 *    - Remove: resolveStepBehavior, resolveEffectiveToolBudget, buildStepBehavior
 *    - Remove: params.share, shareEnabled references
 * 6. src/runs/foreground/executor/parallel-path.ts
 *    - Remove: ChainClarifyComponent, ChainClarifyResult imports
 *    - Remove: clarify TUI logic
 * 7. src/runs/foreground/executor/parallel-path-helpers.ts
 *    - Remove: ParallelClarifyBackgroundState, dispatchParallelBackgroundFromClarify
 *    - Remove: acceptance field from task construction
 * 8. src/runs/foreground/executor/parallel-tasks.ts
 *    - Remove: acceptance passing, buildChainInstructions, ChainStep usage
 * 9. src/runs/foreground/executor/single-path-helpers.ts
 *    - Remove: acceptance, acceptanceContext from buildSingleRunSyncOptions
 * 10. src/runs/foreground/executor/async-path.ts
 *    - Remove: hasChain branches, ChainStep imports
 *    - Remove: wrapChainTasksForFork, collectChainSessionFiles, collectChainThinkingOverrides
 *    - Remove: acceptance, toolBudget, turnBudget, timeoutMs passing
 * 11. src/runs/foreground/executor/async-resume.ts
 *    - Remove: agentScope resolution, acceptance passing
 * 12. src/runs/foreground/executor/validation.ts
 *    - Remove: validateExecutionAcceptance, validateExecutionChainBindings
 *    - Remove: ChainOutputValidationError, validateChainOutputBindingsWithContext import
 *    - Remove: validateAcceptanceInput import
 *    - Simplify validateExecutionInput to tasks-only
 * 13. src/runs/foreground/executor/prepare-execution.ts
 *    - Remove: agentScope resolution, cwd override, sessionDir override
 *    - Remove: control override resolution, foregroundTimeout/turnBudget/toolBudget
 *    - Remove: hasSingle, hasChain, chainBindingsError, allowClarifyTaskPrompt
 *    - Remove: backgroundRequestedWhileClarifying, validateExecutionAcceptance
 * 14. src/runs/foreground/executor/fork-helpers.ts
 *    - Remove: wrapChainTasksForFork, collectChainSessionFiles, collectChainThinkingOverrides
 * 15. src/runs/foreground/executor/intercom-result.ts
 *    - Remove: acceptance references
 * 16. src/runs/foreground/executor/budget-resolution.ts
 *    - Remove: resolveToolBudget, resolveTurnBudget, resolveForegroundTimeout
 *    - Keep: AgentDefaultContextPolicy resolution, shouldForkAgent
 * 17. src/runs/shared/result-intercom.ts
 *    - Remove: acceptance fields
 * 18. src/runs/shared/nested-events.ts
 *    - Remove: acceptance related fields
 * 19. src/runs/shared/workflow-graph.ts
 *    - Remove: acceptanceStatus from WorkflowGraphNode
 * 20. src/agents/agent-scope.ts
 *    - Hardcode to "both", remove resolveExecutionAgentScope
 * 21. src/agents/agent-management.ts
 *    - Remove chainName handling
 * 22. src/agents/agent-management/handlers-create-update.ts
 *    - Remove chain-serializer import
 * 23. src/agents/agents/loading.ts
 *    - Remove chain-serializer import
 * 24. src/extension/doctor.ts
 *    - Remove sessionDir override reference
 * 25. src/extension/config.ts
 *    - Remove chain.dynamicFanout config
 * 26. src/shared/settings.ts
 *    - Remove ChainStep, SequentialStep, isParallelStep, isDynamicParallelStep, etc.
 * 27. src/slash/commands/execution-commands.ts
 *    - Remove chain-related commands
 * 28. src/slash/commands/completions.ts
 *    - Remove chain completions
 * 29. src/slash/commands/inline-config.ts
 *    - Remove chain-related config keys
 * 30. src/extension/registration/tools.ts
 *    - Remove chain-related tool registration
 * 31. src/runs/background/runner/ops/runner-ops-results.ts
 *    - Remove chain-append imports
 * 32. Background runner files (run-single-step.ts, run-single-step-helpers.ts, runner-step-dynamic.ts, runner-dynamic-collection.ts, runner-step-sequential.ts, runner-step-parallel.ts, runner-finalize.ts, runner-parallel-collection.ts, runner-ops.ts, runner-ops-status.ts, runner-ops-step-updates.ts)
 *    - Remove acceptance references
 * 33. src/runs/background/async-execution/single-execution.ts
 *    - Remove resolveEffectiveAcceptance import and usage
 * 34. src/runs/background/async-execution/step-building.ts
 *    - Remove resolveEffectiveAcceptance import and usage
 *    - Remove ChainOutputValidationError, validateChainOutputBindings import
 * 35. src/runs/background/async-execution/types.ts
 *    - Remove ImportedAsyncRoot import from chain-root-attachment
 * 36. src/runs/background/completion-batcher.ts
 *    - Verify no acceptance references
 * 37. src/runs/background/chain-append.ts
 *    - Delete (truly chain-specific)
 * 38. src/runs/background/runner/share-export.ts
 *    - Already deleted
 * 39. Update all barrel files that re-export from deleted modules
 */