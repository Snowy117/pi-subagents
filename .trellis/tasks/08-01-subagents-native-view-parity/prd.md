# Subagents native view parity: host editor + host rendering

## Goal

用户在 `/subagents` 里选中一个子代理后，对话视图在功能与外观上与主 agent 视图几乎
没有任何区别：用真实的主机编辑器输入（宿主自动补全、历史、多行、粘贴、IME、Zentui
等包装全部生效），子代理会话用与主视图相同的消息/工具渲染管线呈现（markdown、
thinking、工具卡片、图像、展开/折叠、`pi-tool-display`/`pi-zentui` 的既有外观效果
自然继承），父会话完全不受干扰。用户无需感知"这是一个插件自绘的聊天界面"。

## Background / Confirmed Facts（核查于 2026-08-01）

### 运行时与编译目标不一致

- 本机实际运行的 pi 是 **0.83.0**（`pi --version`；`~/.pi/agent/settings.json`
  `lastChangelogVersion: "0.83.0"`）。
- 仓库锁定的编译目标仍是 **0.82.1**
  （`node_modules/@earendil-works/pi-coding-agent/package.json` version 0.82.1）。
- 旧任务的可行性研究全部基于 0.82.1；0.83.0 相比 0.82.1 的扩展 API 面几乎无变化
  （`dist/core/extensions/types.d.ts` 仅新增 `scopedModels`/`model_select`；
  `interactive-mode.js` 差异仅 38 行，无渲染/编辑器/widget 相关变化）。
- 结论：**0.83.0 仍未公开**：消息/条目渲染器查找（`getMessageRenderer` 仅存在于
  私有 `ExtensionRunner`）、有效工具定义枚举、存活编辑器实例、会话渲染管线。但
  `ExtensionUIContext.getToolsExpanded()/setToolsExpanded()` 在 0.83.0 公开。

### 当前实现与差距

- **前景子代理**（Option B 持久 RPC 进程）：`host-editor-mode.ts` 已经做到——真实
  Pi 编辑器保持挂载聚焦，`pi.on("input")` 把普通文本/`//cmd` 路由到子代理并返回
  `{action:"handled"}`，上方 widget strip 显示子代理会话，退出/切换都有命令。
- **async 子代理完全拿不到宿主编辑器**：`src/extension/index.ts` 的
  `getResidentChild` 对 `kind !== "foreground"` 直接 `return undefined`
  （注释自认 "Async children ... resolved via a cross-process bridge (Phase 5),
  not here"）。选中 async 子代理永远退回 `SteerViewComponent` 全屏捕获式 overlay：
  自带 `Input` 文本框 + 自绘 Markdown/Text 渲染、工具行降级为 `▶ tool`/`✓ tool`
  字符串。
- **渲染管线未复用（R3/AC4 未达成）**：即使 host-editor 模式激活，widget 也是把
  记录压成纯文本行用 `theme.fg` 上色（`host-editor-mode.ts` 的 `widgetLines` +
  `recordText()`），没有走 `UserMessageComponent`/`AssistantMessageComponent`/
  `ToolExecutionComponent` 等导出的原生组件；也没有配对 toolCall↔toolResult、没有
  thinking/图片/展开状态、不感知 `pi-tool-display`/`pi-zentui` 的 prototype 补丁。
- **async 子代理结束后也无法续谈**：runner 进程在 run 结束时
  `persistentChildRegistry.closeAll("graceful")` 关闭所有常驻子进程
  （`run-subagent.ts` 尾部）；父进程对 async 子进程既无进程句柄也无 stdin/stdout。
  续谈需要 session reopen（reopen-bridge 已存在，可复用）。

### 现有可复用资产

- 导出的原生组件（0.82.1 与 0.83.0 均导出）：`UserMessageComponent`、
  `AssistantMessageComponent`、`CustomMessageComponent`、`ToolExecutionComponent`、
  `BashExecutionComponent`、`SkillInvocationMessageComponent`（package root）。
- `pi.on("input")` → `{action:"handled"|"continue"}`；`!bash` 与单 `/` 归父进程。
- `ctx.ui.setWidget(key, componentFactory | undefined)`：组件工厂形态可渲染任意高度，
  位于编辑器上方（`WidgetPlacement` 默认 "aboveEditor"）。
- TUI 渲染为底部锚定视口（`viewportTop = max(0, lines.length - rows)`），非聚焦组件不
  收键盘事件；主视图本身也没有内部滚动，长会话靠终端 scrollback。
