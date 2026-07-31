# Design: TUI 内交互式 steer subagent

> 需求见 `prd.md`（R1-R5）。本文档给出技术设计：模块边界、协议、数据流、兼容性。

## 1. 总体架构

```
父 pi 进程（交互式 TUI）
├─ src/tui/steer-view/                    ← 新增：视图组件层
│   ├─ steer-view-component.ts            全屏 overlay 组件（对话区 + 输入框）
│   ├─ run-picker.ts                      picker（SelectList overlay）
│   ├─ transcript-tail.ts                 transcript JSONL 增量读取器
│   └─ entry-shortcut.ts                  onTerminalInput Down 键入口
├─ src/runs/shared/control-actions/       ← 新增：通用控制协议（父子共用类型）
│   ├─ actions.ts                         信封/回执类型 + 校验
│   ├─ paths.ts                           child request/response 路径
│   └─ channel.ts                         原子写入 + consume helpers
├─ foreground/async spawn 接线             ← 修改：传 steer + action dirs，保证 live transcript
└─ child pi 进程（无头）
    └─ src/runs/shared/subagent-prompt-runtime/
        └─ runtime-registration.ts        ← 修改：消费 action 信封（thinking 等）
```

数据全部走**文件信箱 + 内存注册表**，无新 IPC。父进程 TUI 不持有 child 句柄；child 不感知 TUI 存在。

## 2. Run 枚举与 picker（R1）

- 数据源合并：`state.asyncJobs`（内存）+ `listAsyncRuns()`（跨会话 async 兜底）+ 新增 `state.foregroundLiveChildren`（active foreground，key 为 runId/index）+ `state.foregroundRuns`（终态/近期 fallback）。
- 每个 picker 条目：agent 名、run id（短）、状态（running/queued/needs_attention）、最近一行输出（`status.json` 的 `recentOutput` 或 transcript 最后一行）、steerCount。
- picker 用 `SelectList` + `DynamicBorder`（pi-tui 内置，见 tui.md Pattern 1），overlay 形态；选中 → 关闭 picker，打开全屏视图。
- 视图内提供「返回 picker」键（见 §6 键位表），实现 picker 中心导航。

## 3. 对话视图组件（R2）

- `ctx.ui.custom(..., { overlay: true })` 打开铺满终端的 capturing overlay（`width: "100%"`, `maxHeight: "100%"`, `anchor: "center"`, `margin: 0`）。Pi 0.82 非 overlay custom 只替换 editor 容器，不能提供全屏会话体验。组件结构翻版 `ChainClarifyComponent`（`src/runs/foreground/chain-clarify/chain-clarify-component.ts:43`）：
  - 顶部状态行：agent、run id、状态、思考强度（若能读到）、steer 计数
  - 中部滚动对话区：`Markdown` 组件渲染（`getMarkdownTheme()`），按消息分块；user 消息用 `userMessageBg` 等 theme 色，与主对话观感对齐
  - 底部输入框：单行 `Input`（pi-tui 内置，带 Focusable 传播以支持 IME）
- **实时刷新**：250ms interval（与 tracker poller 同节奏）做三件事：
  1. tail transcript JSONL（byte-offset 增量读，`JSON.parse` 逐行；`recordType === "truncated"` 容错）
  2. 重读 status.json / foregroundRuns 更新状态行（child 崩溃兜底：状态转 failed/completed 时头部提示）
  3. 状态变化时 `invalidate()` + `tui.requestRender()`
- **live transcript 保证**：每个 active child 都创建 structured writer。持久 transcript artifact 开启时复用 artifact path；关闭时使用 `<TEMP_ROOT_DIR>/live-transcripts/<runId>/<index>.jsonl`。临时文件不改变 artifact 配置语义；child 终态且无 view 持有后删除，session shutdown 强制清理。
- transcript 路径来源：async → status.json `steps[].transcriptPath`（包括临时 live path）；foreground active → `state.foregroundLiveChildren[runId/index].transcriptPath`；终态 fallback → `state.foregroundRuns`。fallback 链照抄 `formatAsyncRunTranscript`（output log → recentOutput → session file），安全校验复用 `readContainedTextTail`（trusted roots = asyncDir / artifactsDir / scoped runtime live-transcript root）。
- 现有 writer 记录 finalized `message_end`/`tool_result_end` 与 tool start/end，不记录 assistant token delta。因此约 1 秒刷新从完整事件落盘时计算，不承诺 token-by-token streaming。
- 滚动：对话区维护 scrollOffset，PgUp/PgDn/Up/Down 滚动；新消息到达时若贴底则自动跟随，否则显示「↓ 新消息」提示（不打断阅读）。
- 多 child run：视图内以 step 为单位选择（picker 条目即 step 粒度），`targetIndex` 直达。

