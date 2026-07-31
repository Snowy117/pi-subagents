# Run 注册与发现（Run Registry）

> 研究问题：subagent run（foreground / async / background）如何被注册、跟踪？extension 进程内能否枚举当前活跃 runs 及其元数据？

## 总览：三套并行的跟踪机制

| 机制 | 位置 | 覆盖范围 | 存活域 |
|---|---|---|---|
| `state.asyncJobs` 内存 Map | `src/runs/background/async-job-tracker/tracker.ts` | 本 session 的 async run（含嵌套投影） | extension 进程内存 |
| `state.foregroundControls` + `state.foregroundRuns` 内存 Map | `src/runs/foreground/executor/foreground-state.ts`、`prepare-execution.ts` | 本进程内的 foreground run（live 控制 + 完成后的"记忆"） | extension 进程内存 |
| 文件系统：`ASYNC_DIR/<id>/status.json` + `RESULTS_DIR/<id>.json` | `src/runs/background/async-status/list.ts` | 所有 async run（跨进程、跨重启可恢复） | tmp 目录持久化 |

## 1. Async run 注册表（核心）

### SubagentState
`src/shared/types/async-types.ts:198` — `SubagentState` 是 extension 单例状态（在 `src/extension/index.ts:82` 创建一次）：

- `asyncJobs: Map<string, AsyncJobState>`（async-types.ts:204）— async run 的内存注册表
- `foregroundRuns?: Map<string, ForegroundResumeRun>`（:206）
- `foregroundControls: Map<string, {...}>`（:205）— live foreground 控制块，含 `currentAgent`、`currentTool`、`turnCount`、`nestedRoute`，甚至 `interrupt?: () => boolean`（:222）
- `lastUiContext: ExtensionContext | null`（:230）— 缓存最近一次 UI 上下文，供后台事件触发 widget 重绘
- `poller: NodeJS.Timeout | null`（:231）— 全局轮询器

`AsyncJobState` 关键字段（async-types.ts:130-172）：`asyncId`、`asyncDir`、`status`（queued/running/complete/failed/paused）、`pid`、`sessionId`、`mode`、`agents[]`、`steps[]`、`sessionFile`、`sessionDir`、`outputFile`、`nestedRoute`、`nestedChildren`、`controlEventCursor`。

### createAsyncJobTracker
`src/runs/background/async-job-tracker/tracker.ts:17` — `createAsyncJobTracker(pi, state, asyncDirRoot, options)` 返回：

- `handleStarted(data)`（tracker.ts:176）— 监听 `SUBAGENT_ASYNC_STARTED_EVENT`，把 `AsyncStartedEvent` 写入 `state.asyncJobs`
- `handleComplete(data)`（:216）— 监听 `SUBAGENT_ASYNC_COMPLETE_EVENT`，更新状态并 scheduleCleanup（完成后保留 10s，`completionRetentionMs`，tracker.ts:25）
- `ensurePoller()`（:49）— 启动 250ms 轮询（`POLL_INTERVAL_MS`，`src/shared/types/constants.ts`），每个 tick 对 asyncJobs 里每个 job 调 `reconcileAsyncRun(job.asyncDir, ...)` / `readStatus(job.asyncDir)` 刷新 status.json 派生的全部字段，变化时重绘 widget
- `restoreActiveJobs(ctx)`（tracker.ts:255）— session_start 时调 `listAsyncRuns(asyncDirRoot, { states: ["queued","running"], sessionId })` 从磁盘恢复（TUI 重启后恢复跟踪）
- `resetJobs(ctx)`（:240）

### 跨进程枚举：listAsyncRuns
`src/runs/background/async-status/list.ts:17` — `listAsyncRuns(asyncDirRoot, options)`：扫 `ASYNC_DIR`（`os.tmpdir()/pi-subagents-<uid>/async-subagent-runs`，`src/shared/types/temp-paths.ts:64-65`）下每个目录，对每个做 `reconcileAsyncRun` + `readStatus`，返回 `AsyncRunSummary[]`（排序：running > queued > failed/paused > complete）。

`AsyncRunSummary`（`src/runs/background/async-status/summary.ts:42`）字段齐全：`id`、`asyncDir`、`sessionId`、`state`、`pid`（在 status 里）、`mode`、`cwd`、`startedAt`、`steps[]`（每个含 agent/status/sessionFile/transcriptPath/steerCount/currentTool 等）、`sessionFile`、`outputFile`、`nestedChildren`。支持 `states`、`sessionId`、`limit` 过滤。