- `getToolsExpanded()`（0.83.0 公开）可同步工具展开状态。
- child-transcript 记录里携带**完整 Message 对象**
  （`writeMessage` 写入 `message: { role, content, ... }`，含 toolCall 块、
  stopReason、errorMessage；`tool_result_end` 同样落完整消息）。
- RPC stdout 事件流（`message_start`/`message_update`/`message_end`/
  `tool_execution_*`/`tool_result_end`）即完整消息来源，前台 viewer 已在监听。
- 设置项（hideThinkingBlock、outputPad、showImages、imageWidthCells、
  hiddenThinkingLabel、markdown theme）存在 `settings.json`（父进程可直接读取，
  与 tool-display/zentui 一致的做法）；`getToolsExpanded()` 为公开 API。
- 私有但稳定可观察的 prototype 补丁链：
  `pi-tool-display` 补丁 `UserMessageComponent.prototype`；
  `pi-zentui` 补丁 `UserMessageComponent.prototype.render/invalidate` 并包裹前者；
  同 realm 复用的原生组件可自然继承该补丁链（机会性，非 API 承诺）。
- reopen-bridge（`--session` 重开已逐出的 settled 子代理，registry 防双写）。
- config 键 `subagents.persistentChildren`、`subagents.eviction.*` 已存在。

### Forward-looking boundaries（沿用旧任务可信结论）

- 不上 `switchSession()`/`newSession()`：会拆除/重启父运行时与子代理编排器。
- 父进程绝不 `SessionManager.open` 子会话文件：可能触发迁移重写造成双写。
- 不做私有导入/反射进 `InteractiveMode` 私有字段（跨版本脆弱）。
- 渲染器查找、有效工具定义枚举仍属私有→原生组件 + 显式 generic 回退 + 机会性
  prototype 补丁继承；不承诺"逐字节等于主视图的工具渲染"。

## Requirements

### R0 统一会话通道（sync/async 差异最小化）

- 视图层只面对一个统一抽象 `ChildConversationChannel`（`write(record)` +
  `onStdoutLine(cb)` + `settled` + `closed` + `close()`）：
  - 前景子代理 = 本地 RPC 子进程（Existing `PersistentRpcChild`，包一层）；
  - async 子代理（运行中）= runner 侧对话代理桥（请求 inbox + stdout 中继），
    通道形态与前景一致；
  - async 子代理（已结束、runner 已释放）= `--session` reopen（LocalRPC）。
- 视图层、原生组装器、输入路由对前景/async 不做分支（或只做最小分支），后端
  差异收敛到 `resolveChildChannel(target)` 一个函数。
- 通道死亡透明重解析：会话中通道关闭（runner 退出/进程死亡）时，若目标可重
  解析（如 reopen），无缝切换通道并保留已累积会话；否则按现有逻辑自动退出。

### R1 宿主编辑器输入（全子代理类型）

- 前景子代理：保持现有 host-editor 路由模式（已实现，本任务回归验证）。
- async 子代理：`/subagents` 选中 async 子代理后同样进入 host-editor 路由模式——
  真实主机编辑器保持挂载聚焦，普通提交路由到该子代理，父会话零扰动。
- 支持 async 子代理的（a）运行中、（b）已结束两种时机的会话接入（见 R5）。
- 既有行为保留：`//name` 走子代理命令；单 `/`、`!bash` 归父进程；
  `/subagents exit|close` 退出；Editor 文本与焦点不变。

### R1b 子代理模式下的 agent 级按键路由（Q5=A）

- 子代理模式激活时，拦截映射到 app 级操作的按键并路由到子代理（通过通道
  RPC/bridge）：
  - interrupt → child RPC `abort`（仅子代理流式时；空闲时放行、维持主视图
    "关补全"的 Escape 行为）；
  - model.cycleForward/Backward → `cycle_model` / `get_available_models` +
    `set_model(prev)`；model.select → `get_available_models` + `ctx.ui.select`
    列表 + `set_model`；
  - thinking.cycle → `cycle_thinking_level`；
  - tools.expand → 子视图展开状态本地切换（重渲染重应用）；
  - thinking.toggle → 子视图 hideThinkingBlock 本地切换。
