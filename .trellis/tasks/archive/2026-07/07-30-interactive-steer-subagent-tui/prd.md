# TUI 内交互式 steer subagent（进入 subagent 对话视图并直接指导）

## Goal

让用户在 pi TUI 中无需通过主 agent 中转，即可直接查看运行中 subagent 的完整对话、并向其发送 steer 消息与控制动作（如切换思考强度）——类似 Claude Code 按下方向键进入 subagent 聊天的体验，且视图观感与主 agent 对话几乎一致。

## Background / Confirmed Facts

调研结论（详见 `research/` 五篇文档）：

- **Run 枚举可行**：`state.asyncJobs`（内存 tracker）、`state.foregroundRuns`、文件系统 `listAsyncRuns()`；`resolveSubagentRunId` 三态解析。
- **Steer 投递一行调用**：`requestAsyncSteer(asyncDir, { message })`（`src/runs/background/control-channel/control.ts:74`），文件信箱机制，纯同步写 JSON。链路：parent 文件 → runner watcher → child 信箱 → `pi.sendUserMessage(msg, { deliverAs: "steer" })`。
- **Transcript 实时数据源**：`src/shared/child-transcript.ts:76` 的 append-only JSONL 天然适合 byte-offset 增量读取；当前 foreground/async 只在 transcript artifact 启用时创建，因此本功能还需为所有 active child 保证一份 structured live transcript（持久 artifact 关闭时使用临时 runtime path）。
- **UI 范式**：`ctx.ui.custom()` overlay 已有三处 chain-clarify 先例（`ChainClarifyComponent` 多视图/编辑器/键位处理）；pi 支持 `ctx.ui.onTerminalInput()` 消费原始按键、`matchesKey(Key.down)` 等，且无需替换其他插件的 CustomEditor。Pi 0.82 中非 overlay custom 只替换 editor 区，因此全屏体验需用铺满终端的 capturing overlay。
- **Foreground steer 缺口**：foreground run 当前不可 steer（`action-dispatch.ts:133` 显式拒绝；spawn 不传 `PI_SUBAGENT_STEER_INBOX`），child 侧机制已就绪，补齐只需 spawn 接线（`pi-args.ts:251` 已支持 `steerInboxDir` 参数）。
- steer 投递无回执，需通过 transcript 中出现该消息确认送达；实时刷新靠文件 tail 轮询（无进程内事件推送）。
- **Session 附身不可行**（已验证并否决）：mid-turn 不可 `ctx.switchSession`（会 teardown 主 runtime）、pi 无 session 文件 live-tail、双写者有损坏风险。
- **Child 侧可编程**：child 是无头 pi 进程，但我们的扩展代码在其中运行且持有 `pi` 对象（`registerSteeringInbox` 先例，`runtime-registration.ts:55`），可调用 `pi.setThinkingLevel()` 等原生 API。
- **Pi 版本**：本任务先将 `@earendil-works/pi-{tui,agent-core,ai,coding-agent}` 的开发/直接依赖统一升级到 0.82.1；peerDependencies 继续兼容宿主。升级作为独立前置切片验证和回滚。

## Requirements

### R1 入口双通道
- slash 命令（可靠基线）+ `ctx.ui.onTerminalInput()` 拦截 Down 键（仅编辑器为空、有可选 run、当前未打开 modal 时触发；可配置开关默认开）；两者进入同一个 picker → 对话视图组件。
- picker 可列出活跃 runs 并切换查看对象（picker 中心导航）。

### R2 对话视图
- 铺满终端的 capturing overlay（上方滚动对话区 + 底部输入框），Esc 返回主对话/picker；picker 用居中小 overlay。
- 渲染复用 pi 原生原语（Markdown 组件、theme 色系、消息布局），视觉上与主 agent 对话几乎一致。
- 实时更新：tail child transcript JSONL（byte-offset 增量读），child 崩溃时以 status.json 状态兜底显示。
- 所有 active selectable child 都必须有 structured live transcript：持久 transcript 开启时复用 artifact path；关闭时写到受控临时 runtime path，并在 child 终态且无视图持有或 session cleanup 后删除。实时范围为 finalized user/assistant/tool 事件，不承诺 token-by-token 打字机流。

### R3 Steer 消息（foreground + async）
- async run 走现有 `requestAsyncSteer`；foreground run 需在 spawn 时补接 `PI_SUBAGENT_STEER_INBOX`（child 侧机制已就绪，零改动）。
- 输入框回车 → 写入控制信箱；UI 提示「已排队，下个 turn 生效」；通过 transcript 出现该消息确认送达。

### R4 通用控制转发协议
- child 通过控制信箱暴露语义化「动作 API」：信封 `{ action, payload }`，可扩展，传输层与动作解耦。
- 父进程 TUI 把手势映射为语义动作转发给 child，child 侧翻译为原生调用。
- MVP 动作集：**发送消息**（现有 steer 复用）+ **切换思考强度**（shift+tab → child `pi.setThinkingLevel()`）。
- action 使用独立 request inbox + response outbox；每个请求按 id 得到 applied/rejected 回执（含实际 thinking level），而不是依赖普通 transcript 文本猜测。
- 显式不做（follow-up 候选）：切换模型、中断/暂停 foreground、slash 命令转发给 child（pi 无编程执行命令 API，blocked）。

### R5 主 session 与插件生态兼容
- 主 session 完全不动：视图期间其他插件的 widget/status/状态原样保留，主 agent 继续工作。
- slash 命令兼容：视图输入框中输入 `/` 前缀时，退出视图并预填到主编辑器（`ctx.ui.setEditorText`），交给 pi 原生命令系统——其他插件注入的命令因此可用。
- 不做 session 附身。

## Acceptance Criteria

- [ ] AC1：通过 slash 命令和（编辑器为空时）Down 键均可打开活跃 subagent 的 picker；无活跃 run 时有明确提示。
- [ ] AC2：选中 run 后进入铺满终端的对话 overlay，渲染该 child 的历史对话（user/assistant/tool 事件），观感与主对话一致（Markdown/主题）。
- [ ] AC3：视图打开期间，child 产生的新消息在约 1s 内自动出现在视图中。
- [ ] AC4：在视图输入框输入文本并回车，该消息作为 steer 送达 child（async 与 foreground run 均可），child 的 transcript 中随后出现该消息。
- [ ] AC5：在视图中按 shift+tab，child 进程的思考强度循环切换；UI 在约 1s 内显示 child 返回的实际等级或明确拒绝原因。
- [ ] AC6：视图期间主 session 的 widget/status/其他插件状态不受影响；Esc 返回后主对话状态完整。
- [ ] AC7：视图输入框输入 `/xxx` 回车 → 退出视图，主编辑器预填 `/xxx`。
- [ ] AC8：现有测试套件全绿；新增 foreground steer 接线和控制协议有对应测试。
- [ ] AC9：依赖升级到 Pi 0.82.1 后，升级前既有测试套件先独立全绿，再开始功能实现。

## Out of Scope

- Session 附身（pi 架构不支持，已否决）。
- 切换模型转发、foreground interrupt、child 侧 slash 命令执行（见 R4 follow-up 候选）。
- 跨机器/跨进程的 subagent 控制（仅本机同 extension 进程）。

## Open Questions

（无阻塞性问题；键位细节、命令命名等在 design.md 中决定）
