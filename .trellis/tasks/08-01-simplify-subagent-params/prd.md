# Simplify subagent params: comprehensive parameter cleanup

## Goal

从 subagent 派遣参数中移除冗余功能，统一调度模式，精简参数列表、Schema、Tool Description 和底层实现。

## 最终保留的参数

### 保留的顶层参数（16个）

| 参数 | 用途 |
|------|------|
| `action` | 管理操作（list/get/create/update/delete/status/interrupt/resume/steer/append-step/schedule/schedule-list/schedule-status/schedule-cancel/doctor） |
| `id` | 运行标识符，用于管理/控制操作（原 `id`/`runId` 合并，只保留 `id`） |
| `index` | 子 agent 索引（用于 parallel/chain 中的定位） |
| `view` | 状态视图：`"fleet"` 或 `"transcript"` |
| `lines` | transcript 行数限制 |
| `message` | resume/steer 的后续消息 |
| `schedule` | 调度时间（`"+10m"` 或 ISO 时间戳） |
| `scheduleName` | 调度显示名称 |
| `config` | agent/chain 配置，用于 create/update |
| `tasks` | 任务数组：`[{agent, task, count?, progress?, model?, skill?}]` |
| `concurrency` | 并行任务并发数 |
| `worktree` | git worktree 隔离 |
| `context` | fork 上下文：`"fresh"` 或 `"fork"` |
| `async` | 后台运行 |
| `artifacts` | 调试产物 |
| `includeProgress` | 结果中包含进度信息 |

### 保留的 TaskItem 字段（6个）

| 字段 | 用途 |
|------|------|
| `agent` | 必填，agent 名称 |
| `task` | 必填，派遣任务 |
| `count` | 重复次数 |
| `progress` | 启用进度追踪 |
| `model` | 模型覆写（如 `"anthropic/claude-sonnet-4"`） |
| `skill` | 技能覆写 |

### 保留的 agent 配置默认值（仅从 config 读取，不可覆写）
- `toolBudget`、`turnBudget`、`timeout`、`cwd`、`sessionDir`、`output`、`outputMode`、`reads`

## 移除的功能项（9大类）

### 1. Chain 支持 — 完整移除
- `chain` 参数（CHAIN mode 顺序步骤）
- `chainDir` 参数（持久化 chain artifact 目录）
- `chainName` 参数（chain 管理操作名称）
- 所有 chain 相关代码：
  - `src/runs/foreground/chain-execution/` 目录
  - `src/runs/foreground/chain-clarify/` 目录
  - `src/runs/foreground/executor/chain-path.ts`
  - `src/runs/background/async-execution/chain-execution.ts`
  - `src/runs/background/chain-root-attachment.ts`
  - `src/runs/background/chain-append.ts`
  - `src/runs/shared/chain-outputs.ts`
  - `src/shared/settings/chain-*.ts`
  - `src/agents/chain-serializer.ts`
  - `src/extension/schemas/blocks.ts` 中的 `ChainItem`、`DynamicExpandSchema`、`DynamicParallelTemplateSchema`、`DynamicCollectSchema`
  - 所有 chain 相关的工具描述、schemas、导入引用

### 2. 预算/超时覆写 — 从派遣参数中移除
- `toolBudget` — 移除，保留 agent config 中的默认值
- `turnBudget` — 移除，保留 agent config 中的默认值
- `timeoutMs` / `maxRuntimeMs` — 移除，保留 agent config 中的默认值

### 3. 工作目录覆写 — 移除
- `cwd` 参数（顶层和 TaskItem 中的 `cwd`）
- 子 agent 统一从父进程继承工作目录，或从 agent config 读取

### 4. Clarify 功能 — 完整移除
- `clarify` 参数
- `ChainClarifyComponent` 及 `src/runs/foreground/chain-clarify/` 整个目录
- `single-path.ts` 中的 clarify TUI 逻辑
- `parallel-path.ts` 中的 clarify TUI 逻辑
- `chain-path.ts` 中的 clarify 逻辑（chain 本身也被移除）

### 5. Share 功能 — 完整移除
- `share` 参数
- `src/runs/background/runner/share-export.ts`
- 所有依赖 share 的代码路径（`exportSessionHtml`、`createShareLink` 等）

