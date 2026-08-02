# Subagent view fully matches main agent view: host editor reuse, streaming render, key routing

## Goal

修复 07-31 / 08-01 两个任务遗留的三个问题，使 `/subagents` 打开的 subagent 对话页面在主 agent（宿主）页面在**功能与外观上几乎没有任何区别**：

1. subagent 界面没有流式显示 agent 结果（孩子端 token/工具输出到达时界面不刷新，要等用户按键或结束才一次性出现）。
2. 快捷键不可用（子代理模式下 app 级快捷键——模型切换/思考循环/中断/展开等——没有按主 agent 同一套规则生效）。
3. 界面使用自写的编辑器而非主 agent 的文本编辑框。用户明确不想要自绘输入框；主 agent 编辑器的 slash 命令自动补全、外部编辑器、状态栏，以及 open-tui 等插件对它的自定义，都必须在 subagent 页面原样生效。

## Background / Confirmed Facts（核查于 2026-08-03）

### 运行时与代码事实

- 用户实际运行扩展 = 本仓库 HEAD（`~/.pi/agent/git/github.com/Snowy117/pi-subagents` 与 workspace HEAD 均为 `e10e78d`），非旧版本。
- 运行时 pi 0.83.0（`pi --version`；settings `lastChangelogVersion: "0.83.0"`），`node_modules` 编译目标 0.83.0 与运行时一致。
- 用户环境：`~/.pi/agent/settings.json` 有自定义 `keybindings.json`：
  `leaderKey: "ctrl+x"`，`app.tools.expand: "leader+o"`，`app.model.select: "leader+m"`，
  `app.thinking.toggle: "leader+t"` 等。
- **leader 组合键由插件实现**（用户确认）：`~/.pi/agent/extensions/leader-key/index.ts`（本地扩展，非 packages 列表）。机制：
  1. 一次性 monkey-patch `KeybindingsManager.prototype.matches`：凡 `leader+<key>` 形式的键，仅在插件内部 `state.pending`（leader 已按下）且当前 data 匹配 target 时返回 true；否则（含裸键按下）一律返回 false；
  2. `ctx.ui.onTerminalInput` 监听器在 TUI inputListeners 中 consume leader 键本身（进入 pending，footer 显示提示），下一键若可解析为 leader 绑定则放行（由编辑器内被 patch 的 `matches` 命中），否则取消 pending 并把 escape consume、其他键放行；
  3. 因为所有按键消费方（编辑器、CustomEditor、本扩展的 keyRoute）都经同一原型链上的 `matches`，patch 一处覆盖全部。**结论：主 agent 打字 `m/o/t` 不会误触模型选择/展开/思考切换，且 leader 序列可正常使用**；0.83.0 自身 dist 无 leader 代码（`rg "leader" dist/` 无命中），但运行时行为以插件为准。
- `~/.pi/agent/extensions/subagent/` 只有 config.json，无代码（真正的包在 `~/.pi/agent/git/...`）。

### 问题 1 根因：无流式渲染（确凿）

- widget 路径：`src/tui/steer-view/host-editor-mode.ts` 的 `onRpcLine()` 只 `assembler.addRpcLine(line)`，**从不触发任何重渲染**。
- `lastCtx.ui.requestRender?.()` 是 no-op：`ExtensionUIContext`（`dist/core/extensions/types.d.ts`）**没有 `requestRender` 成员**；`interactive-mode.js` 的 `createExtensionUIContext()` 返回对象中无 `requestRender`（主 agent 内部用的是 TUI 实例自己的 `requestRender`）。
- 但 widget 工厂收到的 `tui: TUI`（`@earendil-works/pi-tui`）**有公开 `requestRender(force?)`**（`tui.d.ts:212`，自带 ~16ms 节流 + `renderRequested` 合并），且 `Container.render()` 无缓存、`AssistantMessageComponent.updateContent()` 每次全量重建内容（主 agent 即此机制 + 每次更新调 `requestRender`）。
- `SteerViewComponent`（overlay 退化表面）每 250ms 轮询 transcript 并调 `tui.requestRender()`，但它轮询的是 transcript 文件——`writeMessage` 整块写完整消息，因此孩子端完成前界面不动，仍"无流式"。
- 结论：widget 模式 + 子代理 RPC 流（`message_update` / `tool_execution_update` 等逐条到达）→ 缺少 `tui.requestRender()` 触发，界面静止。这是问题 1 的直接根因。

### 问题 2 根因：快捷键路由（部分确凿 + 环境叠加）