## 4. Steer 消息（R3）

- **async**：`requestAsyncSteer(asyncDir, { message, targetIndex?, source: "tui" })` 一行调用。发送前复用 `steerAsyncRun` 的状态校验（`reconcileAsyncRun` → running/queued）。
- **foreground 接线**（本任务的运行时改动）：
  - foreground spawn 路径实际位于 `src/runs/foreground/execution/run-single-attempt.ts` 的 `buildPiArgs(...)` 调用，经 `pi-args.ts` 已有的 `steerInboxDir` 参数传入 deterministic live-control 根：`<TEMP_ROOT_DIR>/foreground-subagent-runs/<runId>/control/steer-targets/<index>/`。不能依赖 artifactsDir（artifacts 可禁用）。
  - 父进程 TUI steer foreground = 直接写 child 信箱（`writeSteerRequestToDir(stepInboxDir, request)`）——父 extension 进程就是 foreground 的「runner」，无需 runner 路由跳。
  - child 侧零改动：`registerSteeringInbox` 读 `PI_SUBAGENT_STEER_INBOX` 已就绪。
  - 同时解除 `action-dispatch.ts:133` 对 foreground steer 的显式拒绝（tool action 层也受益）。
  - live registry：新增 `state.foregroundLiveChildren`，按 runId/index 记录 agent、status、transcriptPath、controlRoot，供并行 foreground picker 与 action 路由；不能用只表示单个 currentIndex 的 `foregroundControls`，也不能等 run 完成后才依赖 `foregroundRuns`。child 终态后转入 remembered state 并按清理规则释放 control root。
- **送达确认**：发送后输入框下方显示「已排队，下个 turn 生效」；tailer 在 transcript 中观察到对应 user 消息（文本匹配 + ts > 发送时间）后改为「✓ 已送达」。

## 5. 通用控制转发协议（R4）

action 不复用现有 steer 目录：当前 `consumeSteerRequestsFromDir()` 会删除无法解析为 steer 的 JSON，混写会丢 action。每个 child control root 使用独立目录：

```
control/
├─ steer-targets/<index>/             # 现有 steer，保持兼容
└─ action-targets/<index>/
   ├─ requests/                       # parent → child
   └─ responses/                      # child → parent
```

协议格式：

```ts
type ChildControlActionRequest = {
  version: 1;
  type: "action";
  id: string;
  ts: number;
  action: string;
  payload?: unknown;
  source?: string;
};

type ChildControlActionResponse = {
  version: 1;
  type: "action_response";
  requestId: string;
  ts: number;
  status: "applied" | "rejected";
  action: string;
  result?: unknown;
  error?: string;
};
```

- action request/response 都用 `writeAtomicJson`，严格校验 version/type/id/ts/action；消费端先 claim/remove 请求，再处理并写一份 response，避免重复应用非幂等 cycle。
- MVP action：`"cycleThinking"`（无 payload）。项目先升级到 Pi 0.82.1；extension API 仍只公开 `getThinkingLevel()/setThinkingLevel()`，因此 child 用项目共享的 0.82 thinking 顺序与模型 metadata 计算下一可用等级，调用 `setThinkingLevel(next)`，随后再 `getThinkingLevel()` 读取实际 clamp 后等级。
- child 侧新增独立 `registerControlActionInbox`，通过新增 `PI_SUBAGENT_ACTION_CONTROL_DIR` 定位 requests/responses，不改变 steer flush。`cycleThinking` 成功回 `{ status:"applied", result:{ thinkingLevel } }`；无 thinking 支持/未知 action/异常回 `rejected` + error。
- async parent/TUI 直接写目标 `action-targets/<index>/requests`；queued/pending step 的请求保留到 child spawn 后消费，不经过 runner 二次路由。foreground 同样直写 live child action inbox。
- TUI tail response outbox（按已见 requestId 去重）；收到 applied 后更新头部和 notice，rejected 显示原因。response 文件由父进程读取后删除，过期文件按时间清理。
- action response 是 AC5 的权威回执；可另写 transcript/control notice 作为人类可见审计，但不作为协议正确性的依赖。
- 新增 action 类型放在 `src/runs/shared/control-actions/actions.ts`（父子共用的唯一类型源）。

## 6. 键位与入口（R1/R5）

| 键位 | 上下文 | 行为 |
|---|---|---|
| `/subagents`（新 slash 命令） | 主编辑器 | 打开 picker（无活跃 run 时 notify 提示） |
| Down | 主编辑器**为空**时 | 同上（可配置 `tui.openSubagentsOnDown`，默认开） |
| ↑↓ / Enter / Esc | picker | 导航 / 进入视图 / 关闭 |
| Esc | 对话视图 | 返回 picker（picker 再 Esc 回主对话） |
| Enter | 对话视图输入框 | 发送 steer（`/` 前缀除外，见下） |
| shift+tab | 对话视图 | 发送 `cycleThinking` action 到当前 child |
| PgUp/PgDn、↑↓ | 对话视图（输入框为空时） | 滚动对话区 |
| Tab | 对话视图 | 焦点在输入框/滚动区之间切换（组件内部） |