### 6. sessionDir 覆写 — 移除
- 顶层 `sessionDir` 参数
- 保留 config 中的 `sessionDir` 作为会话日志目录（仅从 config 读取）

### 7. Acceptance 功能 — 完整移除
- `acceptance` 参数（顶层、TaskItem、ParallelTaskSchema、DynamicParallelTemplateSchema）
- `src/runs/shared/acceptance.ts` 及 `src/runs/shared/acceptance/` 整个目录
- `src/shared/types/acceptance-types.ts`
- `src/runs/foreground/execution/run-sync.ts` 中的 acceptance 逻辑
- `src/runs/foreground/execution/attempt-helpers.ts` 中的 `acceptanceOutputByResult`、`buildSkippedAcceptanceLedger`、`stripAcceptanceReportsFromMessages`
- `src/runs/background/runner/run-single-step.ts` 中的 acceptance 逻辑
- `src/runs/background/runner/run-single-step-helpers.ts` 中的 acceptance 字段
- `src/runs/background/runner/runner-step-dynamic.ts` 中的 acceptance 逻辑
- `src/runs/background/runner/runner-dynamic-collection.ts` 中的 acceptance 逻辑
- `src/runs/background/runner/runner-ops.ts` 中的 acceptance 类型
- `src/runs/background/runner/runner-ops-status.ts` 中的 acceptance 字段
- `src/runs/background/runner/runner-finalize.ts` 中的 acceptance 字段
- `src/runs/background/runner/runner-parallel-collection.ts` 中的 acceptance 字段
- `src/runs/background/runner/types.ts` 中的 acceptance 字段
- `src/runs/background/async-execution/single-execution.ts` 中的 acceptance 解析
- `src/runs/background/async-execution/types.ts` 中的 acceptance 字段
- `src/runs/background/async-execution/step-building.ts` 中的 acceptance 解析
- `src/runs/foreground/executor/async-path.ts` 中的 acceptance 传递
- `src/runs/foreground/executor/parallel-path-helpers.ts` 中的 acceptance 传递
- `src/runs/foreground/executor/parallel-tasks.ts` 中的 acceptance 传递
- `src/runs/foreground/executor/validation.ts` 中的 `validateExecutionAcceptance`
- `src/runs/foreground/executor/chain-append.ts` 中的 acceptance 验证
- `src/runs/foreground/executor/single-path-helpers.ts` 中的 acceptance 传递
- `src/runs/shared/result-intercom.ts` 中的 acceptance 字段
- `src/shared/types/result-types.ts` 中的 `AcceptanceLedger`、`acceptanceStatus`、`acceptance` 字段
- `src/shared/types/options-types.ts` 中的 `acceptance`、`acceptanceContext` 字段
- `src/shared/types/async-types.ts` 中的 `acceptance` 字段
- `src/extension/schemas/blocks.ts` 中的 `AcceptanceOverride`
- `src/extension/schemas/subagent-params.ts` 中的 `acceptance`
- `src/extension/tool-description.ts` 中的 acceptance 描述
- `src/runs/foreground/executor/types.ts` 中的 `TaskParam.acceptance`、`SubagentParamsLike.acceptance`

### 8. 统一调度模式 — 移除 agent/task 顶层参数
- 移除顶层 `agent` 和 `task` 参数
- 所有调度统一通过 `tasks: [{agent, task}]` 实现
- 单 agent 调度：`tasks: [{agent: "coder", task: "..."}]`
- 并行调度：`tasks: [{agent: "coder", task: "..."}, {agent: "reviewer", task: "..."}]`
- 底层 `validateExecutionInput` 中移除 hasSingle 模式检测，只保留 hasTasks

### 9. 其他覆写参数移除
- `control` — 移除，control 配置从 agent config 读取
- `runId` — 移除，仅保留 `id`
- `dir` — 移除（async control 目录，与 cwd 概念重叠）
- `agentScope` — 移除，硬编码为 `"both"`
- `output` — 移除，从 agent config 读取
- `outputMode` — 移除，从 agent config 读取
- `reads` — 从 TaskItem 中移除，从 agent config 读取

## 底层代码清理

### 目录删除
- `src/runs/foreground/chain-execution/` 整个目录
- `src/runs/foreground/chain-clarify/` 整个目录
- `src/runs/shared/acceptance/` 整个目录

