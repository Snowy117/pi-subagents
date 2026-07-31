# Steer 通道（消息如何投递到活着的 child）

> 研究问题：action "steer" 如何实现？live 投递 vs 排队？走什么机制？extension 进程内是否有「run id + 文本 → 投递」的可直接调用函数？steer / resume / interrupt 的差异？

## 核心结论（TL;DR）

**Steer 是文件信箱（file inbox）机制，不是 intercom、不是 RPC。** 完整链路四跳：

```
调用方 (tool action / TUI)
  → requestAsyncSteer(asyncDir, { message, targetIndex? })     # 写 JSON 文件到 asyncDir/control/steer-requests/
    → runner 进程 watchAsyncControlInbox 轮询消费               # 路由到对应 step
      → enqueueStepSteer → asyncDir/control/steer-targets/<index>/  # 每 child 信箱
        → child pi 进程 registerSteeringInbox (250ms flush)     # pi.sendUserMessage(msg, { deliverAs: "steer" })
```

**extension 进程内可直接调用的函数就是 `requestAsyncSteer(asyncDir, { message, targetIndex?, source? })`**（`src/runs/background/control-channel/control.ts:74`），纯同步文件写入，TUI 层拿到 asyncDir 即可直接调用，无需经过 tool action 层。更薄的一层是 `writeSteerRequestToDir(dir, request)`（control.ts:42）——甚至可以绕过 runner 直接写 step 信箱 `stepSteerInboxDir(asyncDir, index)`。

## 1. 文件布局（控制信箱）

`src/runs/background/control-channel/paths.ts`：

- `controlInboxDir(asyncDir)` = `<asyncDir>/control/`（:41）
- `interruptRequestPath` = `control/interrupt.json`（:46）
- `timeoutRequestPath` = `control/timeout.json`（:51）
- `steerRequestsDir` = `control/steer-requests/`（:56）— **parent → runner** 的 steer 投递目录
- `stepSteerInboxDir(asyncDir, index)` = `control/steer-targets/<index>/`（:61）— **runner → 单个 child pi 进程** 的每步信箱

`SteerRequest` 类型（paths.ts:23-29）：`{ type: "steer", id, ts, message, targetIndex?, source? }`。写入用 `writeAtomicJson`（temp+rename），文件名按 `ts-id` 排序（control.ts:34-36）。

## 2. 投递端（parent / extension 进程）

### requestAsyncSteer
`control.ts:74` — 校验 message 非空、targetIndex 合法，生成 UUID，写文件到 `steerRequestsDir`。**只写文件，不碰进程。** 进程死活由消费端容错。

### steerAsyncRun（tool action 层）
`src/runs/foreground/executor/interrupt-steer.ts:80` — 在 `requestAsyncSteer` 之前做状态校验：

1. `reconcileAsyncRun(asyncDir)` 读 status.json；`state` 必须是 `running` 或 `queued`（:101）
2. 指定 `index` 时校验该 step 是 `running`/`pending`（:114-128）
3. 未指定 index 且多 child 无 running 时要求显式 index（:131-139）
4. 调 `requestAsyncSteer(location.asyncDir, { message, targetIndex, source: "steer-action" })`（:142）

入口分发：`src/runs/foreground/executor/action-dispatch.ts:110-135`。嵌套 run 走 `steerNestedRun`（`nested-runs.ts:156`）→ `directNestedAsyncSteer`（:118）同样落到 `requestAsyncSteer`。

## 3. 路由端（runner 进程）

- runner 是独立 node 进程：`src/runs/background/async-execution/runner-spawn.ts:110` `spawnRunner()` 启动 `src/runs/background/subagent-runner.ts`（读 config argv/stdin → `runSubagent(config)`）
- `watchAsyncControlInbox(asyncDir, { onInterrupt, onTimeout, onSteer })`（control.ts:227）：`fs.watch` + 250ms 轮询双保险，消费 interrupt/timeout/steer 三类请求，fire-and-forget 容错（inbox 错误永不 crash runner）
- `onSteer` 处理：`src/runs/background/runner/run-subagent.ts:36-40` — step 未开始时进 `state.pendingStepSteers` 排队（run-subagent.ts:38；`flushPendingStepSteers` 在 step 启动时冲刷，runner-step-sequential.ts:38 / parallel:139 / dynamic:174）；已在运行则 `ops.deliverSteerRequest(request)`
- `deliverSteerRequest`（`src/runs/background/runner/ops/runner-ops-activity.ts:88`）→ `enqueueStepSteer(asyncDir, index, request)`（control.ts:95）写入该 child 的 `steer-targets/<index>/` 信箱，并记 `steerCount`/`lastSteerAt` 到 status.json（ops-activity.ts:109-115），同时写 `subagent.steer.requested` 事件（:120）

## 4. 消费端（child pi 进程 — 真正的 live 投递）

`src/runs/shared/subagent-prompt-runtime/runtime-registration.ts:55` — `registerSteeringInbox(pi)`：