- 机制本身存在：`src/tui/steer-view/child-key-route.ts` 经 `registration.ts` 注册到 `ctx.ui.onTerminalInput()` → `TUI.addInputListener()`，`{ consume: true }` 时 TUI 不再把按键交给焦点编辑器（`tui.js handleInput` 确认）。
- `child-keybindings.ts` 现为手写合并默认键 + `<agentDir>/keybindings.json`（含 legacy 迁移），用 `matchesKey`。主 agent 侧：`app.*` 默认表在 pi 内部 `KeybindingsManager`（pi-tui 运行时类 + 用户 keybindings.json，`dist/core/keybindings.js`；package root 仅 type 导出、exports 封死 deep import），全局实例 `getKeybindings()`（`@earendil-works/pi-tui`）运行时可用。手写方案语义接近但**遗漏 leader patch 与可能的行为漂移**，需替换。
- **致命叠加 bug（当前实现）**：`child-keybindings.ts` 手写 `matchesKey(data, "leader+m")` 会把 `"leader+m"` 解析为裸键 `m`，**不走 leader-key 插件的 patch**——在 host-editor 模式下打字 `m`/`o`/`t` 会被当成 `model.select`/`tools.expand`/`thinking.toggle` 吞掉，与主 agent（受插件保护）行为**不一致**。修复必须让子代理侧按键解析与主 agent 走**同一个匹配函数**：`@earendil-works/pi-tui` 的全局 `getKeybindings()` 单例（其 `matches` 已被 leader-key 插件 patch；默认表 + 用户 keybindings.json + legacy 迁移 + leader 状态全部由其承载）。
- **最主要体验缺口**：当用户落在 overlay 退化表面（见问题 3）时，任何 app 级快捷键都无效（`SteerViewComponent.handleInput` 只处理 esc/ctrl+c/shift+tab/tab/pgup/pgdown），且此时 `hostEditorConversation.active === false` → keyRoute 不拦截。
- 结论：要让"快捷键可用"，必须（a）让用户尽可能进入 host-editor 模式（问题 3 修复），（b）keyRoute 的按键解析与主 agent 严格对齐（同一份 keybindings.json、同一个 KeybindingsManager 语义）。

### 问题 3 根因：自绘编辑器的出现条件

- host-editor 模式（editor 一直保持挂载，widget 显示会话，`pi.on("input")` 路由普通提交）**即是"复用主 agent 编辑器"的正确实现**，open-tui/zentui 等对主编辑器的自定义天然继承；只有 `SteerViewComponent` 全屏 overlay 使用自绘 `new Input()`。
- overlay 出现的唯一路径：`src/tui/steer-view/open-view.ts` 的 `showChat()` 中 `resolveChildChannel(ctx, target)` 返回 undefined（或抛错被 catch）→ `hostEditor.open()` 失败 → 落入 `ctx.ui.custom(SteerViewComponent)`。
- `resolveChildChannel`（`child-channel.ts`）返回 undefined 的常见情形：
  - async 已结束（complete/failed/paused）：`waitForPidDeath(runner pid)` 5s 超时（runner 可能在 linger，最长 10min）→ undefined；
  - async 无 `sessionFile`（如 `--no-session`）；
  - foreground：无 resident 且无 `sessionFile`（例如 eviction 后）；
  - 解析抛错（读状态文件失败等）。
- 而 `view picker` 的过滤条件是 `active || resident || sessionFile`——只要 picker 显示的目标，多数能解析成功，但 Linger/竞态窗口会让一部分选择落入 overlay。
- 结论：要"永远与主 agent 一致"，自绘聊天界面（含 Input）不能出现在任何正常路径——解析失败的目标改为只读 transcript 视图（Q1=B，见 Resolved Decisions），可正常解析的目标一律进入 host-editor 聊天模式。

## Requirements

### R1 流式渲染（修复问题 1）

- host-editor 模式下 widget 必须在孩子端输出到达时即时刷新：`message_start/update/end`、`tool_execution_*`、`tool_result_end` 等 RPC 流式事件到达时触发 `tui.requestRender()`（复用 TUI 自带节流，不做自研节流）。
- 流式期间界面视觉与主 agent 一致：text/thinking 增量、toolCall 参数增量、tool result 注入等都由现有 assembler 管线完成（不回归）。
- 非激活（模式关闭/widget 移除）后不得再触发渲染（清理订阅）。

### R2 快捷键对齐（修复问题 2）

- 子代理模式下拦截的 app 级动作（interrupt、thinking.cycle、model.cycleForward/Backward、model.select、tools.expand、thinking.toggle）其**键位解析与主 agent 完全一致**：直接复用 `@earendil-works/pi-tui` 全局 `getKeybindings()` 的 `matches`（同一实例承载用户 keybindings.json + legacy 迁移 + leader-key 插件 patch），不再手写 `matchesKey` 循环。
- 拦截后把动作路由到子代理（abort / cycle_model / get_available_models+set_model / cycle_thinking_level / 本地展开/思考显隐切换），并有可见反馈（notify/status/widget 缩放）。
- Esc：仅流式中断（consume），空闲时放行给编辑器（关补全）——维持主视图语义；与 leader-key 取消（esc）互不冲突（流式时集 keyRoute 先于 leader 状态机的场景需在实现中验证顺序）。
- 编辑级按键（剪贴/历史/多行/IME/补全/行编辑/文本输入）永不拦截。
- 退出子代理模式即恢复主 agent 键语义。