### 文件删除
- `src/runs/foreground/executor/chain-path.ts`
- `src/runs/background/async-execution/chain-execution.ts`
- `src/runs/background/chain-root-attachment.ts`
- `src/runs/background/chain-append.ts`
- `src/runs/shared/chain-outputs.ts`
- `src/runs/background/runner/share-export.ts`
- `src/runs/shared/acceptance.ts`
- `src/shared/settings/chain-directories.ts`
- `src/shared/settings/chain-instructions.ts`
- `src/shared/settings/chain-templates.ts`
- `src/shared/settings/chain-types.ts`
- `src/shared/settings/step-behavior.ts`
- `src/shared/types/acceptance-types.ts`
- `src/agents/chain-serializer.ts`
- `src/slash/commands/chain-expression.ts`
- `src/slash/commands/chain-steps.ts`

### 类型清理
- `src/extension/schemas/subagent-params.ts`：移除所有移除的参数，仅保留 16 个顶层参数
- `src/extension/schemas/blocks.ts`：移除 `ChainItem`、`AcceptanceOverride`、`TurnBudgetOverride`、`ToolBudgetOverride`、`ToolBudgetBlock`、`DynamicExpandSchema`、`DynamicCollectSchema`、`DynamicParallelTemplateSchema`、`ParallelTaskSchema`（如果仅 chain 使用）、`OutputOverride`、`OutputModeOverride`、`ReadsOverride`
- `src/runs/foreground/executor/types.ts`：精简 `SubagentParamsLike`、`TaskParam`、`ExecutionContextData`
- `src/shared/types/options-types.ts`：移除 `acceptance`、`acceptanceContext`、`output`、`outputMode`、`share` 等字段
- `src/shared/types/result-types.ts`：移除 `AcceptanceLedger`、`acceptance`、`acceptanceStatus` 等字段
- `src/shared/types/async-types.ts`：移除 `acceptance` 字段
- `src/runs/background/async-execution/types.ts`：移除 `acceptance` 字段
- `src/runs/background/runner/types.ts`：移除 `acceptance` 字段

### 逻辑清理
- `single-path.ts`：移除 clarify TUI 逻辑、acceptance 传递
- `parallel-path.ts`：移除 clarify TUI 逻辑、acceptance 传递
- `parallel-path-helpers.ts`：移除 clarify background state、acceptance 传递
- `parallel-tasks.ts`：移除 acceptance 传递
- `async-path.ts`：移除 chain 路由逻辑、acceptance 传递
- `async-resume.ts`：移除 acceptance 传递
- `prepare-execution.ts`：移除 agentScope 解析、cwd 解析、sessionDir 覆写、control 解析、acceptance 验证
- `validation.ts`：移除 chain 验证逻辑、`validateExecutionAcceptance`
- `chain-append.ts`：移除（整个文件因 chain 移除而删除）
- `run-sync.ts`：移除 acceptance 评估、`formatAcceptancePrompt`、`stripAcceptanceReportsFromMessages`
- `attempt-helpers.ts`：移除 `acceptanceOutputByResult`、`buildSkippedAcceptanceLedger`、`stripAcceptanceReportsFromMessages`
- `run-single-step.ts`：移除 acceptance 评估、`formatAcceptancePrompt`、`stripAcceptanceReport`
- `run-single-step-helpers.ts`：移除 acceptance 字段、`skipAcceptance`
- `runner-step-dynamic.ts`：移除 acceptance 逻辑
- `runner-dynamic-collection.ts`：移除 acceptance 逻辑
- `runner-step-parallel.ts`：移除 acceptance 字段
- `runner-step-sequential.ts`：移除 acceptance 字段
- `runner-finalize.ts`：移除 acceptance 字段
- `runner-parallel-collection.ts`：移除 acceptance 字段
- `runner-ops.ts`：移除 acceptance 类型
- `runner-ops-status.ts`：移除 `acceptanceStatus` 字段
- `runner-ops-step-updates.ts`：移除 `stripAcceptanceReport`
- `completion-batcher.ts`：检查是否引用 acceptance（似乎没有）
- `action-dispatch.ts`：移除 `dir` 处理逻辑、`agentScope` 传递
- `budget-resolution.ts`：移除 `resolveToolBudget`、`resolveTurnBudget`、`resolveForegroundTimeout`（如果仅用于 dispatch 覆写）
- `foreground-state.ts`、`intercom-result.ts`、`fork-helpers.ts`：清理 acceptance 引用
- `doctor.ts`：移除 `sessionDir` 覆写引用
- `tool-description.ts`：移除 chain、budget、timeout、clarify、share 相关描述
- `agent-management.ts`：移除 `chainName` 处理