- 键位解析不硬编码：默认键位来自公开文档表（interrupt=escape、thinking.cycle=
  shift+tab、model.cycleForward=ctrl+p、model.cycleBackward=shift+ctrl+p、
  model.select=ctrl+l、tools.expand=ctrl+o、thinking.toggle=ctrl+t），合并
  `<agentDir>/keybindings.json` 用户重映射（含 legacy 名迁移），逐 action 取
  有效键列表匹配；`app.interrupt` 等类在键位为空（用户移除）时静默不拦截。
- 拦截仅在子代理模式激活时注册；退出即恢复主 agent 语义——子代理会话中用户
  无法通过这些键对主 agent abort/cycle/show thinking（设计预期，需说明）。
- 编辑级按键（剪贴/历史/多行/IME/补全/行编辑）永不拦截，仍由真实编辑器处理。

### R2 外观：原生渲染管线

- 子代理会话呈现（widget 表面）用导出的原生组件组装，等价于主视图
  `renderSessionItems`/`addMessageToChat` 的角色选择：
  - user → `UserMessageComponent`（继承同 realm 的 tool-display/zentui 补丁链）；
  - assistant → `AssistantMessageComponent` + 抽取 `content[].toolCall` →
    `ToolExecutionComponent`，按 `toolCallId` 与后续 `toolResult` 消息配对更新；
  - `toolResult` → 更新已配对的工具组件（含 isError/details/图片内容）；
  - custom 消息 → `CustomMessageComponent`；渲染器查找私有→本扩展可解析的
    customType 走本扩展注册的渲染器，未知类型走显式 generic 回退；
  - bashExecution → `BashExecutionComponent`；
  - 其余/异常/truncated → 现有有界 Markdown/Text 回退，并明确标注。
- 设置感知：hideThinkingBlock、hiddenThinkingLabel、outputPad、showImages/
  imageWidthCells、markdown theme、toolOutputExpanded（走公开
  `getToolsExpanded()`）与主视图一致（读取 settings.json + 公开 API）。
- 会话消息数据保真：历史（transcript 记录含完整 Message）+ 实时（RPC stdout 事件
  流）双源，统一进字节级保真的 viewer 侧会话组装器。

### R3 全屏观感

- host-editor 模式下 widget 应占据聊天区高度（上限 = 视口高度 − 头部 − 编辑器 −
  状态/页脚 − 安全边距），视觉上"聊天区就是子代理会话"，父会话被推入终端
  scrollback（与主视图"长会话滚入 scrollback"行为一致）；退出后布局恢复原样。
- 子代理模式激活时有明确的模式指示（现有 status 行保留/增强），退出路径明确。

### R4 父会话安全（沿用，回归验证）

- 父会话权威地位不变；widget 挂载/移除不动父编辑器、其它扩展 widget、status、
  父会话内容。`input` handler 仅在子代理模式激活时返回 `handled`。
- 不产生第二个会话文件 writer；reopen 由 registry 守卫。

### R5 async 子代理接入策略

- 已结束（run 状态 complete/failed/paused 且 runner 已释放子进程）：
  session reopen 路径（复用 reopen-bridge），进入 host-editor 模式。防御 runner
  尚未退出的竞态（不得双写会话文件）。
- 运行中：runner 侧对话代理桥（Q1=B，见 R0/design）——请求 inbox 转发 prompt/
  get_commands，stdout 镜像中继回父进程，实时对话；仅不可达时保留现有文件
  inbox steer + 只读 transcript。
- `--no-session` 或无可 reopen 会话：明确提示"conversation continuity
  unavailable"，退化到只读 transcript/steer，不承诺宿主编辑器。

### R6 自定义 overlay 的处置

- `SteerViewComponent` 全屏 overlay（自定义 Input + 自绘渲染）不再是任何正常路径的
  主表面；仅在"连续会话不可用"（无 resident、无 session 可 reopen）时作为明确标注的
  退化表面，且其渲染换用与 R2 相同的原生组装器（消除自绘外观）。

### R7 回归与兼容

- 既有 foreground/async 执行、steer/control、eviction、`//name` 路由、检测不回归。
- 配置兼容：`subagents.*` 既有键不变；如需新键，缺省保持现有行为。
- 完整测试套件通过；渲染/路由新增聚焦单测与集成测试。

## Acceptance Criteria

- [ ] AC1 前景子代理 host-editor 模式完整回归（输入路由矩阵、退出/切换、父会话零
      扰动、child 进程死亡自动退出）。