### R3 编辑器复用、消灭自绘 editor（修复问题 3，核心目标）

- subagent 页面不再在任何正常路径展示自绘 `Input`；唯一输入面是真实主 agent 编辑器（host-editor 模式），其所有宿主能力（slash 补全、外部编辑器、历史、IME、状态栏、open-tui/zentui 的自定义）原样可用。
- `open-view.showChat()` 中解析失败（`resolveChildChannel` 返回 undefined 或抛错）的 target **不再进入聊天界面**：
  - 保留**只读 transcript 视图**（无输入框、可滚动、明确图标与文句提示"conversation continuity unavailable"），Esc 返回选择器（Q1=B）；
  - 连 transcript 也没有的 target：明确 notify 提示（无常驻进程/会话不可重开/无记录），并返回选择器。
- `SteerViewComponent` 移除 `new Input()` 输入面（及其 submit/tab 输入焦点/输入渲染分支），其余只读能力（transcript 轮询渲染、滚动、steer/thinking 控制、Esc 返回）保留。
- 保留 host-editor 模式的既有安全属性：父会话权威、单写入者、`pi.on("input")` 仅在子代理模式激活时返回 handled。

### R4 回归

- 既有 foreground/async 执行、steer/control、eviction、`//name` 路由、`/subagents exit`、reopen 竞态守卫不回归。
- 现有测试套件绿；新增针对 R1/R2/R3 的单元与集成断言。

## Acceptance Criteria

- [ ] AC-1 流式：host-editor 模式下，孩子端 RPC 流式行到达时 widget 内容在无任何用户输入的情况下逐 token/逐工具输出刷新（用 mock TUI 断言 `requestRender` 被调用；渲染结果内容变化）。模式关闭后无残留渲染触发。
- [ ] AC-2 键位对齐：predefined 配置、用户自定义 keybindings.json（含 legacy 键名）两种情况下，子代理模式拦截的 7 个动作解析与主 agent 的 `KeybindingsManager` 一致（逐 action 键列表 + 匹配结果矩阵断言）；用户环境中 leader-key 插件的裸键不触发行为（打字 `m/o/t` 不被吞）与主 agent 一致。
- [ ] AC-3 键位路由：子代理模式下 ctrl+p（或用户映射）→ 子代理模型循环并 notify 反馈；Esc 仅在流式中断、空闲放行；退出模式恢复主 agent 语义；编辑级按键不被吞。
- [ ] AC-4 编辑器一致：`/subagents` 选择可对话 target 后编辑器保持为真实主 agent 编辑器（open-tui/zentui 自定义、slash 补全、外部编辑器可用性由 host-editor 机制保证），页面上不再出现自绘 Input。
- [ ] AC-5 会话解析失败路径：无法解析 channel 的 target 不进入聊天界面，改为只读 transcript 视图（无输入框、明确提示、可滚动，Esc 返回选择器）；无 transcript 的 target 则 notify 提示并停留/返回选择器。
- [ ] AC-6 回归：`npm run test:unit`、`npm run test:integration`、e2e 全绿；既有 steer/control/eviction/`//name` 测试通过；手动 smoke：foreground 子代理 + async 运行中 + async 已结束 三者均进入 host-editor 模式并流式显示。

## Out of Scope

- 复刻主 agent 的每一个交互面（fleet 视图、会话树、记忆/回退 UI、模型选择器逐字节等同）——只对齐"对话 + 操作"表面。
- 让 subagent 页面成为真正的父子会话 tab 切换（编译/运行时私有 API 不支持）。
- 为 pi 0.83.0 实现 leader 组合键支持（pi 上游缺失，保持与主 agent 一致即可）。
- 修改 `../pi-dcp-migrate` 或其他第三方插件。

## Resolved Decisions

- Q1（用户定夺 2026-08-03，选 **B**）：无法建立对话通道（解析失败）的 target **保留只读 transcript 查看视图**（无输入框、可滚动、明确提示续谈不可用），Esc 返回选择器；不再展示自绘 `Input`。可正常解析的 target 一律进入 host-editor 聊天模式。
- Q2（核查结论 2026-08-03）：子代理模式快捷键解析**复用全局 `getKeybindings()`**（`@earendil-works/pi-tui` 单例）的 `matches`，使 leader-key patch、用户 keybindings.json（含 legacy 迁移）与主 agent 完全共享；不再手写 `matchesKey` 循环。
- Q3（核查结论 2026-08-03）：流式刷新在 widget 工厂内保存 `tui` 引用，RPC 流式行到达时 `tui.requestRender()`，靠 TUI 自带的 ~16ms 节流与 `renderRequested` 合并；不做自研节流。

## Open Questions

- 无阻塞。