## 不变更的内容
- agent 配置中的 `toolBudget`、`turnBudget`、`timeout`、`cwd`、`sessionDir`、`output`、`outputMode`、`reads` 仍然保留，只是不允许从调用方覆写
- `action` 管理模式（list/get/create/update/delete 等）保留
- `id` 管理操作（status/interrupt/resume/steer）保留
- `schedule` 功能保留
- `async` 功能保留
- `wait` 工具（有自己的 timeout 参数，不受影响）
- intercom 相关功能

## 注意事项 / 风险
- 移除 agent/task 顶层参数是重大 API 变更，需确保所有调用方适配 `tasks` 数组
- acceptance 功能涉及文件多、耦合深，需确保不遗漏引用
- chain 和 clarify 紧密耦合，需同时清理
- 需要同时更新 tool description（full 和 compact 两个版本）
- `async-path.ts` 中的 chain 路由逻辑移除后不影响 async single/parallel 路径
- 注意 `SubagentParamsLike` 类型在 extension 和 runs 层的传递
- 编译通过后需验证所有现有功能不受影响

## 变更步骤建议

### Phase 1: Schema & Types 清理
1. 更新 `blocks.ts`：移除所有废弃的 schema 定义
2. 更新 `subagent-params.ts`：精简为 16 个参数
3. 更新 `types.ts`：精简 `SubagentParamsLike`、`TaskParam`、`ExecutionContextData`
4. 更新 `options-types.ts`、`result-types.ts`、`async-types.ts`：移除 acceptance 相关类型
5. 更新 `tool-description.ts`

### Phase 2: 删除目录和文件
6. 删除 `src/runs/foreground/chain-execution/`
7. 删除 `src/runs/foreground/chain-clarify/`
8. 删除 `src/runs/shared/acceptance/`
9. 删除所有列出的单个文件

### Phase 3: 逻辑清理
10. 清理 `single-path.ts`、`parallel-path.ts`、`async-path.ts`、`prepare-execution.ts`
11. 清理 `run-sync.ts`、`attempt-helpers.ts`
12. 清理后台 runner 文件中的 acceptance 逻辑
13. 清理 `action-dispatch.ts`、`validation.ts`
14. 清理 `budget-resolution.ts` 中不再需要的函数

### Phase 4: 验证
15. 编译检查
16. 功能验证

## Acceptance Criteria

### Schema / Types
- [ ] 顶层参数精简为 16 个：`action`, `id`, `index`, `view`, `lines`, `message`, `schedule`, `scheduleName`, `config`, `tasks`, `concurrency`, `worktree`, `context`, `async`, `artifacts`, `includeProgress`
- [ ] `TaskItem` 精简为 6 个字段：`agent`, `task`, `count`, `progress`, `model`, `skill`
- [ ] `blocks.ts` 中所有废弃的 schema 定义已移除
- [ ] `SubagentParamsLike` 已精简
- [ ] `RunSyncOptions` 中 `acceptance`、`acceptanceContext`、`share`、`outputMode` 等已移除
- [ ] `SingleResult` 中 `acceptance`、`acceptanceStatus` 已移除
- [ ] 所有 chain 相关的类型定义已清理

### 底层代码清理
- [ ] `src/runs/foreground/chain-execution/` 目录已删除
- [ ] `src/runs/foreground/chain-clarify/` 目录已删除
- [ ] `src/runs/shared/acceptance/` 目录已删除
- [ ] 所有列出的文件已删除
- [ ] 没有 dangling import 指向已删除的模块

### 功能完整性
- [ ] 编译通过，无类型错误
- [ ] 单 agent 调度通过 `tasks: [{agent, task}]` 正常工作
- [ ] 并行调度通过 `tasks: [{agent, task}, ...]` 正常工作
- [ ] `action` 管理模式（list/get/create/update/delete/status/interrupt/resume/steer）正常工作
- [ ] `async` 后台运行正常工作
- [ ] `schedule` 调度功能正常工作