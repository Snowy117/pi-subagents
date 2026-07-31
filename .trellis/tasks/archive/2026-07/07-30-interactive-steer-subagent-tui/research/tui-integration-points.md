# TUI 集成点（pi extension UI 能力与本仓库现状）

> 研究问题：src/tui/ 渲染如何接入 pi extension？extension/index.ts 注册了哪些 pi API？有没有已在用 ctx.ui.custom() / overlay / setEditorComponent 的地方？事件流如何驱动 TUI 实时刷新？

## 1. pi extension 的 UI 能力清单

`ExtensionUIContext`（`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:67-191`），经 `ctx.ui` 访问（仅 `ctx.hasUI` 时可用）：

| API | 行号 | 用途 | 本仓库使用处 |
|---|---|---|---|
| `custom<T>(factory, { overlay, overlayOptions, onHandle })` | :116 | **模态自定义组件，拿键盘焦点**；factory `(tui, theme, kb, done) => Component`；支持 overlay 定位/尺寸 | ✅ chain-clarify（见 §3） |
| `setWidget(key, content \| factory, options?)` | :96 | editor 上/下方的常驻 widget（字符串数组或 Component factory） | ✅ async jobs widget（见 §2） |
| `setStatus(key, text?)` | :79 | footer 状态栏文本 | ✅ slash-run.ts:48/68，slash-helpers.ts:13 |
| `onTerminalInput(handler)` | :77 | 原始终端输入监听（interactive 模式），返回 unsubscribe | ✅ slash-run.ts:72 |
| `setEditorComponent(factory?)` | :170 | 替换主输入编辑器（CustomEditor 可继承） | ❌ 未使用 |
| `setFooter` / `setHeader` | :100/:109 | 自定义 footer/header 组件 | ❌ 未使用 |
| `notify(message, type)` | :75 | toast 通知 | ✅ 多处（slash 命令） |
| `select` / `confirm` / `input` / `editor` | :69-72/:129 | 内置对话框 | ✅ profile-commands.ts:94 等 |
| `requestRender()` | （ExtensionContext.ui） | 请求重绘 | ✅ index.ts:209、tracker.ts:29 |
| `getToolsExpanded` / `setToolsExpanded` | :187/:190 | 工具输出展开态 | ✅ bridges.ts:28、widget-render.ts:107 |
| `pasteToEditor` / `setEditorText` / `getEditorText` | :127-133 | 操作主编辑器内容 | ❌ 未使用 |

`pi.registerCommand(name, { description, handler })`（types.d.ts:815）— 注册 slash 命令。`pi.events.on/emit` — extension 内事件总线。

**TUI 组件模型**：`Component`（`@earendil-works/pi-tui`）实现 `handleInput(data)` / `render(width)` / `invalidate()` / `dispose()`；`Container`/`Text` 等基础件从 `src/tui/render/render.ts` re-export。

## 2. 现状：async jobs widget（常驻面板）

- `renderWidget(ctx, jobs)`（`src/tui/render/widget-render.ts:99`）→ `ctx.ui.setWidget(WIDGET_KEY, buildWidgetComponent(jobs, expanded))`（:106）；`WIDGET_KEY = "subagent-async"`（constants.ts:37）；空列表时 `setWidget(WIDGET_KEY, undefined)` 清除（:102）
- 渲染为 Container + Text 行（widget-render.ts:13-25），自适应宽度/高度（`fitAdaptiveWidgetLines`）
- 刷新驱动：**async-job-tracker 的 250ms poller**（tracker.ts:49）——每个 tick 重读 status.json 更新 job，`widgetRenderKey(job)` 变化才 `rerenderWidget(ctx)` + `requestRender()`（tracker.ts:27-30）。另有 `pi.on("tool_result")`（index.ts:203）在 tool 结果后补一次渲染
- 数据：`state.asyncJobs` 内存 Map（见 run-registry.md）

## 3. 现状：ctx.ui.custom 的三处使用（overlay 模态）

全部是 chain-clarify 预览/编辑界面，**是本功能最直接的可复用范式**：

1. `src/runs/foreground/executor/single-path.ts:80` — single clarify
2. `src/runs/foreground/executor/parallel-path.ts:106` — parallel clarify
3. `src/runs/foreground/chain-execution/execute-chain.ts:160` — chain clarify

统一形态：
```ts
const result = await ctx.ui.custom<ChainClarifyResult>(
  (tui, theme, _kb, done) => new ChainClarifyComponent(tui, theme, ..., done),
  { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
);
```

`ChainClarifyComponent`（`src/runs/foreground/chain-clarify/chain-clarify-component.ts:43`）实现了完整交互范式值得借鉴：多视图切换（chain/parallel/single 模式 + model/skill/thinking 选择器）、文本编辑器（`text-editor.ts` 的 `TextEditorState`）、`matchesKey` 键位处理（pi-tui）、`done(result)` 返回 Promise 结果、notice timer、dispose 清理。**steer 视图基本可以是它的结构翻版：transcript 滚动区 + 输入编辑区 + run/step 选择器。**

## 4. extension/index.ts 注册清单

`src/extension/index.ts` `registerSubagentExtension(pi)`：