- [ ] AC2 已结束的 async 子代理：`/subagents` 选中后进入 host-editor 模式（真实
      编辑器挂载聚焦），普通提交直达该子代理；run 过程中无第二 writer 竞态。
- [ ] AC3 widget/退化表面渲染：user/assistant/toolCall/toolResult/custom/
      bashExecution 六类消息与主视图同组件呈现；toolCall↔toolResult 按 id 配对；
      thinking/图片/展开状态遵守设置；未知 customType 有显式 generic 回退。
- [ ] AC4 全屏观感：widget 占据聊天区高度，父会话滚入 scrollback 且退出后完整恢复；
      模式指示与退出命令清晰。
- [ ] AC5 视觉继承：同 realm 原生组件上 tool-display/zentui prototype 补丁生效
      （机会性验证，不承诺）。
- [ ] AC6 退化路径清晰：无 resident/无 session 时明确提示，渲染不退回自绘外观。
- [ ] AC7 既有测试全绿（unit/integration/e2e），新增覆盖：async reopen 接线、
      native 组装器、输入路由矩阵、渲染回退分支。
- [ ] AC8 编译目标与运行时对齐（0.83.0），`getToolsExpanded()` 等新公开 API 被
      使用，类型检查通过。
- [ ] AC9 async 运行中：`/subagents` 选中运行中的 async 子代理后进入 host-editor
      模式，普通提交经 runner 对话桥直达该子代理（提示实时反馈）；并行/链式多
      步时 target 切换路由正确；runner 退出后通道无缝重解析（reopen）或明确提示。
- [ ] AC10 async 与 sync 差异最小化：视图层/组装器/输入路由无异步分支；唯一差异
      收敛在 `resolveChildChannel`；既有 async 执行/steer/control 不回归。
- [ ] AC11 键位路由：即使配了自定义 keybindings.json，子代理模式下 app 级按键
      （interrupt/thinking.cycle/model.cycleForward/Backward/model.select/
      tools.expand/thinking.toggle + 用户重映射）拦截并路由到子代理且效果正确
      （abort/模型循环与选择/思考循环/展开/思考显隐）；退出后恢复主 agent
      语义；编辑级按键不受影响。

## Out of Scope

- 复用私有渲染器注册表/工具定义枚举；反射进 InteractiveMode 私有字段。
- `switchSession()`/`SessionManager.open` 子会话。
- 任意第三方插件私有补丁的原生承诺兼容。
- 修改 `../pi-dcp-migrate`。
- 逐一复刻主视图每个交互（fleet 视图、记忆/回退 UI、逐字节等同的模型选择器
  等）——只对齐"对话+操作"表面。
- 子代理模式下对主 agent 的 app 级按键操作（abort/cycle/show thinking）——
  拦截期间不可用（Q5=A 的设计预期）。

## Open Questions

- Q1（已决 2026-08-01）：async 子代理**运行中**实时 prompt 对话需要实现。
  选方案 B：runner 侧对话代理桥（请求 inbox + stdout 中继 + 生命周期/心跳），
  与前景语义一致；同时最小化 async/sync 差异，必要处重构。
- Q2（已决 2026-08-01）：子代理模式激活时接受父会话被推入 scrollback；widget
  占满可用聊天区高度，视觉上"聊天区就是子代理会话"；退出后布局完整恢复。
  模式指示仅需 status bar 提示（现状即有 `subagent: <agent> · …`，保留/增强）。
- Q3（已决 2026-08-01）：run 结束后若对话桥仍活跃（心跳 TTL 兜底），runner
  延迟退出，保持被对话的 settled 子进程常驻；心跳过期/用户退出/父会话 shutdown
  才 closeAll 退出。与前景"settled stay resident"语义一致，续谈零断层。
- Q4（已决 2026-08-01）：设置保真读全局 `<agentDir>/settings.json` + 项目
  `<cwd>/.pi/settings.json` 深合并（项目覆盖全局）+ 公开 `getToolsExpanded()`；
  与 tool-display/zentui 一致做法；hiddenThinkingLabel 默认 "Thinking..."（
  尽力观察扩展写入，不承诺）+ UI 设置变更在下次渲染重新读取。
- Q5（已决 2026-08-01）：子代理模式拦截并转发 app 级按键到子代理（Esc abort、
  模型循环/选择、思考循环、展开/思考显隐），键位解析遵循用户 keybindings.json
  重映射（不硬编码）；拦截期间主 agent 无法通过这些键操作（设计预期）。