- child 通过 env `PI_SUBAGENT_STEER_INBOX`（`src/runs/shared/pi-args.ts:32`，由 runner 在 spawn child 时设置 `env[SUBAGENT_STEER_INBOX_ENV] = stepSteerInboxDir(asyncDir, index)`，pi-args.ts:252；async 三步执行器均传 `steerInboxDir`：runner-step-sequential.ts:46 等）
- child 侧 `fs.watch` + 250ms interval flush（runtime-registration.ts:88-97）；激活门控：等到首个 `message_start`/`tool_execution_start`/`turn_end` 等事件才 `canSteer = true`（:104-110）
- flush 调 `pi.sendUserMessage(formatSteerMessage(request), { deliverAs: "steer" })`（:75）— **这是 pi 原生的 mid-run steering**：消息作为 user 消息插入当前 agent loop，不打断正在执行的 tool call，下一个 model turn 生效
- 投递失败则把剩余请求写回信箱重试（:76-78）
- `formatSteerMessage`（:23）包装前缀 "Mid-run steering from the parent orchestrator:" + 尾注 "Incorporate this guidance at the next safe point…"

**live vs 排队的答案：两层都有队列语义。** parent→runner 是持久文件队列（runner 暂死也能后补）；runner→child 也是文件队列，但 child 侧 flush 依赖 pi 事件循环存活——child 进程活着时接近实时（≤250ms + model turn 边界），child 死了文件滞留无害。

## 5. steer vs resume vs interrupt

| | steer | interrupt | resume |
|---|---|---|---|
| 目标状态 | running / queued | running（需 pid） | running（=interrupt+follow-up）或 paused/failed/complete（=revive） |
| 机制 | 写 `steer-requests/*.json` | 写 `interrupt.json` + 尽力 SIGUSR2/SIGBREAK 信号（`deliverInterruptRequest`，control.ts:183；信号在 Windows ENOSYS 时仅作 fast-path，文件信箱权威） | live：`interruptLiveAsyncResumeTarget`（async-resume/resume.ts:18）先 interrupt，再带 follow-up revive；terminal：`buildRevivedAsyncTask`（resume.ts:182）以原 sessionFile 重启新 runner |
| 打断当前 tool call | 否（`deliverAs: "steer"` 排队到下个 turn） | 是（runner graceful pause，可恢复） | live 场景：是 |
| 会话连续性 | 同一会话内注入 user 消息 | 无消息，仅暂停 | revive 场景：`--resume` 挂原 session 文件，新进程继续 |
| 代码入口 | `steerAsyncRun` interrupt-steer.ts:80 | `interruptAsyncRun` interrupt-steer.ts:42 | `resumeAsyncRun` executor/async-resume.ts:31；target 解析 `resolveAsyncResumeTarget` async-resume/resume.ts:80 |

三者共用：`resolveSubagentRunId` 做 id 解析、`reconcileAsyncRun` 做活性校验、`control/` 文件信箱做传输。

## 6. Foreground vs async 的 steer 能力差异

- **Foreground run 不可 steer**：action-dispatch.ts:133 显式拒绝（"action='steer' currently supports live async Pi child sessions only"），`steerNestedRun` 对 foreground nested 同样拒绝（nested-runs.ts:161）
- 根因：foreground child 由父 extension 进程 spawn 并阻塞等待（`src/runs/foreground/execution/single-attempt-process.ts`），**其 env 里没有 `PI_SUBAGENT_STEER_INBOX`**——只有 async runner 的三类 step 执行器传 `steerInboxDir`。child 的 `registerSteeringInbox` 在 inbox env 缺失时直接 return（runtime-registration.ts:57）
- 主 agent 正阻塞在 foreground tool call 里时，TUI 理论上是空闲的（用户在等），给它加一个 steer 视图**有意义但需要新机制**：要么 foreground spawn 时也传 steerInboxDir（子进程侧机制已就绪、零改动），要么用 `foregroundControls` 里的 `interrupt()` 钩子 + resume。前者明显更顺
- async run 的 steer 对 TUI 完全可行：拿到 `asyncDir`（`state.asyncJobs` 或 `listAsyncRuns` 都有）→ `requestAsyncSteer(asyncDir, { message })`，一行搞定

## 对本功能的启示

1. **TUI 发送 steer 只需一个函数调用**：`requestAsyncSteer(asyncDir, { message, targetIndex?, source: "tui-steer" })`。建议在 TUI 侧薄封装 `steerRun(state, runId, message)`：先 `resolveSubagentRunId` + `reconcileAsyncRun` 校验（复用 `steerAsyncRun` 的校验逻辑，或直接把 `steerAsyncRun` 重构为返回结构化结果的共享函数）。
2. **`source` 字段是现成的审计钩子**（现有值："steer-action"、"nested-steer"、"async-resume"），TUI 可用 `"tui"` 便于区分来源；status.json 的 `steerCount`/`lastSteerAt` 会自动累计，widget 已展示。
3. **多 child run 需要 index**：TUI 视图应选择到具体 step（`status.json` 的 `steps[].agent`/`status` 可用于 picker）；单 child 或未指定时 runner 自动路由到 running step。
4. **投递是异步、无回执的**：`requestAsyncSteer` 返回文件路径即"排队成功"，不代表 child 已消费。TUI 需要自行提示"已排队，下个 turn 生效"；确认消费可观察 `transcript.jsonl` 中出现该 user 消息（见 transcript-access.md）。
5. **foreground steer 是本功能的最大缺口**，但补齐路径清晰：foreground spawn 传 `steerInboxDir`（pi-args.ts:251 已支持参数）+ 父进程写一个 foreground 用的 inbox 目录。child 侧零改动。
6. 与 intercom 无关：steer 不经过 `src/intercom/`；不要尝试用 intercom 给 child 发 steer（intercom 是 session 间命名通道，child 是 pi 子进程不是 intercom session）。