- `/xxx` 处理：输入框提交以 `/` 开头的文本 → 先用 `done(...)` 关闭 overlay；`ctx.ui.custom()` Promise resolve 后再 `ctx.ui.setEditorText(text)`（否则 custom restore 会覆盖预填文本）。用户再回车走 pi 原生命令系统，其他插件命令因此可用。
- Down 键拦截实现：在 `session_start` 注册 `ctx.ui.onTerminalInput(handler)`；仅当 `matchesKey(input, Key.down)`、`ctx.ui.getEditorText()` 为空、有可选 run、且本扩展没有已打开 modal 时，异步打开 picker并返回 `{ consume: true }`；其余返回 `undefined`，由 pi 当前编辑器（包括其他插件的 CustomEditor）照常处理。unsubscribe 纳入 runtime cleanup。
- `onTerminalInput` 监听器按注册顺序运行，consume 会阻止后续监听器和 editor；因此 Down 入口是严格 gate 的 convenience channel，而 `/subagents` 是插件生态冲突时的可靠基线。测试覆盖非目标输入返回 `undefined`。
- 配置项：新增 typed `TuiConfig`（`openSubagentsOnDown: boolean`，默认 true）并挂到 `ExtensionConfig.tui`；更新 config normalization/read-write 与测试。`src/extension/config.ts` 沿用现有持久化约定，本任务不顺带重构整个配置存储。

## 7. 兼容性与清理纪律

- **主 session 不动**：不调用 `switchSession`/`newSession`；视图仅读文件 + 写信箱。
- **清理**：组件 `dispose()` 停 interval并释放 live-transcript view 引用；全局资源挂进 `__piSubagentRuntimeCleanup` / `__piSubagentEventUnsubscribes` 模式（`src/extension/index.ts:57-73`）；`session_shutdown` 时关闭视图并清理 foreground control/live-transcript runtime roots；action response 有 TTL 清理。
- **stale ctx**：视图异步回调里捕获 `isStaleExtensionContextError`。
- **child 防重入**：TUI 代码只在父进程注册（`SUBAGENT_CHILD_ENV` 门控已有）；child 侧仅扩展 `runtime-registration.ts`。
- **模态说明**：铺满终端的 capturing overlay 接管输入但不 teardown main runtime；主 agent turn、widget/status/其他插件内存状态继续工作，关闭后原焦点恢复。若其他插件同时打开高优先级 overlay，严格的 `modalOpen` gate 防止本扩展重复打开。
- **回滚**：功能整体由 slash 命令 + terminal-input handler 进入，运行接线改动（foreground steerInboxDir）向后兼容（child 无 inbox env 时行为不变）；出问题可只取消 terminal-input handler 注册。

## 8. 关键风险与对策

| 风险 | 对策 |
|---|---|
| Down 入口与其他终端输入监听器冲突 | 严格 gate；非目标输入返回 `undefined`；用 `onTerminalInput` 保留其他插件的 CustomEditor |
| steer 无回执 | transcript 观察闭环（§4） |
| transcript 文件被截断/轮转（50MB 上限） | offset 失效时从头重读 + truncated marker 容错 |
| 用户关闭持久 transcript artifact | active child 使用 scoped 临时 live transcript；终态且无人查看后清理 |
| child 崩溃后视图僵死 | status.json 轮询兜底，头部显示终态 |
| 全屏组件按键吞噬（shift+tab 等不到主 session） | 视图内显式映射语义动作；未映射键不转发（模态期间主编辑器本来就不可用） |
| Pi 0.82.1 升级引入基线回归 | 独立 Phase 0 升级 + `npm run test:all`；失败则先回滚依赖，不混入功能代码 |

## 9. Pi 0.82.1 升级边界

- 将 `@earendil-works/pi-tui`、`pi-agent-core`、`pi-ai`、`pi-coding-agent` 的直接/开发依赖统一到精确 `0.82.1`，peerDependencies 保持 `*`。
- 更新 `package-lock.json`，只修复升级触发的兼容问题；先运行原有 `npm run test:all` 建立基线，再进入 control/TUI 实现。
- 更新 `src/shared/model-info.ts` 及相关测试以反映 0.82 的 model thinking compatibility；`cycleThinking` 复用该共享层，不维护第二套硬编码等级表。
- 详细运行时契约见 `research/pi-082-tui-control-contracts.md`。
