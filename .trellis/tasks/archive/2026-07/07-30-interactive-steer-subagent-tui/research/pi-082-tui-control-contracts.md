# Pi 0.82 TUI 与 child control 契约

> 本文记录本任务依赖的 Pi 0.82.1 行为。结论来自目标版本的公开类型、文档与运行时代码；实现阶段不得退回 0.74 的假设。

## 1. 版本前置条件

- 仓库当前直接/开发依赖仍是 0.74.0：`@earendil-works/pi-tui`、`pi-agent-core`、`pi-ai`、`pi-coding-agent`。
- npm 已存在四个包的 0.82.1。
- 本任务先将四个直接/开发依赖统一到精确版本 0.82.1，保留 peerDependencies 为 `*`。
- 升级必须作为独立切片运行原有 `npm run test:all`；未建立干净基线前不得实现 TUI/control 功能。

## 2. Custom UI 不是 session 附身

Pi 0.82 `InteractiveMode.showExtensionCustom()`（目标包
`dist/modes/interactive/interactive-mode.js:1912`）的实际语义：

- `overlay: true` → 调 `ui.showOverlay()`，保留主 chat/editor/runtime，只在上层捕获输入。
- 非 overlay → 只清空并替换 `editorContainer`，不是完整会话视图。
- custom 打开时保存主 editor 文本；关闭后恢复原 editor/focus。

因此：

- child chat 必须是 `overlay: true` 的 capturing overlay，并设置 `width: "100%"`、`maxHeight: "100%"`、`margin: 0`。
- 不能用非 overlay custom 冒充全屏聊天。
- `/xxx` 兼容流程必须先 `done()`，等待 `ctx.ui.custom()` Promise resolve，再调用 `ctx.ui.setEditorText(text)`；否则恢复流程可能覆盖预填文本。

## 3. Down 键入口的监听器语义

公开类型 `ExtensionUIContext` 提供：

- `onTerminalInput(handler)`（`dist/core/extensions/types.d.ts:77`）
- `getEditorText()`（同文件约 `:132`）

底层 `TUI.handleInput()` 在 focused component/editor 之前按注册顺序调用所有 input listeners：

- listener 返回 `{ consume: true }` 会立即结束分发，后续 listener 与 editor 都收不到输入。
- 非目标输入返回 `undefined` 才会完整透传。

因此 Down 只能是 convenience channel：仅在编辑器为空、存在活跃 target、本扩展无 modal 时消费；`/subagents` 是发生插件监听器竞争时的可靠入口。不能声称对其他 terminal listener “绝对无冲突”。该方案不会替换其他插件的 CustomEditor。

## 4. Child thinking 的原生语义

Pi 0.82 extension API 暴露：

- `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)`（`types.d.ts:937-939`）
- `ctx.model` / `pi.model` 可读当前模型 metadata。

类型变化：

- `@earendil-works/pi-ai`：`ThinkingLevel = minimal | low | medium | high | xhigh | max`
- `ModelThinkingLevel = off | ThinkingLevel`

内部 `AgentSession.cycleThinkingLevel()`（`dist/core/agent-session.js:1299`）会：

1. 非 reasoning model 返回 `undefined`；
2. 取当前模型的 supported levels；
3. 循环到下一档；
4. 调 `setThinkingLevel()`。

但 `cycleThinkingLevel()` / `getAvailableThinkingLevels()` 未暴露给 extension。child action handler 必须用升级后的共享 model-info/compat helper计算当前模型支持的等级，再调用公开 get/set，并以再次读取到的实际等级作为回执。不得硬编码包含无效 `off`/`max` 的固定数组。

## 5. Control action 必须与 steer 隔离

现有 `consumeSteerRequestsFromDir()` 会读取后删除 JSON，即使内容不能解析为 steer。把 action 与 steer 混在 `steer-targets/<index>` 会造成 action 静默丢失。

新协议使用：

```text
control/action-targets/<index>/requests/
control/action-targets/<index>/responses/
```

- request/response 都有 version、type、id/requestId、ts、action，并严格校验。
- 写入使用 `writeAtomicJson`。
- child 在应用非幂等 `cycleThinking` 前 claim/remove request；每个合法请求最终写 applied 或 rejected response。
- response outbox 是 UI 确认动作生效的权威来源；transcript/control notice 仅作审计。
- async parent 可直接写目标 step inbox；pending child 启动时会消费，无需 runner 再路由一跳。

## 6. Foreground live routing 与 transcript

- foreground spawn 的真实接线点是 `src/runs/foreground/execution/run-single-attempt.ts` 的 `buildPiArgs(...)`，不是 `single-attempt-process.ts`。
- active foreground routing 不能依赖完成后才写入的 `foregroundRuns`；`foregroundControls`（或等价 live child map）必须记录 child index、agent、control root、live transcript path。
- control root 使用 deterministic runtime path：`<TEMP_ROOT_DIR>/foreground-subagent-runs/<runId>/control/`，不能依赖可关闭的 artifactsDir。

现有 structured child transcript 只在 artifact transcript 启用时创建，并记录 finalized message/tool events，不记录 assistant token delta。为满足所有合法配置下的实时视图：

- active child 始终创建 live structured transcript；
- 若用户启用持久 transcript，复用 artifact path；
- 否则写到受控临时 live-view path，并在 run/session cleanup 删除；
- AC3 的约 1 秒刷新针对 finalized user/assistant/tool 事件，不承诺 token-by-token 打字机流。

## 7. 对本功能的约束总结

1. 主 session 永不 switch/new；全屏体验来自 capturing overlay。
2. slash 命令先关闭 overlay，再回填主 editor。
3. Down 严格 gate；slash 是可靠 fallback。
4. steer 与 action 使用不同目录和确认语义。
5. thinking action 必须返回 child 实际等级或拒绝原因。
6. foreground active metadata 与 live transcript 必须在 child spawn 前可发现。
7. Pi 0.82 升级基线与功能实现必须可独立回滚。