- 工具：`registerSubagentTools(pi, {...})`（index.ts:158）— `subagent` + `wait` 工具（`src/extension/registration/tools.ts`）
- 消息渲染器：`registerMessageRenderers(pi)`（index.ts:154）— customType 渲染（`registration/message-renderers.ts`）
- slash 命令：`registerSlashCommands(pi, state)`（index.ts:167）→ `registration.ts:16/23/30` 注册 `/subagent-cost`、`/subagents-doctor`、`/subagents-fleet`（**fleet 命令已存在但只是文本输出**，非交互视图）；另有 execution/profile/prompt-workflow 命令族
- 事件订阅（index.ts:196-200）：`SUBAGENT_ASYNC_STARTED_EVENT → handleStarted`、`SUBAGENT_ASYNC_COMPLETE_EVENT → handleComplete`、`SUBAGENT_CONTROL_EVENT → controlEventHandler`
- pi 生命周期 hook：`tool_result`（:203，widget 刷新）、`session_start`（:250，resetSessionState + restoreActiveJobs）、`session_shutdown`（:256，全量清理 + `setWidget(WIDGET_KEY, undefined)`）
- 后台设施：result-watcher（:105）、scheduled-run manager（:128）、native supervisor channel（:104）、completion notify（:182 `registerSubagentNotify`）
- bridges：`createSubagentBridges`（:156）— slash/prompt-template/rpc 桥

**入口建议：新增 `/subagents` 或扩展 `/subagents-fleet` 命令，在 handler 里 `ctx.ui.custom(...)` 打开交互视图——与现有注册模式完全一致。**

## 5. 事件流（实时刷新的订阅源）

事件总线：`pi.events`（`IntercomEventBus`）。本功能相关通道（constants.ts:14-19）：

| 事件 | 发射点 | 载荷 | TUI 用途 |
|---|---|---|---|
| `subagent:async-started` | async-execution/single-execution.ts:217、chain-execution.ts:218 | `AsyncStartedEvent`：id/pid/sessionId/asyncDir/agents/mode/nestedRoute | run 列表新增 |
| `subagent:async-complete` | result-watcher/watcher.ts:122 | `{ id, success, asyncDir, sessionId }` | run 完成/失败 |
| `subagent:control-event` | async-job-tracker/helpers.ts:121（`emitNewControlEvents`，增量扫 events.jsonl）、foreground `emitControlNotification`（interrupt-steer.ts:16） | `{ event: ControlEvent, source, childIntercomTarget, noticeText }` | needs_attention / long_running 标记 |
| `subagent:control-intercom` | 同上（:124） | + to/message | （投递给 orchestrator，TUI 不需要） |

**没有"run 内新消息"的进程内事件**——child 的对话活动只体现在文件追加（transcript/output log/status.json）上。实时刷新的现成模式有两个：

1. **挂进现有 250ms poller**：tracker 每个 tick 已对活跃 job 做 reconcile + 状态刷新；TUI 视图可以在同一节奏 tail transcript 增量（offset 增量读，见 transcript-access.md）
2. **fs.watch + 轮询兜底**：`watchAsyncControlInbox`（control-channel/control.ts:227）已验证的跨平台模式

foreground run 的 live 活动状态在 `state.foregroundControls`（currentTool/turnCount/lastActivityAt，prepare-execution.ts:225 创建，执行中由 chain-execution 层更新），无文件源。

## 6. 已知坑 / 约束

- `ctx.ui.custom()` 是**模态**的：打开期间主 agent 输入被接管。Claude Code 式"方向键进入 subagent 视图"在 pi 里的等价物是 slash 命令或 `onTerminalInput` 全局监听（slash-run.ts:72 有先例，但会与其他输入冲突，需小心）；更稳的是命令入口
- overlay 模式 `overlayOptions` 支持函数动态尺寸（types.d.ts:120）；`onHandle` 可控制可见性
- stale context：`session_shutdown` 后旧 ctx 调用 UI 会抛，`isStaleExtensionContextError`（registration/session-paths.ts）已有判别
- extension 重载清理：globalThis 上的 `__piSubagentRuntimeCleanup` / `__piSubagentEventUnsubscribes` 模式（index.ts:57-73、:176-189），新增 watcher/timer 必须挂进同一清理链
- child 进程内 extension 不注册（`SUBAGENT_CHILD_ENV === "1"` 直接 return，index.ts:58）——TUI 代码只会在父进程跑，无需防重入

## 对本功能的启示

1. **形态**：`/subagents-fleet`（或新 `/subagents`）命令 → `ctx.ui.custom` overlay（center、width ~84-100、maxHeight 80%）→ 组件内三态：run 列表 → 单 run transcript 视图（滚动 + tail）→ 底部输入行（steer 发送）。`ChainClarifyComponent` 是结构模板。
2. **数据流**：列表态用 `state.asyncJobs` + `listAsyncRuns()` 合并；进入某 run 后用 asyncDir 做 (a) `requestAsyncSteer` 发消息 (b) tail `_transcript.jsonl` 做实时滚动 (c) 读 status.json 更新头部状态行。全部走文件 + 内存 Map，不需要新 IPC。
3. **刷新**：订阅 `pi.events` 的 started/complete 做列表级更新；视图内文本滚动用 transcript 文件 offset 增量读，挂在 250ms 节奏（自建 interval 或搭 tracker poller 的便车）+ `tui.requestRender()`。
4. **清理纪律**：组件 `dispose()` 里停 interval/关 watcher；全局资源挂进 `runtimeCleanup` 与 `eventUnsubscribes` 模式。
5. **键盘冲突**：`onTerminalInput` 全局监听风险高（slash-run.ts:72 已在用），优先 `ctx.ui.custom` 的组件级 `handleInput`——焦点隔离由框架保证。方向键导航在组件内自由实现。
6. **`setEditorComponent` 是备选**：若要做"方向键直接进入 steer 模式"的 Claude Code 式体验，可用 CustomEditor 子类拦截特定按键打开 steer overlay——但这是侵入性最高的路径，建议 v1 用命令入口。