**结论：extension 进程内要枚举"当前活跃 runs"，直接调 `listAsyncRuns(ASYNC_DIR, { states: ["queued","running"], sessionId: state.currentSessionId })` 即可，无需走 tool 层。** 内存路径是 `state.asyncJobs`（已挂载在 extension 单例上）。

### Run ID 统一解析
`src/runs/background/run-id-resolver.ts:55` — `resolveSubagentRunId(id, { state, asyncDirRoot, resultsDir, nested })` 返回三态：

```ts
{ kind: "foreground"; id } | { kind: "async"; id; location } | { kind: "nested"; id; match }
```

支持精确匹配与前缀匹配（ambiguous 时抛错列出候选）。这是 TUI 层「用户选一个 run」时可以复用的解析器；`AsyncRunLocation` = `{ asyncDir: string|null, resultPath: string|null, resolvedId }`（`async-resume/location.ts`）。

## 2. Foreground run 注册

- 创建：`src/runs/foreground/executor/prepare-execution.ts:225-242` — 非 async 执行时构造 `foregroundControl` 并 `state.foregroundControls.set(runId, ...)`，同时记 `lastForegroundControlId`
- live 状态查询：`foregroundStatusResult()`（foreground-state.ts:103）
- 完成后记忆：`rememberForegroundRun()` / `updateRememberedForegroundChild()`（foreground-state.ts:134、:168）把结果（含每个 child 的 `sessionFile`、`artifactPaths`、`transcriptPath`）存入 `state.foregroundRuns`，上限 50 条（`trimRememberedForegroundRuns`，:124）
- 前台 run 的 `interrupt?: () => boolean` 钩子在 chain-execution 层赋值（`src/runs/foreground/chain-execution/types.ts:88,144`）

**注意：foreground run 只存在于内存。TUI 重启后不可恢复（无 status.json）。**

## 3. 事件流（注册时机）

- started：`src/runs/background/async-execution/single-execution.ts:217` 与 `chain-execution.ts:218` — spawn runner 进程后 `ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id, pid, sessionId, asyncDir, agents, chain, mode, nestedRoute, ... })`
- complete：`src/runs/background/result-watcher/watcher.ts:122` — result-watcher 发现 `RESULTS_DIR/<id>.json` 后 emit `SUBAGENT_ASYNC_COMPLETE_EVENT`
- 事件名常量：`src/shared/types/constants.ts:14-19`（`subagent:async-started`、`subagent:async-complete`、`subagent:control-event`、`subagent:control-intercom`、`subagent:result-intercom`）
- 订阅点：`src/extension/index.ts:~196-201` — `pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleStarted)` 等

## 4. asyncDir 目录结构（run 的磁盘真相源）

`$TMPDIR/pi-subagents-<scope>/async-subagent-runs/<runId>/`：

- `status.json` — runner 持续更新的状态（`AsyncStatus`；`src/runs/background/runner/runner-state.ts:200`）
- `events.jsonl` — 生命周期 + control 事件流（runner-state.ts:201；tracker 用 `controlEventCursor` 增量扫描）
- `output-<N>.log` — 第 N 个 child 的 stdout 流（runner-step-sequential.ts:27 等）
- `subagent-log-<id>.md` — 人类可读日志（runner-state.ts:202）
- `control/` — 控制信箱（见 steer-channel.md）
- `runner.stdout.log` / `runner.stderr.log` — runner 进程自身日志（`async-execution/runner-spawn.ts:93-94`）
- `RESULTS_DIR/<id>.json` — 完成结果文件（result-watcher 消费后删除）

## 对本功能的启示

1. **TUI 的 run 列表数据源已经齐备**：内存态用 `state.asyncJobs` + `state.foregroundControls`（低延迟），权威态用 `listAsyncRuns()`（可恢复、含嵌套）。入口界面「选择要 steer 的 subagent」可以直接合并这两个来源。
2. **`state` 单例就是集成点**：所有注册表都挂在 `SubagentState` 上，已在 `src/extension/index.ts:87` 创建并注入 executor/tracker/slash 命令。新增 TUI 组件只需拿到同一个 `state` 引用。
3. **foreground run 没有磁盘注册表**，进程重启即丢失；TUI 视图要把 foreground 标记为 "session-local"。
4. **run id 解析复用 `resolveSubagentRunId`**，天然支持用户在 TUI 里输入前缀 id 或从列表选择；三态 kind 区分了后续可用操作（async 可 steer，foreground 只能 interrupt/resume）。
5. 完成事件有 10s 保留窗口（cleanupRetentionMs），TUI 若依赖 `asyncJobs` 枚举，完成的 run 会短暂可见后消失；要长期展示应读 `RESULTS_DIR` 或 `listAsyncRuns`（含 complete 态）。
